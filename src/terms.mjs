import { randomUUID } from 'node:crypto';
import { isTermColor } from './color.mjs';
import { findTermOccurrences } from './matching.mjs';

export const DOMAIN_NAME = 'session_terms';
export const LOOKUP_TOOL = 'session_terms_lookup';
export const SOURCE_KIND = 'session-terms';

export function emptyState() {
  return { revision: 0, expanded: false, terms: [] };
}

export function renderTerm(term) {
  return JSON.stringify({ id: term.id, name: term.name, note: term.note });
}

/**
 * Model-facing text for one provided term: the name, then the note.
 * Identity travels in the message source, so the model never reads an id.
 * @param {{ name: string, note: string }} term - the term to present.
 * @returns the compact context entry.
 */
export function renderContext(term) {
  return term.note ? `${term.name}\n${term.note}` : term.name;
}

export function matchTerms(text, terms) {
  const ids = new Set(findTermOccurrences(text, terms).map((hit) => hit.term.id));
  return terms.filter((term) => ids.has(term.id));
}

export class TermsError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TermsError';
    this.code = code;
  }
}

function nameOf(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TermsError('invalid-name');
  return value.trim();
}
function noteOf(value) {
  if (typeof value !== 'string') throw new TermsError('invalid-note');
  return value;
}
function colorOf(value) {
  if (value === undefined || value === null) return null;
  if (!isTermColor(value)) throw new TermsError('invalid-color');
  return value.toLowerCase();
}
function checkDuplicate(state, name, except) {
  if (state.terms.some((term) => term.id !== except && term.name === name))
    throw new TermsError('duplicate-name');
}
function requireTerm(state, id) {
  const term = state.terms.find((term) => term.id === id);
  if (!term) throw new TermsError('missing-term');
  return term;
}
function normalize(state) {
  return {
    ...state,
    revision: state.revision + 1,
    terms: state.terms.map((term, order) => ({ ...term, order })),
  };
}

export function changeState(current, action, payload = {}) {
  if (payload.expectedRevision !== undefined && payload.expectedRevision !== current.revision) {
    throw new TermsError('conflict');
  }
  const state = structuredClone(current);
  switch (action) {
    case 'create': {
      const name = nameOf(payload.name),
        note = noteOf(payload.note ?? ''),
        color = colorOf(payload.color);
      checkDuplicate(state, name);
      state.terms.push({
        id: randomUUID(),
        name,
        note,
        color,
        version: 1,
        order: state.terms.length,
      });
      break;
    }
    case 'update': {
      const term = requireTerm(state, payload.id);
      if (payload.expectedVersion !== undefined && payload.expectedVersion !== term.version)
        throw new TermsError('conflict');
      const name = nameOf(payload.name),
        note = noteOf(payload.note),
        color = payload.color === undefined ? (term.color ?? null) : colorOf(payload.color);
      checkDuplicate(state, name, term.id);
      if (term.name === name && term.note === note && (term.color ?? null) === color)
        return current;
      term.name = name;
      term.note = note;
      if (payload.color !== undefined) term.color = color;
      term.version++;
      break;
    }
    case 'delete': {
      requireTerm(state, payload.id);
      state.terms = state.terms.filter((term) => term.id !== payload.id);
      break;
    }
    case 'deleteMany': {
      const ids = payload.ids;
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.some((id) => typeof id !== 'string' || !id) ||
        new Set(ids).size !== ids.length
      )
        throw new TermsError('invalid-selection');
      for (const id of ids) requireTerm(state, id);
      const selected = new Set(ids);
      state.terms = state.terms.filter((term) => !selected.has(term.id));
      break;
    }
    case 'restore': {
      const input = payload.term;
      if (
        !input ||
        typeof input.id !== 'string' ||
        !input.id ||
        !Number.isSafeInteger(input.version) ||
        input.version < 1
      )
        throw new TermsError('invalid-restore');
      const name = nameOf(input.name),
        note = noteOf(input.note),
        color = colorOf(input.color);
      checkDuplicate(state, name);
      if (state.terms.some((term) => term.id === input.id)) throw new TermsError('duplicate-id');
      const index = Number.isSafeInteger(payload.index)
        ? Math.max(0, Math.min(payload.index, state.terms.length))
        : state.terms.length;
      state.terms.splice(index, 0, {
        id: input.id,
        name,
        note,
        ...(input.color === undefined ? {} : { color }),
        version: input.version,
        order: index,
      });
      break;
    }
    case 'clear':
      state.terms = [];
      break;
    case 'reorder': {
      const ids = payload.ids;
      if (
        !Array.isArray(ids) ||
        ids.length !== state.terms.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !state.terms.some((term) => term.id === id))
      )
        throw new TermsError('invalid-order');
      const terms = new Map(state.terms.map((term) => [term.id, term]));
      state.terms = ids.map((id) => terms.get(id));
      break;
    }
    case 'setExpanded': {
      if (typeof payload.expanded !== 'boolean') throw new TermsError('invalid-expanded');
      if (state.expanded === payload.expanded) return current;
      state.expanded = payload.expanded;
      break;
    }
    default:
      throw new TermsError('unknown-action');
  }
  return normalize(state);
}

/**
 * Build the terms store over one storage table.
 *
 * The store is keyed by an opaque terms-library key, not by Session id: several
 * Sessions of one conversation lineage address the same record. Encoding the key
 * for the table is this module's business; callers never see the on-disk name.
 *
 * @param {{ get: (key: string) => unknown, put: (key: string, value: unknown) => Promise<void> }} table
 * @returns the store used by the command, the lookup tool, and the context gate.
 */
export function createTermsRepository(table) {
  const queues = new Map();
  const assertKey = (key) => {
    if (typeof key !== 'string' || !key) throw new TermsError('invalid-session');
  };
  const recordKey = (key) => Buffer.from(key, 'utf8').toString('base64url');
  const get = (key) => {
    assertKey(key);
    return structuredClone(table.get(recordKey(key)) ?? emptyState());
  };
  return {
    get,
    async call(key, action, payload = {}) {
      assertKey(key);
      if (action === 'get') return { ok: true, state: get(key) };
      const preceding = queues.get(key) ?? Promise.resolve();
      const operation = preceding
        .catch(() => {})
        .then(async () => {
          const before = get(key);
          const after = changeState(before, action, payload);
          if (after !== before) await table.put(recordKey(key), after);
          return { ok: true, state: get(key) };
        });
      queues.set(key, operation);
      try {
        return await operation;
      } finally {
        if (queues.get(key) === operation) queues.delete(key);
      }
    },
  };
}
