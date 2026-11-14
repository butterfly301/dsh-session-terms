import test from 'node:test';
import assert from 'node:assert/strict';
import { createTermsStore, createTermsRegistry } from '../src/client/state.mjs';
import { changeState, emptyState } from '../src/terms.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function clock() {
  let time = 0,
    next = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, delay) {
      const id = ++next;
      timers.set(id, { fn, at: time + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const candidate = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!candidate) break;
        time = candidate[1].at;
        timers.delete(candidate[0]);
        candidate[1].fn();
      }
      time = end;
    },
    get size() {
      return timers.size;
    },
  };
}
function backend() {
  let state = changeState(emptyState(), 'create', { name: 'A', note: 'original' });
  return {
    get state() {
      return state;
    },
    change(action, payload) {
      state = changeState(state, action, payload);
    },
    async request(sessionId, action, payload) {
      try {
        if (action !== 'get') state = changeState(state, action, payload);
        return { ok: true, state: structuredClone(state) };
      } catch (error) {
        return { ok: false, code: error.code };
      }
    },
  };
}

test('stale editor version fails after load advances the library revision and preserves draft and error', async () => {
  const server = backend(),
    store = createTermsStore('session', server.request);
  await store.load();
  const term = store.getSnapshot().data.terms[0];
  const draft = { term, initialName: 'draft' };
  store.openEditor(draft);
  server.change('update', { id: term.id, name: term.name, note: 'remote' });
  await store.load();
  assert.equal(
    await store.mutate('update', {
      id: term.id,
      name: term.name,
      note: 'draft',
      expectedVersion: term.version,
    }),
    false,
  );
  assert.equal(server.state.terms[0].note, 'remote');
  assert.equal(store.getSnapshot().data.terms[0].note, 'remote');
  assert.equal(store.getSnapshot().error.code, 'conflict');
  assert.equal(store.getSnapshot().editorRequest, draft);
  assert.equal(store.getSnapshot().busy, false);
  store.dispose();
});

test('revision conflicts refresh latest state while failed refreshes retain the meaningful conflict', async () => {
  const server = backend();
  let failRefresh = false;
  const store = createTermsStore('session', (...args) =>
    args[1] === 'get' && failRefresh ? Promise.reject(Error('offline')) : server.request(...args),
  );
  await store.load();
  const term = store.getSnapshot().data.terms[0];
  store.openEditor({ term });
  server.change('create', { name: 'B' });
  assert.equal(
    await store.mutate('update', {
      id: term.id,
      name: term.name,
      note: 'draft',
      expectedVersion: term.version,
    }),
    false,
  );
  assert.equal(store.getSnapshot().data.terms.length, 2);
  assert.equal(store.getSnapshot().error.code, 'conflict');
  server.change('create', { name: 'C' });
  failRefresh = true;
  assert.equal(
    await store.mutate('update', {
      id: term.id,
      name: term.name,
      note: 'draft',
      expectedVersion: term.version,
    }),
    false,
  );
  assert.equal(store.getSnapshot().data.terms.length, 2);
  assert.equal(store.getSnapshot().error.code, 'conflict');
  assert.equal(store.getSnapshot().editorRequest.term, term);
  assert.equal(store.getSnapshot().loading, false);
  assert.equal(store.getSnapshot().busy, false);
  store.dispose();
});

test('matching original version succeeds after unrelated changes and uses latest revision', async () => {
  const server = backend();
  let sent;
  const store = createTermsStore('session', async (...args) => {
    if (args[1] === 'update') sent = args[2];
    return server.request(...args);
  });
  await store.load();
  const term = store.getSnapshot().data.terms[0];
  server.change('create', { name: 'B' });
  await store.load();
  assert.equal(
    await store.mutate('update', {
      id: term.id,
      name: term.name,
      note: 'edited',
      expectedVersion: term.version,
      expectedRevision: 0,
    }),
    true,
  );
  assert.equal(sent.expectedRevision, 2);
  assert.equal(sent.expectedVersion, 1);
  assert.equal(server.state.terms[0].note, 'edited');
  assert.equal(server.state.terms[1].name, 'B');
  store.dispose();
});

test('load deduplicates, guards writes, and ignores a disposed late response', async () => {
  const pending = deferred();
  let calls = 0;
  const store = createTermsStore('session', () => {
    calls++;
    return pending.promise;
  });
  const before = store.getSnapshot();
  const first = store.load();
  assert.equal(first, store.load());
  assert.equal(await store.mutate('clear'), false);
  await tick();
  assert.equal(calls, 1);
  store.dispose();
  const disposedSnapshot = store.getSnapshot();
  pending.resolve({ ok: true, state: emptyState() });
  assert.equal(await first, false);
  assert.equal(store.getSnapshot(), disposedSnapshot);
  assert.equal(before.data, null);
});

test('direct subscriptions have stable references and refresh cached state after remount', async () => {
  const server = backend();
  let gets = 0;
  const store = createTermsStore('session', (...args) => {
    gets++;
    return server.request(...args);
  });
  const subscribe = store.subscribe,
    getSnapshot = store.getSnapshot;
  const off = subscribe(() => {});
  await store.load();
  const offSecond = subscribe(() => {});
  assert.equal(gets, 1);
  off();
  offSecond();
  server.change('create', { name: 'B' });
  const offRemount = subscribe(() => {});
  await store.load();
  assert.equal(gets, 2);
  assert.equal(getSnapshot().data.terms.length, 2);
  assert.equal(store.subscribe, subscribe);
  assert.equal(store.getSnapshot, getSnapshot);
  const snapshot = getSnapshot();
  assert.equal(getSnapshot(), snapshot);
  offRemount();
  store.dispose();
});

test('transport and malformed states fail safely without publishing partial data', async () => {
  const server = backend();
  let response;
  const store = createTermsStore('session', (...args) =>
    response ? response(...args) : server.request(...args),
  );
  await store.load();
  const before = store.getSnapshot().data;
  for (const patch of [
    { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { terms: [{ ...before.terms[0], order: 0.5 }] },
    { terms: [{ ...before.terms[0], order: -1 }] },
    { terms: [{ ...before.terms[0], version: Infinity }] },
  ]) {
    response = async () => ({ ok: true, state: { ...before, ...patch } });
    assert.equal(await store.load(), false);
    assert.equal(store.getSnapshot().data, before);
    assert.equal(store.getSnapshot().error.code, 'invalid');
  }
  response = async () => {
    throw Error('network');
  };
  assert.equal(await store.load(), false);
  assert.equal(await store.mutate('delete', { id: before.terms[0].id }), false);
  assert.equal(store.getSnapshot().data, before);
  assert.equal(store.getSnapshot().error.code, 'transport');
  assert.equal(store.getSnapshot().busy, false);
  assert.equal(store.getSnapshot().loading, false);
  store.dispose();
});

test('optimistic delete rolls back failed writes, preserves undo on failure, and expires after eight seconds', async () => {
  const server = backend(),
    timer = clock();
  let fail = false,
    pending;
  server.change('create', { name: 'B' });
  const store = createTermsStore(
    'session',
    (...args) =>
      pending ? pending.promise : fail ? Promise.reject(Error('offline')) : server.request(...args),
    timer,
  );
  await store.load();
  const first = store.getSnapshot().data.terms[0];
  assert.equal(await store.mutate('delete', { id: first.id }), true);
  const undo = store.getSnapshot().undo,
    before = store.getSnapshot().data;
  pending = deferred();
  const deletion = store.mutate('delete', { id: before.terms[0].id });
  assert.equal(store.getSnapshot().data.terms.length, 0);
  assert.equal(await store.mutate('clear'), false);
  pending.resolve({ ok: false, code: 'failed' });
  await deletion;
  pending = null;
  assert.equal(store.getSnapshot().data, before);
  assert.equal(store.getSnapshot().undo, undo);
  fail = true;
  assert.equal(await store.mutate('restore', undo), false);
  assert.equal(store.getSnapshot().undo, undo);
  assert.equal(await store.mutate('deleteMany', { ids: [before.terms[0].id] }), false);
  assert.equal(store.getSnapshot().undo, undo);
  timer.advance(7999);
  assert.equal(store.getSnapshot().undo, undo);
  timer.advance(1);
  assert.equal(store.getSnapshot().undo, null);
  fail = false;
  assert.equal(await store.mutate('delete', { id: before.terms[0].id }), true);
  assert.ok(store.getSnapshot().undo);
  assert.equal(await store.mutate('deleteMany', { ids: [first.id] }), false);
  // A successful batch clears the prior single-delete undo.
  server.change('create', { name: 'C' });
  await store.load();
  assert.equal(await store.mutate('deleteMany', { ids: [server.state.terms[0].id] }), true);
  assert.equal(store.getSnapshot().undo, null);
  store.dispose();
  assert.equal(timer.size, 0);
});

test('disposed writes never publish late results', async () => {
  const server = backend(),
    pending = deferred();
  let writing = false;
  const store = createTermsStore('session', (...args) =>
    writing ? pending.promise : server.request(...args),
  );
  await store.load();
  writing = true;
  const mutation = store.mutate('clear');
  store.dispose();
  const snapshot = store.getSnapshot();
  pending.resolve({ ok: true, state: { revision: 2, expanded: false, terms: [] } });
  assert.equal(await mutation, false);
  assert.equal(store.getSnapshot(), snapshot);
});

test('registry expires inactive entries including never-subscribed entries and supports StrictMode resubscribe', async () => {
  const server = backend(),
    timer = clock();
  let gets = 0;
  const registry = createTermsRegistry(
    (...args) => {
      gets++;
      return server.request(...args);
    },
    { ...timer, idleTTL: 60 },
  );
  const store = registry.forSession('A');
  let off = store.subscribe(() => {});
  await store.load();
  off();
  timer.advance(30);
  off = store.subscribe(() => {});
  await store.load();
  timer.advance(100);
  assert.equal(registry.forSession('A'), store);
  assert.equal(registry.size, 1);
  assert.equal(gets, 2);
  registry.forSession('unused');
  timer.advance(60);
  assert.equal(registry.size, 1);
  off();
  timer.advance(60);
  assert.equal(registry.size, 0);
  assert.notEqual(registry.forSession('A'), store);
  registry.dispose();
  assert.equal(timer.size, 0);
});

test('registry defers TTL eviction for pending loads and writes, resubscribe preserves the write', async () => {
  const server = backend(),
    timer = clock();
  let blocked = deferred(),
    block = true;
  const registry = createTermsRegistry(
    (...args) => (block ? blocked.promise : server.request(...args)),
    { ...timer, idleTTL: 60 },
  );
  const store = registry.forSession('A');
  let off = store.subscribe(() => {});
  const loading = store.load();
  off();
  timer.advance(60);
  assert.equal(registry.size, 1);
  off = store.subscribe(() => {});
  blocked.resolve({ ok: true, state: server.state });
  await loading;
  block = true;
  blocked = deferred();
  const writing = store.mutate('clear');
  off();
  timer.advance(100);
  assert.equal(registry.size, 1);
  off = store.subscribe(() => {});
  assert.equal(registry.forSession('A'), store);
  blocked.resolve({ ok: true, state: { revision: 2, expanded: false, terms: [] } });
  assert.equal(await writing, true);
  await store.load();
  assert.equal(store.getSnapshot().data.terms.length, 0);
  off();
  timer.advance(60);
  assert.equal(registry.size, 0);
  block = false;
  registry.dispose();
});

test('first subscription during a write queues one refresh shared with foreground loads', async () => {
  const server = backend(),
    write = deferred();
  let gets = 0;
  const store = createTermsStore('session', (...args) => {
    if (args[1] !== 'get') return write.promise;
    gets++;
    return server.request(...args);
  });
  await store.load();
  const mutation = store.mutate('create', { name: 'B' });
  server.change('create', { name: 'B' });
  const response = structuredClone(server.state);
  const off = store.subscribe(() => {});
  const first = store.load();
  assert.equal(store.load(), first);
  assert.equal(gets, 1);
  write.resolve({ ok: true, state: response });
  server.change('create', { name: 'C' });
  assert.equal(await mutation, true);
  assert.equal(await first, true);
  assert.equal(gets, 2);
  assert.equal(store.getSnapshot().data.revision, 3);
  assert.deepEqual(
    store.getSnapshot().data.terms.map((term) => term.name),
    ['A', 'B', 'C'],
  );
  off();
  store.dispose();
});

test('internal conflict refresh bypasses the external write queue without deadlock', async () => {
  const server = backend(),
    write = deferred(),
    internalRead = deferred();
  let gets = 0;
  const store = createTermsStore('session', (...args) => {
    if (args[1] !== 'get') return write.promise;
    gets++;
    return gets === 2 ? internalRead.promise : server.request(...args);
  });
  await store.load();
  const term = store.getSnapshot().data.terms[0];
  store.openEditor({ term });
  const mutation = store.mutate('update', {
    id: term.id,
    name: term.name,
    note: 'draft',
    expectedVersion: term.version,
  });
  const queued = store.load();
  write.resolve({ ok: false, code: 'conflict' });
  await tick();
  assert.equal(gets, 2);
  assert.equal(store.load(), queued);
  server.change('create', { name: 'B' });
  internalRead.resolve({ ok: true, state: structuredClone(server.state) });
  server.change('create', { name: 'C' });
  assert.equal(await mutation, false);
  assert.equal(await queued, true);
  assert.equal(gets, 3);
  assert.equal(store.getSnapshot().data.revision, 3);
  assert.equal(store.getSnapshot().error.code, 'conflict');
  assert.equal(store.getSnapshot().editorRequest.term, term);
  store.dispose();
});

test('dispose resolves queued refresh waiters false without waiting for a late write', async () => {
  const server = backend(),
    write = deferred();
  let gets = 0;
  const store = createTermsStore('session', (...args) => {
    if (args[1] !== 'get') return write.promise;
    gets++;
    return server.request(...args);
  });
  await store.load();
  const mutation = store.mutate('clear');
  const queued = store.load();
  store.dispose();
  assert.equal(await queued, false);
  write.resolve({ ok: true, state: { revision: 2, expanded: false, terms: [] } });
  assert.equal(await mutation, false);
  assert.equal(gets, 1);
});

test('expired registry entries keep a queued refresh alive until the read settles', async () => {
  const server = backend(),
    timer = clock(),
    write = deferred(),
    refresh = deferred();
  let gets = 0;
  const registry = createTermsRegistry(
    (...args) => {
      if (args[1] !== 'get') return write.promise;
      gets++;
      return gets === 1 ? server.request(...args) : refresh.promise;
    },
    { ...timer, idleTTL: 60 },
  );
  const store = registry.forSession('A');
  await store.load();
  const mutation = store.mutate('clear');
  const queued = store.load();
  timer.advance(100);
  write.resolve({ ok: true, state: { revision: 2, expanded: false, terms: [] } });
  assert.equal(await mutation, true);
  assert.equal(registry.size, 1);
  refresh.resolve({ ok: true, state: { revision: 3, expanded: true, terms: [] } });
  assert.equal(await queued, true);
  assert.equal(store.getSnapshot().data.revision, 3);
  assert.equal(registry.size, 0);
  registry.dispose();
  assert.equal(timer.size, 0);
});

test('registry disposal waits for pending writes to settle and refreshActive only loads active stores', async () => {
  const server = backend(),
    timer = clock(),
    pending = deferred();
  let block = false,
    gets = 0;
  const registry = createTermsRegistry((...args) => {
    if (args[1] === 'get') gets++;
    return block ? pending.promise : server.request(...args);
  }, timer);
  registry.forSession('unused');
  const store = registry.forSession('A');
  store.subscribe(() => {});
  await store.load();
  await registry.refreshActive();
  assert.equal(gets, 2);
  block = true;
  const mutation = store.mutate('clear');
  registry.dispose();
  assert.equal(registry.size, 1);
  assert.throws(() => registry.forSession('new'), /disposed/);
  pending.resolve({ ok: true, state: { revision: 2, expanded: false, terms: [] } });
  assert.equal(await mutation, true);
  assert.equal(registry.size, 0);
  assert.equal(timer.size, 0);
});
