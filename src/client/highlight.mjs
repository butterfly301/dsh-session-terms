import { findTermOccurrences } from '../matching.mjs';
import { isTermColor } from '../color.mjs';

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
const OBSERVE_OPTIONS = {
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
};
let nextLayer = 0;

function isSource(element, root) {
  if (element.closest(CHAT) !== root || element.closest(EXCLUDED)) return false;
  const kind = element.closest(FLOW)?.getAttribute('data-chat-flow-kind');
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
      if (!isTermColor(hit.term.color)) continue;
      const first = group.nodes.find((part) => part.end > hit.start);
      const last = group.nodes.find((part) => part.end >= hit.end);
      if (!first || !last) continue;
      const range = source.ownerDocument.createRange();
      range.setStart(first.node, hit.start - first.start);
      range.setEnd(last.node, hit.end - last.start);
      colored.push({ color: hit.term.color.toLowerCase(), range });
    }
  }
  return colored;
}

/** Mounted sessions own their ranges. Only changed sources touch the registry. */
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
  const style = doc.createElement('style');
  style.dataset.sessionTermsHighlights = prefix;
  doc.head.append(style);
  const sources = new Map();
  const colors = new Map();
  const dirty = new Set();
  let terms = [],
    signature = '',
    active = false,
    disposed = false,
    timer = null;

  function eligible(source) {
    if (!root.contains(source) || !source.matches(SOURCES) || !isSource(source, root)) return false;
    const parent = source.parentElement?.closest(SOURCES);
    return !parent || !isSource(parent, root);
  }
  function cancelRefresh() {
    if (timer !== null) cancel(timer);
    timer = null;
  }
  function removeSource(source) {
    for (const { color, range } of sources.get(source) ?? [])
      colors.get(color)?.highlight.delete(range);
    sources.delete(source);
  }
  function replaceSource(source) {
    removeSource(source);
    if (!eligible(source)) return;
    const ranges = rangesForTerms(source, terms);
    if (!ranges.length) return;
    sources.set(source, ranges);
    for (const { color, range } of ranges) {
      let layer = colors.get(color);
      if (!layer) {
        const key = `${prefix}${color.slice(1)}`;
        const highlight = new HighlightType();
        highlight.priority = 10;
        layer = { key, highlight };
        colors.set(color, layer);
        registry.set(key, highlight);
      }
      layer.highlight.add(range);
    }
  }
  function syncStyles() {
    const rules = [];
    for (const [color, { key, highlight }] of colors) {
      if (!highlight.size) {
        registry.delete(key);
        colors.delete(color);
      } else rules.push(`::highlight(${key}) { color: ${color}; }`);
    }
    const css = rules.join('\n');
    if (style.textContent !== css) style.textContent = css;
  }
  function flush() {
    cancelRefresh();
    if (disposed || !active) return;
    const pending = [...dirty];
    dirty.clear();
    for (const source of pending) replaceSource(source);
    syncStyles();
  }
  function queueRefresh() {
    if (active && !disposed && dirty.size && timer === null) timer = schedule(flush, 80);
  }
  function markSource(source) {
    if (source && (sources.has(source) || eligible(source))) dirty.add(source);
  }
  function markTree(node) {
    if (node.nodeType !== 1) return;
    if (sources.has(node) || node.matches(SOURCES)) markSource(node);
    for (const source of node.querySelectorAll(SOURCES)) markSource(source);
  }
  function refresh() {
    if (disposed || !active) return;
    for (const source of sources.keys()) dirty.add(source);
    for (const source of root.querySelectorAll(SOURCES)) markSource(source);
    flush();
  }
  const observer = new Observer((mutations) => {
    if (!active || disposed) return;
    for (const mutation of mutations) {
      // Removed ranges must be released even when their former parent is hidden.
      if (mutation.type === 'childList') {
        for (const node of mutation.removedNodes) {
          if (node.nodeType !== 1) continue;
          if (sources.has(node)) dirty.add(node);
          for (const descendant of node.querySelectorAll('*'))
            if (sources.has(descendant)) dirty.add(descendant);
        }
      }
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
        markSource(source);
        source = source.parentElement?.closest(SOURCES);
      }
      if (mutation.type === 'attributes') {
        // Ancestor eligibility changes can invalidate already registered sources.
        for (const cached of sources.keys()) if (element.contains(cached)) dirty.add(cached);
        markTree(element);
      } else if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) markTree(node);
      }
    }
    queueRefresh();
  });
  function deactivate() {
    active = false;
    observer.disconnect();
    cancelRefresh();
    dirty.clear();
    sources.clear();
    for (const { key } of colors.values()) registry.delete(key);
    colors.clear();
    style.textContent = '';
  }
  return {
    supported,
    refresh,
    setTerms(value) {
      if (disposed) return;
      const next = JSON.stringify(
        value
          .map(({ id, name, color }) => [id, name, color ?? null])
          .sort(([a], [b]) => a.localeCompare(b)),
      );
      if (next === signature) return;
      signature = next;
      terms = value;
      if (!terms.some((term) => isTermColor(term.color))) {
        deactivate();
        return;
      }
      if (!active) {
        active = true;
        observer.observe(root, OBSERVE_OPTIONS);
      }
      refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      deactivate();
      terms = [];
      style.remove();
    },
  };
}
