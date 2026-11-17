/**
 * Terms-library identity: which stored terms record a Session reads and writes.
 *
 * A record is keyed by conversation lineage rather than by Session id, so a
 * forked Session inherits the terms library of the conversation it was cut
 * from. Message rewind is implemented with exactly such a fork. A fork copies
 * the source event prefix verbatim, so the earliest user-authored message is
 * identical on every branch of one conversation; its timestamp and text
 * identify that lineage without any ancestry bookkeeping.
 *
 * Keep this module free of DSH services. The caller supplies one port,
 * `firstUserMessage`, and owns every integration detail behind it.
 */

import { createHash } from 'node:crypto';

const FALLBACK_PREFIX = 'session:';

/**
 * Project a Session log onto its earliest user-authored message.
 * @param {readonly { type: string, time: number, data?: { source?: { kind?: string }, content?: unknown } }[]} events
 *   a Session event prefix, ordered by seq.
 * @returns the message time and its textual content, or undefined when no user message exists.
 */
export function selectFirstUserMessage(events) {
  for (const event of events) {
    if (event.type !== 'user/message') continue;
    if (event.data?.source?.kind !== 'user') continue;
    const content = Array.isArray(event.data.content) ? event.data.content : [];
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    return { time: event.time, text };
  }
  return undefined;
}

/**
 * Derive the stable lineage key of one conversation.
 * @param {{ time: number, text: string }} message - the conversation's first user message.
 * @returns its lineage key, identical on every branch of that conversation.
 */
export function lineageKey({ time, text }) {
  const digest = createHash('sha256')
    .update(JSON.stringify([time, text]))
    .digest('base64url');
  return `lineage:${digest.slice(0, 22)}`;
}

/**
 * Build the resolver mapping Session ids to terms-library keys.
 *
 * Only confirmed lineage keys are cached. A Session without a user message, or
 * a Session whose log cannot be read, answers with `session:<id>` and is asked
 * again next time, so a log that becomes readable later still lands on its
 * lineage key instead of being pinned to a fallback forever.
 *
 * @param {{ firstUserMessage: (sessionId: string) => Promise<{ time: number, text: string } | undefined> }} port
 *   reads one Session's earliest user-authored message, or undefined when it has none yet.
 * @returns the resolver used by the command, the lookup tool, and the context gate.
 */
export function createTermsIdentity({ firstUserMessage }) {
  const confirmed = new Map();
  const inflight = new Map();

  function keyFor(sessionId) {
    const settled = confirmed.get(sessionId);
    if (settled !== undefined) return Promise.resolve(settled);
    const running = inflight.get(sessionId);
    if (running !== undefined) return running;

    const task = Promise.resolve()
      .then(() => firstUserMessage(sessionId))
      .then((message) => (message === undefined ? undefined : lineageKey(message)))
      .catch(() => undefined)
      .then((key) => {
        if (key === undefined) return `${FALLBACK_PREFIX}${sessionId}`;
        confirmed.set(sessionId, key);
        return key;
      })
      .finally(() => inflight.delete(sessionId));

    inflight.set(sessionId, task);
    return task;
  }

  return {
    keyFor,
    cachedKeyOf: (sessionId) => confirmed.get(sessionId),
    warm: (sessionId) => {
      void keyFor(sessionId);
    },
    forget: (sessionId) => {
      confirmed.delete(sessionId);
      inflight.delete(sessionId);
    },
  };
}
