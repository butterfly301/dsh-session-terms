import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  createTermsRepository,
  renderTerm,
  TermsError,
  DOMAIN_NAME,
  LOOKUP_TOOL,
} from './src/terms.mjs';
import { TERM_COLOR_PATTERN, TERM_COLOR_LENGTH } from './src/color.mjs';
import { installContextGate } from './src/context.mjs';
import { readLocales, translate } from './src/i18n.mjs';
import { createTermsIdentity, selectFirstUserMessage } from './src/identity.mjs';

export const inject = ['storageDomain', 'agents', 'commands', 'systemPrompt', 'tools'];

const termSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  note: z.string(),
  color: z.string().length(TERM_COLOR_LENGTH).regex(TERM_COLOR_PATTERN).nullable().optional(),
  version: z.number().int().positive(),
  order: z.number().int().nonnegative(),
});
export const termsDomain = defineDomain({
  name: DOMAIN_NAME,
  version: 1,
  layout: 'per-record',
  tables: {
    sessions: domainTable(
      z.object({
        revision: z.number().int().nonnegative(),
        expanded: z.boolean(),
        terms: z.array(termSchema),
      }),
    ),
  },
});

const commandInput = z
  .object({
    sessionId: z.string().min(1).optional(),
    action: z.enum([
      'get',
      'create',
      'update',
      'delete',
      'deleteMany',
      'restore',
      'clear',
      'reorder',
      'setExpanded',
    ]),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Read the earliest user-authored message of one Session through the session
 * query service. A fork copies that message verbatim, so it identifies the
 * conversation lineage the Session belongs to.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} sessionId - the Session to read.
 * @returns the message projection, or undefined when unreadable or absent.
 */
async function readFirstUserMessage(ctx, sessionId) {
  const query = ctx.get('sessionQuery');
  if (query === undefined) return undefined;
  const observation = await query.observeSession(sessionId, { projectionMode: 'none' });
  try {
    return selectFirstUserMessage(observation.events);
  } finally {
    observation[Symbol.dispose]?.();
  }
}

export async function apply(ctx) {
  // The shipped locale service is client-only. Host copy follows locale/config.json.
  const resources = readLocales();
  const t = (key) => translate(resources, `host.${key}`);
  const domain = await ctx.storageDomain.open(termsDomain);
  ctx.effect(() => () => domain.close());
  const repository = createTermsRepository(domain.table('sessions'));
  // Terms belong to a conversation, not to one Session: every fork of that
  // conversation must address the same record. Identity resolves that key.
  const identity = createTermsIdentity({
    firstUserMessage: (sessionId) => readFirstUserMessage(ctx, sessionId),
  });
  const attached = new Map();

  ctx.commands.register({
    name: 'session-terms',
    description: t('commandDescription'),
    input: { hint: t('commandHint') },
    recordInput: false,
    async handler({ agent, rawInput, signal }) {
      try {
        signal?.throwIfAborted();
        let input;
        try {
          input = commandInput.parse(JSON.parse(rawInput.trim()));
        } catch {
          throw new TermsError('invalid-request');
        }
        if (input.sessionId !== undefined && input.sessionId !== agent.session.id)
          throw new TermsError('session-mismatch');
        const key = await identity.keyFor(agent.session.id);
        const result = await repository.call(key, input.action, input.payload ?? {});
        return { kind: 'success', text: JSON.stringify(result) };
      } catch (error) {
        const code = error instanceof TermsError ? error.code : 'operation-failed';
        return { kind: 'success', text: JSON.stringify({ ok: false, code }) };
      }
    },
  });

  const attach = (agent) => {
    if (attached.has(agent)) return;
    const sessionId = agent.session.id;
    // Resolve the lineage key before the terms bar can be addressed, so the
    // first render already reads the conversation's record.
    identity.warm(sessionId);
    const dispose = agent.ctx.effect(() => {
      const termsOfSession = () => {
        const key = identity.cachedKeyOf(sessionId);
        return key === undefined ? [] : repository.get(key).terms;
      };
      const gate = installContextGate(agent, termsOfSession);
      const removeSection = agent.ctx.systemPrompt.section({
        name: 'session-terms:guidance',
        order: 9100,
        interpolate: false,
        text: t('guidance'),
      });
      const removeTool = agent.ctx.tools.register(
        defineTool({
          name: LOOKUP_TOOL,
          description: t('lookupDescription'),
          parameters: {
            query: { type: 'string' },
            names: { type: 'array', items: { type: 'string' } },
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) =>
              value
                ? value.split('\n').map((text) => ({ type: 'text', text }))
                : [{ type: 'text', text: t('noMatches') }],
          },
          async execute({ query, names }, exec) {
            exec.signal?.throwIfAborted();
            const key = await identity.keyFor(sessionId);
            let terms = repository.get(key).terms;
            if (names !== undefined) terms = terms.filter((term) => names.includes(term.name));
            if (query)
              terms = terms.filter(
                (term) => term.name.includes(query) || term.note.includes(query),
              );
            return terms.map(renderTerm).join('\n');
          },
        }),
      );
      return async () => {
        await removeTool();
        await removeSection();
        await gate.dispose();
      };
    });
    attached.set(agent, dispose);
  };
  ctx.on('agent/created', ({ agent }) => attach(agent));
  ctx.on('agent/disposed', ({ agent }) => {
    identity.forget(agent.session.id);
    attached.delete(agent);
  });
  for (const agent of ctx.agents.list()) attach(agent);
  ctx.effect(() => async () => {
    const disposers = [...attached.values()];
    attached.clear();
    await Promise.all(disposers.map((dispose) => dispose()));
  });
}
