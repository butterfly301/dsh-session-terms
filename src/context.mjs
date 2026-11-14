import { randomUUID } from 'node:crypto';
import { matchTerms, renderTerm, SOURCE_KIND, LOOKUP_TOOL } from './terms.mjs';

// Version-bound admission integration, verified against DSH 0.2.2-rc.3.
// There is no public final-admission event. agent.inject() queues a later step
// and cannot repair the current request after route preparation or retry.
// Keep the refresh probe isolated: context callbacks are not a general
// final-admission extension contract.
export function installContextGate(agent, getTerms) {
  const disposers = [];
  const state = { active: false, turn: undefined, matchedIds: new Set(), appended: 0, checks: 0 };
  let stepTerms = [];
  let stepSignal;
  let disposed = false;
  const assemblyContexts = new WeakSet();
  const pending = new Map();
  const makeMessage = (term) => ({
    id: randomUUID(),
    role: 'user',
    source: { kind: SOURCE_KIND },
    content: [{ type: 'text', text: entryText(term) }],
  });
  const textOf = (message) =>
    message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  const entryText = renderTerm;
  const hasTerm = (messages, text) => {
    const lookupCalls = new Set(
      messages.flatMap((message) =>
        message.role === 'assistant'
          ? message.content
              .filter((block) => block.type === 'tool-call' && block.name === LOOKUP_TOOL)
              .map((block) => block.id)
          : [],
      ),
    );
    const id = JSON.parse(text).id;
    // Compare the latest complete entry for this id so reverting a note also
    // supersedes newer context, without exposing revision metadata to the model.
    for (const message of messages.toReversed()) {
      const owned = message.source?.kind === SOURCE_KIND;
      const queried =
        message.role === 'tool' && !message.isError && lookupCalls.has(message.toolCallId);
      if (!owned && !queried) continue;
      for (const block of message.content.toReversed()) {
        if (block.type !== 'text') continue;
        try {
          const entry = JSON.parse(block.text);
          if (entry?.id !== id || typeof entry.name !== 'string' || typeof entry.note !== 'string')
            continue;
          return renderTerm(entry) === text;
        } catch {
          /* Pruned or incomplete results do not prove presence. */
        }
      }
    }
    return false;
  };
  disposers.push(
    agent.ctx.on('agent/pre-step', async (input, next) => {
      if (disposed) return next();
      if (state.turn !== input.turn) {
        state.turn = input.turn;
        state.matchedIds.clear();
      }
      for (const message of input.messages) {
        if (message.source.kind !== 'user') continue;
        const text = textOf(message);
        for (const term of matchTerms(text, getTerms())) state.matchedIds.add(term.id);
      }
      const decision = await next();
      if (disposed || decision.kind !== 'enter') return decision;
      stepSignal = input.signal;
      stepTerms = getTerms()
        .filter((term) => state.matchedIds.has(term.id))
        .map((term) => ({ ...term }));
      pending.clear();
      const existing = agent.session.deriveMessages();
      const additions = [];
      for (const term of stepTerms) {
        const text = entryText(term);
        if (hasTerm(existing, text)) continue;
        const message = makeMessage(term);
        pending.set(message.id, text);
        additions.push(message);
      }
      return { ...decision, messages: [...decision.messages, ...additions] };
    }),
  );
  disposers.push(
    agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return;
      if (event.type === 'step/start') state.active = true;
      if (event.type === 'user/message' && event.data.source?.kind === SOURCE_KIND) {
        pending.delete(event.data.id);
        state.appended++;
      }
      if (event.type === 'step/end' || event.type === 'turn/end') {
        state.active = false;
        pending.clear();
      }
    }),
  );
  disposers.push(
    // assemble() resolves variables before context providers; refreshContext()
    // reuses accepted variables and does not call them. Mark the actual object
    // so previews remain read-only even when they reuse the active signal.
    agent.ctx.systemPrompt.variable('session_terms_assembly_guard', (context) => {
      assemblyContexts.add(context);
      return undefined;
    }),
  );
  disposers.push(
    agent.ctx.systemPrompt.context({
      name: 'session-terms:admission-probe',
      order: 22000,
      required: true,
      interpolate: false,
      text(context) {
        // rc.3 refresh has the accepted signal, no toolSet, and a fresh context
        // object. This is version-bound and does not make arbitrary direct
        // refreshContext() calls or later providers into safe admission hooks.
        if (
          disposed ||
          assemblyContexts.has(context) ||
          !state.active ||
          context.signal !== stepSignal ||
          context.signal?.aborted ||
          context.toolSet !== undefined
        )
          return '';
        state.checks++;
        const messages = agent.session.deriveMessages();
        for (const term of stepTerms) {
          const text = entryText(term);
          if ([...pending.values()].includes(text)) continue;
          // Only an intact, plugin-sourced standalone payload counts; summaries
          // and user copies containing identifiers alone do not prove presence.
          const exists = hasTerm(messages, text);
          if (exists) continue;
          agent.session.append('user/message', makeMessage(term), { surfaceOp: 'append' });
        }
        return '';
      },
    }),
  );
  return {
    state,
    dispose: async () => {
      disposed = true;
      state.active = false;
      state.matchedIds.clear();
      stepTerms = [];
      stepSignal = undefined;
      pending.clear();
      for (const dispose of disposers.splice(0).toReversed()) await dispose();
    },
  };
}
