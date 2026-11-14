import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTermHighlighter, rangesForTerms } from '../src/client/highlight.mjs';
import { findTermOccurrences } from '../src/matching.mjs';

const term = (id, name, color = '#123456') => ({ id, name, note: '', color });
const assistant = (html) => `<section data-chat-flow-kind="assistant-step">
  <div data-text-interaction-source="markdown">${html}</div>
</section>`;
const user = (html, kind = 'user') => `<section data-chat-flow-kind="${kind}">
  <div data-message-bubble><div class="_plainRun_fbulu_6">${html}</div></div>
</section>`;

function timers() {
  let next = 0;
  const pending = new Map();
  const cancelled = [];
  return {
    pending,
    cancelled,
    setTimeout(callback, delay) {
      const id = ++next;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      cancelled.push(id);
      pending.delete(id);
    },
    flush() {
      const work = [...pending.values()];
      pending.clear();
      for (const { callback } of work) callback();
    },
  };
}

function fixture(t, html = '') {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <main data-conversation-region="chat">${html}</main>
  </body></html>`);
  const document = dom.window.document;
  const root = document.querySelector('[data-conversation-region="chat"]');
  const registry = new Map();
  const clock = timers();
  class Highlight extends Set {}
  const options = {
    registry,
    Highlight,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  const highlighters = [];
  const mount = (element = root, overrides = {}) => {
    const value = createTermHighlighter(element, { ...options, ...overrides });
    highlighters.push(value);
    return value;
  };
  const settle = async () => {
    // Deliver real JSDOM MutationObserver records before running injected timers.
    await Promise.resolve();
    clock.flush();
    await Promise.resolve();
  };
  t.after(() => {
    for (const highlighter of highlighters) highlighter.dispose();
    dom.window.close();
  });
  return { dom, document, root, registry, clock, options, mount, settle };
}

function painted(registry) {
  return [...registry.values()].flatMap((highlight) =>
    [...highlight].map((range) => range.toString()),
  );
}

function keys(registry) {
  return [...registry.keys()];
}

function styles(document) {
  return [...document.querySelectorAll('style[data-session-terms-highlights]')];
}

test('eligibility attribute changes clear and restore cached prose ranges', async (t) => {
  const f = fixture(t, assistant('<p>API</p>'));
  const highlighter = f.mount();
  highlighter.setTerms([term('api', 'API')]);
  const paragraph = f.root.querySelector('p');
  const flow = f.root.querySelector('[data-chat-flow-kind]');
  for (const [element, name, value] of [
    [paragraph, 'data-text-interaction-exclude', ''],
    [paragraph, 'contenteditable', 'true'],
    [paragraph, 'role', 'textbox'],
    [flow, 'data-variant', 'think'],
    [flow, 'data-chat-flow-kind', 'tool-call'],
    [paragraph, 'data-code-block-content', ''],
  ]) {
    const before = element.getAttribute(name);
    element.setAttribute(name, value);
    await f.settle();
    assert.deepEqual(painted(f.registry), [], name);
    if (before === null) element.removeAttribute(name);
    else element.setAttribute(name, before);
    await f.settle();
    assert.deepEqual(painted(f.registry), ['API'], name);
  }
});

test('tool, reasoning and draft-only streaming do not queue prose refreshes', async (t) => {
  const f = fixture(
    t,
    assistant('<p>API</p><div data-variant="think"><span id="thinking">thought</span></div>') +
      '<div data-chat-flow-kind="tool-call"><span id="tool">output</span></div>' +
      '<div data-conversation-region="composer"><textarea></textarea></div>',
  );
  const highlighter = f.mount();
  highlighter.setTerms([term('api', 'API')]);
  const original = [...f.registry.values()][0];
  for (const selector of ['#thinking', '#tool', 'textarea']) {
    f.root.querySelector(selector).append('API');
    await Promise.resolve();
    assert.equal(f.clock.pending.size, 0, selector);
    assert.equal([...f.registry.values()][0], original);
  }
});

test('matching returns every occurrence with case-sensitive English word boundaries', () => {
  const text = 'API APIClient api xAPI API_ API2 (API) 灯塔，灯塔';
  const hits = findTermOccurrences(text, [term('api', 'API'), term('tower', '灯塔')]);
  assert.deepEqual(
    hits.map(({ term, start, end }) => [term.id, text.slice(start, end)]),
    [
      ['api', 'API'],
      ['api', 'API'],
      ['tower', '灯塔'],
      ['tower', '灯塔'],
    ],
  );
  assert.deepEqual(
    hits.map(({ start }) => start),
    [0, text.indexOf('(API)') + 1, text.indexOf('灯塔'), text.lastIndexOf('灯塔')],
  );
});

test('matching resolves Chinese overlaps longest-first even when the longest term has default color', () => {
  const text = '灯塔计划与灯塔，灯塔计划';
  const short = term('short', '灯塔');
  const long = term('long', '灯塔计划', null);
  assert.deepEqual(
    findTermOccurrences(text, [short, long]).map(({ term }) => term.id),
    ['long', 'short', 'long'],
  );
  assert.deepEqual(
    findTermOccurrences(text, [long, short]).map(({ term }) => term.id),
    ['long', 'short', 'long'],
  );
});

test('DOM ranges cover all occurrences while a default long term suppresses overlapping color', (t) => {
  const f = fixture(t, assistant('<p>灯塔计划与灯塔，灯塔计划。API APIClient api API</p>'));
  const source = f.root.querySelector('[data-text-interaction-source]');
  const ranges = rangesForTerms(source, [
    term('short', '灯塔', '#ABCDEF'),
    term('long', '灯塔计划', null),
    term('api', 'API'),
  ]);
  assert.deepEqual(
    ranges.map(({ color, range }) => [color, range.toString()]),
    [
      ['#abcdef', '灯塔'],
      ['#123456', 'API'],
      ['#123456', 'API'],
    ],
  );
});

test('ranges span inline text nodes with exact endpoints and do not cross paragraphs or breaks', (t) => {
  const f = fixture(
    t,
    assistant(
      '<p id="inline">前 灯<strong>塔</strong>计划 后</p>' +
        '<p>灯</p><p>塔</p><div>灯<br>塔</div>',
    ),
  );
  const source = f.root.querySelector('[data-text-interaction-source]');
  const ranges = rangesForTerms(source, [term('long', '灯塔计划'), term('short', '灯塔')]);
  assert.equal(ranges.length, 1);
  const range = ranges[0].range;
  const paragraph = f.document.querySelector('#inline');
  assert.equal(range.toString(), '灯塔计划');
  assert.equal(range.startContainer, paragraph.firstChild);
  assert.equal(range.startOffset, 2);
  assert.equal(range.endContainer, paragraph.lastChild);
  assert.equal(range.endOffset, 2);
});

test('code blocks, banners, buttons, and excluded gaps cannot contribute ranges', (t) => {
  const f = fixture(
    t,
    assistant(
      '<p>API</p><pre>API</pre>' +
        '<div class="md-code-block"><div data-code-block-banner>API<button>API</button></div>' +
        '<div data-code-block-content>API</div></div>' +
        '<p><button>API</button><span data-code-block-banner>API</span>' +
        '<span data-code-block-content>API</span><span data-text-interaction-exclude>API</span></p>' +
        '<p>灯<button>ignored</button>塔</p><p>API</p>',
    ),
  );
  const highlighter = f.mount();
  highlighter.setTerms([term('api', 'API'), term('tower', '灯塔')]);
  assert.deepEqual(painted(f.registry), ['API', 'API']);
});

test('only user and assistant content in the owning chat flow is highlighted', (t) => {
  const f = fixture(
    t,
    user('API') +
      user('API', 'steering') +
      assistant(
        '<p>API</p><aside data-conversation-region="chat">' + assistant('API') + '</aside>',
      ) +
      '<section data-chat-flow-kind="reasoning"><div data-text-interaction-source>API</div></section>' +
      '<section data-chat-flow-kind="tool"><div data-text-interaction-source>API</div></section>' +
      assistant(
        '<div data-variant="think"><div data-text-interaction-source>API</div></div>' +
          '<section data-chat-flow-kind="tool"><div data-text-interaction-source>API</div></section>',
      ) +
      '<div data-text-interaction-source>API</div>' +
      '<section data-conversation-region="composer" data-composer-seat>' +
      assistant('API') +
      '</section>' +
      '<div contenteditable="true">' +
      assistant('API') +
      '</div>' +
      '<aside data-conversation-region="chat">' +
      assistant('API') +
      user('API') +
      '</aside>',
  );
  f.mount().setTerms([term('api', 'API')]);
  assert.deepEqual(painted(f.registry), ['API', 'API', 'API']);
  for (const highlight of f.registry.values()) {
    for (const range of highlight) {
      const element = range.startContainer.parentElement;
      assert.equal(element.closest('[data-conversation-region="chat"]'), f.root);
      assert.ok(
        ['user', 'steering', 'assistant-step'].includes(
          element.closest('[data-chat-flow-kind]').getAttribute('data-chat-flow-kind'),
        ),
      );
    }
  }
});

test('user source is only the host plain text run, excluding JSON and reference labels', (t) => {
  const f = fixture(
    t,
    `<section data-chat-flow-kind="user">
    <div data-message-bubble data-text-interaction-source="user">
      <div class="_plainRun_fbulu_6" data-text-interaction-source="user">API API</div>
      <div class="reference-label">API</div>
      <div data-text-interaction-source="json"><code>{"API":"API"}</code></div>
      <button>API</button>
    </div>
  </section>`,
  );
  f.mount().setTerms([term('api', 'API')]);
  assert.deepEqual(painted(f.registry), ['API', 'API']);
  for (const highlight of f.registry.values())
    for (const range of highlight)
      assert.ok(range.startContainer.parentElement.closest('._plainRun_fbulu_6'));
});

test('streaming assistant Markdown uses the pinned direct body structure without source markers', (t) => {
  const f = fixture(
    t,
    `<section data-chat-flow-kind="assistant-step">
    <div class="xMeOpW_body"><div class="_markdown_rve47_5"><p>API API</p></div></div>
    <div class="_markdown_rve47_5">API</div>
    <div class="xMeOpW_body"><div><div class="_markdown_rve47_5">API</div></div></div>
  </section>`,
  );
  assert.equal(f.root.querySelector('[data-text-interaction-source]'), null);
  f.mount().setTerms([term('api', 'API')]);
  assert.deepEqual(painted(f.registry), ['API', 'API']);
});

test('real observer refreshes character data, replaced nodes, and hidden rerenders', async (t) => {
  const f = fixture(t, assistant('<p id="message">API</p>'));
  f.mount().setTerms([term('api', 'API')]);
  const paragraph = f.document.querySelector('#message');
  const text = paragraph.firstChild;
  text.nodeValue = 'API API';
  await f.settle();
  assert.deepEqual(painted(f.registry), ['API', 'API']);
  paragraph.innerHTML = '<em>API</em>';
  await f.settle();
  assert.deepEqual(painted(f.registry), ['API']);
  assert.equal(
    [...f.registry.values()][0].values().next().value.startContainer,
    paragraph.firstChild.firstChild,
  );
  paragraph.hidden = true;
  await f.settle();
  assert.equal(f.registry.size, 0);
  paragraph.hidden = false;
  await f.settle();
  assert.deepEqual(painted(f.registry), ['API']);
  const source = f.root.querySelector('[data-text-interaction-source]');
  source.outerHTML = '<div data-text-interaction-source="markdown"><p>API API API</p></div>';
  await f.settle();
  assert.deepEqual(painted(f.registry), ['API', 'API', 'API']);
  assert.equal(f.clock.pending.size, 0);
});

test('inert and aria-hidden rerenders remove and restore eligible content', async (t) => {
  const f = fixture(t, assistant('<p>API</p>'));
  f.mount().setTerms([term('api', 'API')]);
  const flow = f.root.firstElementChild;
  for (const [attribute, value] of [
    ['inert', ''],
    ['aria-hidden', 'true'],
  ]) {
    flow.setAttribute(attribute, value);
    await f.settle();
    assert.equal(f.registry.size, 0);
    flow.removeAttribute(attribute);
    await f.settle();
    assert.deepEqual(painted(f.registry), ['API']);
  }
});

test('color changes, defaults, and term deletion remove obsolete registry keys and CSS', (t) => {
  const f = fixture(t, assistant('<p>API</p>'));
  const highlighter = f.mount();
  highlighter.setTerms([term('api', 'API', '#ABCDEF')]);
  const originalKey = keys(f.registry)[0];
  assert.ok(originalKey.endsWith('-abcdef'));
  assert.match(styles(f.document)[0].textContent, /color: #abcdef;/);
  highlighter.setTerms([term('api', 'API', '#112233')]);
  assert.equal(f.registry.has(originalKey), false);
  assert.equal(f.registry.size, 1);
  assert.ok(keys(f.registry)[0].endsWith('-112233'));
  assert.doesNotMatch(styles(f.document)[0].textContent, /abcdef/);
  highlighter.setTerms([term('api', 'API', null)]);
  assert.equal(f.registry.size, 0);
  assert.equal(styles(f.document)[0].textContent, '');
  highlighter.setTerms([term('api', 'API')]);
  assert.equal(f.registry.size, 1);
  highlighter.setTerms([]);
  assert.equal(f.registry.size, 0);
  assert.equal(styles(f.document)[0].textContent, '');
});

test('multiple session layers coexist and dispose preserves dictionary and other session highlights', (t) => {
  const f = fixture(t, assistant('<p>API</p>'));
  const secondRoot = f.document.createElement('main');
  secondRoot.setAttribute('data-conversation-region', 'chat');
  secondRoot.innerHTML = assistant('<p>API API</p>');
  f.document.body.append(secondRoot);
  const dictionary = new Set();
  f.registry.set('dictionary-selection', dictionary);
  const first = f.mount();
  const second = f.mount(secondRoot);
  first.setTerms([term('first', 'API')]);
  const firstKey = keys(f.registry).find((key) => key !== 'dictionary-selection');
  second.setTerms([term('second', 'API')]);
  const secondKey = keys(f.registry).find(
    (key) => key !== 'dictionary-selection' && key !== firstKey,
  );
  assert.ok(firstKey && secondKey && firstKey !== secondKey);
  assert.equal(f.registry.get(firstKey).size, 1);
  assert.equal(f.registry.get(secondKey).size, 2);
  assert.equal(styles(f.document).length, 2);
  assert.equal(f.registry.get(firstKey).priority, 10);
  first.dispose();
  assert.equal(f.registry.has(firstKey), false);
  assert.equal(f.registry.get(secondKey).size, 2);
  assert.equal(f.registry.get('dictionary-selection'), dictionary);
  assert.equal(styles(f.document).length, 1);
  second.dispose();
  assert.deepEqual(keys(f.registry), ['dictionary-selection']);
  assert.equal(styles(f.document).length, 0);
});

test('dispose disconnects the observer, cancels pending work, and prevents late updates', async (t) => {
  const f = fixture(t, assistant('<p>API</p>'));
  const highlighter = f.mount();
  highlighter.setTerms([term('api', 'API')]);
  const paragraph = f.root.querySelector('p');
  paragraph.firstChild.nodeValue = 'API API';
  await Promise.resolve();
  assert.equal(f.clock.pending.size, 1);
  const [timerId, timer] = [...f.clock.pending.entries()][0];
  assert.equal(timer.delay, 80);
  highlighter.dispose();
  assert.ok(f.clock.cancelled.includes(timerId));
  assert.equal(f.clock.pending.size, 0);
  assert.equal(f.registry.size, 0);
  assert.equal(styles(f.document).length, 0);
  // A callback already handed to an event loop must also be harmless after disposal.
  timer.callback();
  highlighter.refresh();
  highlighter.setTerms([term('late', 'API', '#654321')]);
  paragraph.textContent = 'API';
  await f.settle();
  assert.equal(f.clock.pending.size, 0);
  assert.equal(f.registry.size, 0);
  assert.equal(styles(f.document).length, 0);
  highlighter.dispose();
});

test('unsupported Highlight API is a safe no-op with no observer, timer, style, or registry changes', async (t) => {
  const f = fixture(t, assistant('<p>API</p>'));
  const dictionary = new Set();
  f.registry.set('dictionary-selection', dictionary);
  const highlighter = f.mount(f.root, { Highlight: undefined });
  assert.equal(highlighter.supported, false);
  highlighter.setTerms([term('api', 'API')]);
  highlighter.refresh();
  f.root.querySelector('p').textContent = 'API API';
  await f.settle();
  highlighter.dispose();
  assert.deepEqual(keys(f.registry), ['dictionary-selection']);
  assert.equal(f.registry.get('dictionary-selection'), dictionary);
  assert.equal(f.clock.pending.size, 0);
  assert.equal(styles(f.document).length, 0);
});
