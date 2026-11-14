import { findTermOccurrences } from '../matching.mjs';

const CHAT = '[data-conversation-region="chat"]';
const FLOW = '[data-chat-flow-kind]';
// DSH 0.2.2-rc.1: streaming Markdown has no public content marker. Keep the
// verified body classes here, and fail closed if the host changes this structure.
const STREAM_BODY = '.xMeOpW_body > ._markdown_rve47_5';
const USER_TEXT = '[data-message-bubble] ._plainRun_fbulu_6';
const SOURCES = `${USER_TEXT}, [data-text-interaction-source], ${STREAM_BODY}`;
const EXCLUDED = [
  'pre',
  '.md-code-block',
  '[data-code-block-content]',
  '[data-code-block-banner]',
  '[role="textbox"]',
  'button',
  'input',
  'textarea',
  'select',
  'script',
  'style',
  '[contenteditable="true"]',
  '[data-composer-seat]',
  '[data-conversation-region="composer"]',
  '[data-text-interaction-exclude]',
  '[data-text-interaction-surface]',
  '[data-variant="think"]',
  '[hidden]',
  '[inert]',
  '[aria-hidden="true"]',
  '.st-root',
].join(',');
const BLOCKS = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'UL',
  'OL',
  'BLOCKQUOTE',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TD',
  'TH',
  'BR',
  'HR',
]);
let nextLayer = 0;

function isSource(element, root) {
  if (element.closest(CHAT) !== root || element.closest(EXCLUDED)) return false;
  const flow = element.closest(FLOW);
  const kind = flow?.getAttribute('data-chat-flow-kind');
  if (element.closest('[data-message-bubble]'))
    return element.matches(USER_TEXT) && (kind === 'user' || kind === 'steering');
  return kind === 'assistant-step';
}

/** Join inline formatting while keeping paragraphs and excluded content separate. */
function textGroups(source) {
  const groups = [];
  let group = { text: '', nodes: [] };
  const flush = () => {
    if (group.text) groups.push(group);
    group = { text: '', nodes: [] };
  };
  function visit(node) {
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? '';
      if (text) {
        group.nodes.push({ node, start: group.text.length, end: group.text.length + text.length });
        group.text += text;
      }
      return;
    }
    if (node.nodeType !== 1) return;
    if (node !== source && (node.matches(EXCLUDED) || node.matches(CHAT) || node.matches(FLOW))) {
      flush();
      return;
    }
    const block = node !== source && BLOCKS.has(node.tagName);
    if (block) flush();
    for (const child of node.childNodes) visit(child);
    if (block) flush();
  }
  visit(source);
  flush();
  return groups;
}

export function rangesForTerms(source, terms) {
  const colored = [];
  for (const group of textGroups(source)) {
    for (const hit of findTermOccurrences(group.text, terms)) {
      const color = hit.term.color;
      if (typeof color !== 'string' || color.length !== 7 || !/^#[0-9a-f]{6}$/i.test(color))
        continue;
      const first = group.nodes.find((part) => part.end > hit.start);
      const last = group.nodes.find((part) => part.end >= hit.end);
      if (!first || !last) continue;
      const range = source.ownerDocument.createRange();
      range.setStart(first.node, hit.start - first.start);
      range.setEnd(last.node, hit.end - last.start);
      colored.push({ color: color.toLowerCase(), range });
    }
  }
  return colored;
}

/** One mounted session owns only its own highlight keys, stylesheet and observer. */
export function createTermHighlighter(root, options = {}) {
  const doc = root?.ownerDocument;
  const view = doc?.defaultView;
  const registry = options.registry ?? view?.CSS?.highlights;
  const HighlightType = options.Highlight ?? view?.Highlight;
  const Observer = options.MutationObserver ?? view?.MutationObserver;
  const schedule = options.setTimeout ?? view?.setTimeout.bind(view);
  const cancel = options.clearTimeout ?? view?.clearTimeout.bind(view);
  const supported = Boolean(root && registry && HighlightType && Observer);
  if (!supported) return { supported: false, setTerms() {}, refresh() {}, dispose() {} };

  const prefix = `session-terms-${++nextLayer}-`;
  const keys = new Set();
  const style = doc.createElement('style');
  style.dataset.sessionTermsHighlights = prefix;
  doc.head.append(style);
  let terms = [],
    signature = '',
    disposed = false,
    timer = null;
  let cache = new Map();
  const dirty = new Set();
  const clear = () => {
    for (const key of keys) registry.delete(key);
    keys.clear();
    style.textContent = '';
  };
  function refresh() {
    if (disposed) return;
    if (timer !== null) cancel(timer);
    timer = null;
    const byColor = new Map();
    const nextCache = new Map();
    if (terms.some((term) => term.color)) {
      for (const source of root.querySelectorAll(SOURCES)) {
        if (!isSource(source, root)) continue;
        // A user bubble may also carry the selection-source marker.
        if (
          source.parentElement?.closest(SOURCES) &&
          isSource(source.parentElement.closest(SOURCES), root)
        )
          continue;
        const previous = cache.get(source);
        const ranges = previous && !dirty.has(source) ? previous : rangesForTerms(source, terms);
        nextCache.set(source, ranges);
        for (const { color, range } of ranges) {
          if (!byColor.has(color)) byColor.set(color, []);
          byColor.get(color).push(range);
        }
      }
    }
    cache = nextCache;
    dirty.clear();
    const rules = [];
    const activeKeys = new Set();
    for (const [color, ranges] of byColor) {
      const key = `${prefix}${color.slice(1)}`;
      const highlight = new HighlightType();
      for (const range of ranges) highlight.add(range);
      highlight.priority = 10;
      registry.set(key, highlight);
      activeKeys.add(key);
      rules.push(`::highlight(${key}) { color: ${color}; }`);
    }
    for (const key of keys) if (!activeKeys.has(key)) registry.delete(key);
    keys.clear();
    for (const key of activeKeys) keys.add(key);
    const css = rules.join('\n');
    if (style.textContent !== css) style.textContent = css;
  }
  function queueRefresh() {
    if (disposed || timer !== null || !terms.some((term) => term.color)) return;
    timer = schedule(refresh, 80);
  }
  function affectedSource(source) {
    if (!source || (!cache.has(source) && (!source.matches(SOURCES) || !isSource(source, root))))
      return false;
    dirty.add(source);
    return true;
  }
  function affectedTree(node) {
    if (node.nodeType !== 1) return false;
    let affected = affectedSource(node);
    for (const source of node.querySelectorAll(SOURCES))
      affected = affectedSource(source) || affected;
    return affected;
  }
  const observer = new Observer((mutations) => {
    let changed = false;
    for (const mutation of mutations) {
      const element =
        mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      if (!element || !root.contains(element)) continue;
      if (mutation.type !== 'attributes') {
        const kind = element.closest(FLOW)?.getAttribute('data-chat-flow-kind');
        if (
          element.closest(CHAT) !== root ||
          element.closest(EXCLUDED) ||
          (kind && !['assistant-step', 'user', 'steering'].includes(kind))
        )
          continue;
      }
      let source = element.closest(SOURCES);
      while (source && root.contains(source)) {
        changed = affectedSource(source) || changed;
        source = source.parentElement?.closest(SOURCES);
      }
      if (mutation.type === 'attributes') {
        // An ancestor's new role/class can exclude previously cached sources.
        for (const cached of cache.keys()) {
          if (element.contains(cached)) {
            dirty.add(cached);
            changed = true;
          }
        }
        changed = affectedTree(element) || changed;
      } else if (mutation.type === 'childList') {
        for (const node of [...mutation.addedNodes, ...mutation.removedNodes])
          changed = affectedTree(node) || changed;
      }
    }
    if (changed) queueRefresh();
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'class',
      'hidden',
      'inert',
      'aria-hidden',
      'contenteditable',
      'role',
      'data-text-interaction-source',
      'data-text-interaction-exclude',
      'data-variant',
      'data-chat-flow-kind',
      'data-conversation-region',
      'data-message-bubble',
      'data-composer-seat',
      'data-text-interaction-surface',
      'data-code-block-content',
      'data-code-block-banner',
    ],
  });
  return {
    supported,
    refresh,
    setTerms(value) {
      const next = JSON.stringify(value.map(({ id, name, color }) => [id, name, color ?? null]));
      if (next === signature) return;
      signature = next;
      terms = value;
      cache.clear();
      refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      if (timer !== null) cancel(timer);
      timer = null;
      cache.clear();
      dirty.clear();
      clear();
      style.remove();
    },
  };
}
