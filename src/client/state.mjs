function validState(state) {
  if (
    !state ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    typeof state.expanded !== 'boolean' ||
    !Array.isArray(state.terms)
  )
    return false;
  const ids = new Set(),
    names = new Set();
  return state.terms.every((term) => {
    if (
      !term ||
      typeof term.id !== 'string' ||
      !term.id ||
      typeof term.name !== 'string' ||
      !term.name.trim() ||
      term.name !== term.name.trim() ||
      typeof term.note !== 'string' ||
      (term.color != null &&
        (typeof term.color !== 'string' ||
          term.color.length !== 7 ||
          !/^#[0-9a-f]{6}$/i.test(term.color))) ||
      !Number.isSafeInteger(term.version) ||
      term.version < 1 ||
      !Number.isSafeInteger(term.order) ||
      term.order < 0 ||
      ids.has(term.id) ||
      names.has(term.name)
    )
      return false;
    ids.add(term.id);
    names.add(term.name);
    return true;
  });
}

const normalized = (state) => ({
  ...state,
  terms: state.terms.map((term) => ({ ...term })).sort((a, b) => a.order - b.order),
});
const errorOf = (result) =>
  result?.ok === false
    ? {
        ...(typeof result.error === 'object' && result.error ? result.error : {}),
        code: result.code ?? result.error?.code ?? 'failed',
      }
    : { code: 'invalid' };
const internals = new WeakMap();

export function createTermsStore(sessionId, request, options = {}) {
  return makeStore(sessionId, request, options, () => {});
}

function makeStore(sessionId, request, options, lifecycle) {
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  let snapshot = {
    data: null,
    loading: false,
    busy: false,
    error: null,
    undo: null,
    editorRequest: null,
  };
  let alive = true,
    pendingLoad = null,
    queuedRefresh = null,
    writing = false,
    undoTimer;
  const listeners = new Set();
  const publish = (patch) => {
    if (!alive) return;
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const call = async (action, payload) => {
    try {
      return await request(sessionId, action, payload);
    } catch {
      return { ok: false, code: 'transport' };
    }
  };
  function load(allowWrite = false, preserveError = false) {
    if (!alive) return Promise.resolve(false);
    if (writing && !allowWrite) {
      if (!queuedRefresh) {
        let resolve;
        const promise = new Promise((done) => {
          resolve = done;
        });
        queuedRefresh = { promise, resolve };
      }
      return queuedRefresh.promise;
    }
    if (pendingLoad) return pendingLoad;
    pendingLoad = Promise.resolve().then(async () => {
      try {
        const result = await call('get', {});
        if (!alive) return false;
        if (
          result?.ok === true &&
          validState(result.state) &&
          (!snapshot.data || result.state.revision >= snapshot.data.revision)
        ) {
          publish({ data: normalized(result.state), ...(preserveError ? {} : { error: null }) });
          return true;
        }
        if (!preserveError) publish({ error: errorOf(result) });
        return false;
      } finally {
        pendingLoad = null;
        publish({ loading: false });
        lifecycle();
      }
    });
    publish({ loading: true, ...(preserveError ? {} : { error: null }) });
    lifecycle();
    return pendingLoad;
  }
  function clearUndo() {
    cancel(undoTimer);
    undoTimer = undefined;
    publish({ undo: null });
  }
  const store = {
    getSnapshot: () => snapshot,
    active: () => listeners.size > 0,
    subscribe(listener) {
      if (!alive) return () => {};
      const first = listeners.size === 0;
      listeners.add(listener);
      lifecycle();
      if (first) void load();
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
        lifecycle();
      };
    },
    load: () => load(),
    async mutate(action, payload = {}) {
      if (!alive || writing || pendingLoad || !snapshot.data) return false;
      const previous = snapshot.data;
      writing = true;
      publish({
        busy: true,
        error: null,
        ...(action === 'delete'
          ? {
              data: { ...previous, terms: previous.terms.filter((term) => term.id !== payload.id) },
            }
          : {}),
      });
      lifecycle();
      try {
        const result = await call(action, { ...payload, expectedRevision: previous.revision });
        if (!alive) return false;
        if (
          result?.ok === true &&
          validState(result.state) &&
          result.state.revision >= previous.revision
        ) {
          publish({ data: normalized(result.state), error: null });
          if (action === 'delete') {
            const index = previous.terms.findIndex((term) => term.id === payload.id);
            if (index >= 0) {
              cancel(undoTimer);
              publish({ undo: { term: previous.terms[index], index } });
              undoTimer = schedule(() => {
                undoTimer = undefined;
                publish({ undo: null });
              }, options.undoTTL ?? 8000);
            }
          } else if (['restore', 'clear', 'deleteMany'].includes(action)) clearUndo();
          return true;
        }
        const error = errorOf(result);
        publish({ data: previous, error });
        if (error.code === 'conflict') await load(true, true);
        return false;
      } finally {
        writing = false;
        if (queuedRefresh) {
          const queued = queuedRefresh;
          queuedRefresh = null;
          void load(false, snapshot.error !== null).then(queued.resolve);
        }
        publish({ busy: false });
        lifecycle();
      }
    },
    openEditor: (editorRequest) => publish({ editorRequest, error: null }),
    closeEditor: () => publish({ editorRequest: null }),
    setError: (error) => publish({ error }),
    dispose() {
      alive = false;
      queuedRefresh?.resolve(false);
      queuedRefresh = null;
      cancel(undoTimer);
      listeners.clear();
    },
  };
  internals.set(store, {
    pending: () => writing || pendingLoad !== null || queuedRefresh !== null,
  });
  return store;
}

export function createTermsRegistry(request, options = {}) {
  const entries = new Map();
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  const idleTTL = options.idleTTL ?? 60000;
  let disposed = false;
  function remove(entry) {
    cancel(entry.timer);
    entry.timer = undefined;
    entry.store.dispose();
    if (entries.get(entry.sessionId) === entry) entries.delete(entry.sessionId);
  }
  function reconcile(entry) {
    cancel(entry.timer);
    entry.timer = undefined;
    if (disposed) {
      if (!internals.get(entry.store).pending()) remove(entry);
      return;
    }
    if (entry.store.active()) {
      entry.idleSince = null;
      return;
    }
    entry.idleSince ??= now();
    const remaining = idleTTL - (now() - entry.idleSince);
    if (remaining <= 0) {
      if (!internals.get(entry.store).pending()) remove(entry);
      return;
    }
    entry.timer = schedule(() => {
      entry.timer = undefined;
      reconcile(entry);
    }, remaining);
    entry.timer?.unref?.();
  }
  return {
    forSession(sessionId) {
      if (disposed) throw new Error('Terms registry is disposed');
      let entry = entries.get(sessionId);
      if (!entry) {
        entry = { sessionId, idleSince: now(), timer: undefined, store: null };
        entry.store = makeStore(sessionId, request, options, () => reconcile(entry));
        entries.set(sessionId, entry);
        reconcile(entry);
      }
      return entry.store;
    },
    refreshActive() {
      if (disposed) return Promise.resolve([]);
      return Promise.all(
        [...entries.values()]
          .filter((entry) => entry.store.active())
          .map((entry) => entry.store.load()),
      );
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) reconcile(entry);
    },
    get size() {
      return entries.size;
    },
  };
}
