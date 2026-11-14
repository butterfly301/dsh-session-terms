/** The command bridge is UI-only; it never sends a model message. */
export function createTermsRequest(commands) {
  return async function request(sessionId, action, payload = {}) {
    try {
      if (typeof commands?.execute !== 'function') return { ok: false, code: 'transport' };
      const raw = '/session-terms ' + JSON.stringify({ sessionId, action, payload });
      const response = await commands.execute(sessionId, raw, []);
      if (!response.ok || !response.value) return { ok: false, code: 'transport' };
      if (response.value.result.kind !== 'success') return { ok: false, code: 'failed' };
      return JSON.parse(response.value.result.text);
    } catch {
      return { ok: false, code: 'failed' };
    }
  };
}

/** Wrap the host's command renderer, even when it registers after this plugin. */
export function hideTermsCommands(registry) {
  let current;
  let removeWrapper;
  let reconciling = false;
  let disposed = false;

  function reconcile() {
    if (disposed || reconciling) return;
    const definition = [...registry.entries()].find(
      (item) => item.kind === 'command' && item.target === 'chat',
    );
    if (definition === current) return;
    reconciling = true;
    try {
      removeWrapper?.();
      removeWrapper = undefined;
      current = definition;
      if (!definition) return;
      removeWrapper = registry.register({
        ...definition,
        kind: 'session-terms:command-display',
        match(event) {
          const match = definition.match(event);
          return match === null ? null : { ...match, exclusive: true };
        },
        buildViewNode(context) {
          const node = definition.buildViewNode(context);
          return node?.kind === 'command' && node.data?.name === 'session-terms'
            ? { ...node, visibility: 'hidden' }
            : node;
        },
      });
    } finally {
      reconciling = false;
    }
  }

  const unsubscribe = registry.subscribe(reconcile);
  reconcile();
  return () => {
    disposed = true;
    unsubscribe();
    removeWrapper?.();
  };
}
