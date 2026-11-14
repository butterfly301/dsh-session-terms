import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createTermsStore } from '../src/client/state.mjs';
import { startColorFixture } from './browser-colors.mjs';

async function withFixture(t) {
  const fixture = await startColorFixture();
  t.after(() => fixture.close());
  const command = async (action, payload = {}, sessionId = fixture.sessionId) => {
    const response = await fetch(fixture.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, action, payload }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { ...fixture, command };
}

test('color fixture serves real seeded repository state through HTTP', async (t) => {
  const fixture = await withFixture(t);
  const result = await fixture.command('get');
  assert.equal(result.ok, true);
  assert.equal(result.state.revision, 2);
  assert.equal(result.state.expanded, false);
  assert.deepEqual(
    result.state.terms.map(({ name, note, color, version, order }) => ({
      name,
      note,
      color,
      version,
      order,
    })),
    [
      { name: '灯塔', note: '本项目的登录服务', color: '#b83f36', version: 1, order: 0 },
      {
        name: 'GlitchTransitionRendererFeature',
        note: '故障转场渲染扩展',
        color: '#2868b4',
        version: 1,
        order: 1,
      },
    ],
  );
  assert.equal(new Set(result.state.terms.map(({ id }) => id)).size, 2);
  for (const term of result.state.terms) assert.match(term.id, /^[\da-f-]{36}$/);
});

test('HTTP create, update, default reset, delete, restore, reorder and deleteMany use domain behavior', async (t) => {
  const { command } = await withFixture(t);
  let result = await command('create', { name: '  New term  ', color: '#AbC09F' });
  assert.equal(result.ok, true);
  let term = result.state.terms.at(-1);
  assert.equal(term.name, 'New term');
  assert.equal(term.note, '');
  assert.equal(term.color, '#abc09f');
  assert.equal(term.version, 1);
  result = await command('update', {
    id: term.id,
    name: term.name,
    note: 'edited without changing color',
    expectedVersion: term.version,
    expectedRevision: result.state.revision,
  });
  term = result.state.terms.at(-1);
  assert.equal(term.color, '#abc09f');
  assert.equal(term.version, 2);
  result = await command('update', { ...term, color: null });
  term = result.state.terms.at(-1);
  assert.equal(term.color, null);
  assert.equal(term.version, 3);
  const beforeDelete = result.state;
  result = await command('delete', { id: term.id });
  assert.equal(result.state.terms.length, 2);
  assert.equal(
    result.state.terms.some(({ id }) => id === term.id),
    false,
  );
  result = await command('restore', { term, index: 1 });
  assert.deepEqual(result.state.terms[1], { ...term, order: 1 });
  const ids = result.state.terms.map(({ id }) => id).reverse();
  result = await command('reorder', { ids });
  assert.deepEqual(
    result.state.terms.map(({ id }) => id),
    ids,
  );
  assert.deepEqual(
    result.state.terms.map(({ order }) => order),
    [0, 1, 2],
  );
  result = await command('deleteMany', { ids: [ids[0], ids[1]] });
  assert.deepEqual(
    result.state.terms.map(({ id }) => id),
    [ids[2]],
  );
  assert.equal(result.state.terms[0].order, 0);
  assert.equal(result.state.revision, beforeDelete.revision + 4);
  result = await command('create', { name: 'Default color' });
  assert.equal(result.state.terms.at(-1).color, null);
  result = await command('setExpanded', { expanded: true });
  assert.equal(result.state.expanded, true);
  result = await command('clear');
  assert.deepEqual(result.state.terms, []);
  assert.equal(result.state.expanded, true);
});

test('HTTP rejects stale revision and term version CAS without changing state', async (t) => {
  const { command } = await withFixture(t);
  const before = await command('get');
  const term = before.state.terms[0];
  for (const payload of [
    { expectedRevision: before.state.revision - 1 },
    { expectedVersion: term.version - 1 },
  ]) {
    assert.deepEqual(await command('update', { ...term, note: 'stale write', ...payload }), {
      ok: false,
      code: 'conflict',
    });
    assert.deepEqual(await command('get'), before);
  }
  const concurrent = await Promise.all([
    command('create', { name: 'Winner A', expectedRevision: before.state.revision }),
    command('create', { name: 'Winner B', expectedRevision: before.state.revision }),
  ]);
  assert.equal(concurrent.filter(({ ok }) => ok).length, 1);
  assert.deepEqual(
    concurrent.find(({ ok }) => !ok),
    { ok: false, code: 'conflict' },
  );
  assert.equal((await command('get')).state.revision, before.state.revision + 1);
});

test('HTTP rejects invalid colors on create, update and restore atomically', async (t) => {
  const { command } = await withFixture(t);
  const before = await command('get');
  const term = before.state.terms[0];
  for (const color of [
    '',
    'red',
    '#abc',
    '#12345678',
    '#12345g',
    '#123456\n',
    'var(--color)',
    123,
  ]) {
    for (const [action, payload] of [
      ['create', { name: 'Invalid color', color }],
      ['update', { ...term, color }],
      ['restore', { term: { ...term, id: 'restored', name: 'Restored', color } }],
    ]) {
      assert.deepEqual(await command(action, payload), { ok: false, code: 'invalid-color' });
      assert.deepEqual(await command('get'), before);
    }
  }
});

test('HTTP semantic no-ops preserve revision and term version', async (t) => {
  const { command } = await withFixture(t);
  const before = await command('get');
  const term = before.state.terms[0];
  assert.deepEqual(await command('update', { ...term, color: term.color.toUpperCase() }), before);
  assert.deepEqual(
    await command('update', { id: term.id, name: term.name, note: term.note }),
    before,
  );
  assert.deepEqual(await command('setExpanded', { expanded: false }), before);
  assert.deepEqual(await command('get'), before);
});

test('HTTP returns code-only errors for unsupported actions, invalid commands and other sessions', async (t) => {
  const { command, endpoint } = await withFixture(t);
  const before = await command('get');
  for (const [action, payload, code] of [
    ['unsupported', {}, 'unknown-action'],
    ['delete', { id: 'absent' }, 'missing-term'],
    ['deleteMany', { ids: [before.state.terms[0].id, 'absent'] }, 'missing-term'],
    ['deleteMany', { ids: [] }, 'invalid-selection'],
    ['reorder', { ids: [] }, 'invalid-order'],
    ['restore', { term: {} }, 'invalid-restore'],
    ['create', { name: before.state.terms[0].name }, 'duplicate-name'],
    ['setExpanded', { expanded: 'yes' }, 'invalid-expanded'],
  ]) {
    assert.deepEqual(await command(action, payload), { ok: false, code });
    assert.deepEqual(await command('get'), before);
  }
  for (const otherSession of ['another-session', '', null, 123]) {
    for (const action of ['get', 'create']) {
      assert.deepEqual(await command(action, { name: 'Isolated' }, otherSession), {
        ok: false,
        code: 'invalid-session',
      });
    }
  }
  const missingSession = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get' }),
  });
  assert.deepEqual(await missingSession.json(), { ok: false, code: 'invalid-session' });
  assert.deepEqual(await command('get'), before);
});

test('HTTP fixture restricts the endpoint and rejects malformed requests', async (t) => {
  const { endpoint, url, sessionId, command } = await withFixture(t);
  const before = await command('get');
  for (const body of [
    '{',
    'null',
    '[]',
    '{}',
    JSON.stringify({ sessionId, action: 'get', payload: null }),
  ]) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.deepEqual(await response.json(), { ok: false, code: 'invalid-request' });
  }
  for (const [target, options, status, code] of [
    [endpoint, {}, 405, 'method-not-allowed'],
    [endpoint, { method: 'POST', body: '{}' }, 415, 'invalid-content-type'],
    [
      endpoint,
      { method: 'POST', headers: { Origin: 'https://example.com' } },
      403,
      'invalid-origin',
    ],
    [new URL('/other/terms', url), {}, 404, 'not-found'],
  ]) {
    const response = await fetch(target, options);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { ok: false, code });
  }
  assert.deepEqual(await command('get'), before);
});

test('fixture instances have separate in-memory repositories', async (t) => {
  const first = await withFixture(t);
  const second = await withFixture(t);
  await first.command('clear');
  assert.deepEqual((await first.command('get')).state.terms, []);
  assert.equal((await second.command('get')).state.terms.length, 2);
});

test('production terms store uses HTTP for mutation, conflict refresh and undo restore', async (t) => {
  const { command } = await withFixture(t);
  const store = createTermsStore('demo', (_sessionId, action, payload) => command(action, payload));
  t.after(() => store.dispose());
  assert.equal(await store.load(), true);
  const term = store.getSnapshot().data.terms[0];
  assert.equal(await store.mutate('delete', { id: term.id }), true);
  assert.equal(store.getSnapshot().data.terms.length, 1);
  const undo = store.getSnapshot().undo;
  assert.deepEqual(undo, { term, index: 0 });
  assert.equal(await store.mutate('restore', undo), true);
  assert.deepEqual(store.getSnapshot().data.terms[0], term);
  assert.equal(store.getSnapshot().undo, null);
  await command('create', { name: 'External change' });
  assert.equal(await store.mutate('update', { ...term, color: null }), false);
  assert.equal(store.getSnapshot().error.code, 'conflict');
  assert.deepEqual(store.getSnapshot().data, (await command('get')).state);
  assert.equal(await store.mutate('unsupported'), false);
  assert.equal(store.getSnapshot().error.code, 'unknown-action');
});

test('fixture HTML serves the bundled production frontend', async (t) => {
  const { url } = await withFixture(t);
  const html = await fetch(url);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /<script src="\/fixture\.js"><\/script>/);
  const script = await fetch(new URL('/fixture.js', url));
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /text\/javascript/);
  assert.ok((await script.text()).length > 0);
});

test('importing the fixture exits without starting a server', () => {
  const moduleUrl = new URL('./browser-colors.mjs', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)});`],
    {
      timeout: 5000,
      encoding: 'utf8',
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
