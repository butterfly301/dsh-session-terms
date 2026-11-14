import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { React, mount, click, input, button } from './dom.mjs';
import { createClientPlugin } from '../src/client/plugin.mjs';
import { createTermsRequest } from '../src/client/host.mjs';
import { changeState, emptyState } from '../src/terms.mjs';

function host() {
  let data = emptyState();
  const disposers = [];
  const slots = new Map();
  const calls = [];
  const definitions = [];
  const listeners = new Set();
  const ctx = {
    effect(setup) {
      const dispose = setup();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    remote: {
      commands: {
        async execute(sessionId, raw, attachments) {
          calls.push({ sessionId, raw, attachments });
          const { action, payload } = JSON.parse(raw.slice('/session-terms '.length));
          let result;
          try {
            if (action !== 'get') data = changeState(data, action, payload);
            result = { ok: true, state: data };
          } catch (error) {
            result = { ok: false, code: error.code };
          }
          return { ok: true, value: { result: { kind: 'success', text: JSON.stringify(result) } } };
        },
      },
    },
    locale: {
      register() {
        return () => {};
      },
    },
    sessions: { binding: () => null },
    uiConversation: {
      events: {
        entries: () => definitions,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
    slots: {
      inject(_name, register) {
        const dispose = register();
        if (dispose) disposers.push(dispose);
      },
      register(options, Component) {
        slots.set(options.name, { options, Component });
        return () => slots.delete(options.name);
      },
    },
  };
  return {
    ctx,
    slots,
    calls,
    data: () => data,
    listenerCount: () => listeners.size,
    dispose() {
      for (const dispose of disposers.toReversed()) dispose();
    },
  };
}

const session = (select) => select({ running: true, removed: false, subagent: null });

test('collapsed dock reports insertion failures locally and clears the notice after recovery', async () => {
  const current = host();
  await current.ctx.remote.commands.execute(
    'session',
    '/session-terms ' + JSON.stringify({ action: 'create', payload: { name: 'Alpha', note: '' } }),
    [],
  );
  createClientPlugin({ React, resources: { dictionaries: {}, errorCodes: [] }, styles: '' }).apply(
    current.ctx,
  );
  const Dock = current.slots.get('conversation.input.dock').Component;
  let available = false;
  const mounted = await mount(
    React.createElement(Dock, {
      sessionId: 'session',
      useSession: session,
      t: (key) => key,
      inputActions: { captureInsertion: () => ({}), insertText: () => available },
    }),
  );
  try {
    assert.equal(
      mounted.container.querySelector('.st-root').getAttribute('data-expanded'),
      'false',
    );
    await click(button(mounted.container, 'Alpha'));
    assert.equal(mounted.container.querySelector('[role="alert"]')?.textContent, 'insertFailed');
    assert.equal(mounted.container.textContent.includes('{"ok"'), false);
    available = true;
    await click(button(mounted.container, 'Alpha'));
    assert.equal(mounted.container.querySelector('[role="alert"]'), null);
  } finally {
    await mounted.unmount();
    current.dispose();
  }
});

test('actual registered selection actions leave the editor in the dock after dismissal', async () => {
  const current = host();
  createClientPlugin({
    React,
    resources: { dictionaries: {}, errorCodes: [] },
    styles: '.st-root { color: red; }',
  }).apply(current.ctx);
  const Dock = current.slots.get('conversation.input.dock').Component;
  const Actions = current.slots.get('conversation.chat.text-interaction').Component;
  assert.equal(current.slots.get('conversation.chat.text-interaction').options.priority, -100);
  let selectionCleared = false;
  function Conversation() {
    const [showActions, setShowActions] = React.useState(true);
    const shared = { sessionId: 'session', useSession: session, t: (key) => key };
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(Dock, shared),
      showActions
        ? React.createElement(Actions, {
            ...shared,
            readText: () => 'Selected term',
            clearSelection() {
              selectionCleared = true;
            },
            dismiss: () => setShowActions(false),
            inputActions: { insertQuote: () => true },
          })
        : null,
    );
  }
  const mounted = await mount(React.createElement(Conversation));
  try {
    assert.equal(document.head.querySelectorAll('style[data-session-terms]').length, 1);
    await click(button(mounted.container, 'pin'));
    assert.equal(selectionCleared, true);
    assert.equal(mounted.container.querySelector('.st-selection-actions'), null);
    assert.equal(mounted.container.querySelector('dialog input').value, 'Selected term');
    await click(button(mounted.container, 'save'));
    assert.equal(current.data().terms[0].name, 'Selected term');
    assert.equal(mounted.container.querySelector('dialog'), null);
    assert(
      current.calls.every((call) => call.sessionId === 'session' && call.attachments.length === 0),
    );
  } finally {
    await mounted.unmount();
    current.dispose();
  }
  assert.equal(current.listenerCount(), 0);
  assert.equal(current.slots.size, 0);
  assert.equal(document.head.querySelectorAll('style[data-session-terms]').length, 0);
});

test('new selections replace the open draft and session switches isolate dock state', async () => {
  const current = host();
  createClientPlugin({ React, resources: { dictionaries: {}, errorCodes: [] }, styles: '' }).apply(
    current.ctx,
  );
  const Dock = current.slots.get('conversation.input.dock').Component;
  const Actions = current.slots.get('conversation.chat.text-interaction').Component;
  let showSelection, changeSession, selectedText;
  function Conversation() {
    const [showActions, setShowActions] = React.useState(false);
    const [sessionId, setSessionId] = React.useState('A');
    showSelection = (text) => {
      selectedText = text;
      setShowActions(true);
    };
    changeSession = setSessionId;
    const shared = { sessionId, useSession: session, t: (key) => key };
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(Dock, shared),
      showActions
        ? React.createElement(Actions, {
            ...shared,
            readText: () => selectedText,
            clearSelection() {},
            dismiss: () => setShowActions(false),
            inputActions: { insertQuote: () => true },
          })
        : null,
    );
  }
  const mounted = await mount(React.createElement(Conversation));
  try {
    await click(button(mounted.container, 'add'));
    assert.equal(mounted.container.querySelector('dialog input').value, '');
    await React.act(async () => {
      showSelection('Alpha');
    });
    await click(button(mounted.container, 'pin'));
    assert.equal(mounted.container.querySelector('dialog input').value, 'Alpha');
    await input(mounted.container.querySelector('textarea'), 'Alpha draft');
    await React.act(async () => {
      showSelection('Beta');
    });
    await click(button(mounted.container, 'pin'));
    assert.equal(mounted.container.querySelector('dialog input').value, 'Beta');
    assert.equal(mounted.container.querySelector('textarea').value, '');
    await click(button(mounted.container, 'save'));
    assert.deepEqual(
      current.data().terms.map((term) => term.name),
      ['Beta'],
    );
    assert.equal(mounted.container.querySelector('dialog'), null);
    await click(button(mounted.container, 'add'));
    await React.act(async () => {
      changeSession('B');
    });
    assert.equal(mounted.container.querySelector('dialog'), null);
  } finally {
    await mounted.unmount();
    current.dispose();
  }
});

test('registered dock scopes colors to its session and releases highlights when sessions change', async () => {
  const previousCSS = window.CSS;
  const previousHighlight = window.Highlight;
  const highlights = new Map([['other-plugin', new Set()]]);
  window.CSS = { highlights };
  window.Highlight = class extends Set {};
  const current = host();
  await current.ctx.remote.commands.execute(
    'A',
    '/session-terms ' +
      JSON.stringify({
        action: 'create',
        payload: { name: '灯塔', note: 'test', color: '#2868b4' },
      }),
    [],
  );
  createClientPlugin({ React, resources: { dictionaries: {}, errorCodes: [] }, styles: '' }).apply(
    current.ctx,
  );
  const Dock = current.slots.get('conversation.input.dock').Component;
  let changeSession;
  function Conversation() {
    const [sessionId, setSessionId] = React.useState('A');
    changeSession = setSessionId;
    return React.createElement(
      'div',
      { 'data-conversation-region': 'chat', 'data-conversation-session': sessionId },
      React.createElement(
        'div',
        { 'data-chat-flow-kind': 'user' },
        React.createElement(
          'div',
          { 'data-message-bubble': '' },
          React.createElement('span', { className: '_plainRun_fbulu_6' }, '灯塔'),
        ),
      ),
      React.createElement(
        'div',
        { 'data-conversation-region': 'composer' },
        React.createElement(Dock, { sessionId, useSession: session, t: (key) => key }),
      ),
    );
  }
  const mounted = await mount(React.createElement(Conversation));
  try {
    const ownedKeys = () =>
      [...highlights.keys()].filter((key) => key.startsWith('session-terms-'));
    assert.equal(ownedKeys().length, 1);
    const initial = ownedKeys()[0];
    assert.equal([...highlights.get(initial)][0].toString(), '灯塔');
    assert.equal(mounted.container.querySelector('.st-chip').style.color, 'rgb(40, 104, 180)');
    await React.act(async () => {
      changeSession('B');
    });
    assert.equal(highlights.has(initial), false);
    assert.equal(ownedKeys().length, 1);
    assert.equal(document.head.querySelectorAll('[data-session-terms-highlights]').length, 1);
  } finally {
    await mounted.unmount();
    current.dispose();
    window.CSS = previousCSS;
    window.Highlight = previousHighlight;
  }
  assert.deepEqual([...highlights.keys()], ['other-plugin']);
  assert.equal(document.head.querySelectorAll('[data-session-terms-highlights]').length, 0);
});

test('successful chip insertion returns focus through the rc3 conversation service', async () => {
  const current = host();
  await current.ctx.remote.commands.execute(
    'session',
    '/session-terms ' +
      JSON.stringify({
        action: 'create',
        payload: { name: 'Inserted term', note: '' },
      }),
    [],
  );
  const sessionContext = {};
  const calls = [];
  current.ctx.sessions.binding = (id) => (id === 'session' ? { ctx: sessionContext } : undefined);
  let unavailable = false;
  current.ctx.conversation = {
    input: {
      for(scope) {
        assert.equal(scope, sessionContext);
        return {
          focus() {
            calls.push('focus');
            if (unavailable) throw Error('unavailable');
          },
        };
      },
    },
  };
  const plugin = createClientPlugin({
    React,
    resources: { dictionaries: {}, errorCodes: [] },
    styles: '',
  });
  assert(
    plugin.inject.includes('conversation'),
    'Cordis must admit access to the conversation service',
  );
  plugin.apply(current.ctx);
  const Dock = current.slots.get('conversation.input.dock').Component;
  const span = { start: 1, end: 1, draftRev: 4 };
  const mounted = await mount(
    React.createElement(Dock, {
      sessionId: 'session',
      useSession: session,
      t: (key) => key,
      inputActions: {
        captureInsertion: () => span,
        insertText(text, captured) {
          assert.equal(text, 'Inserted term');
          assert.equal(captured, span);
          calls.push('insert');
          return true;
        },
      },
    }),
  );
  try {
    await click(button(mounted.container, 'Inserted term'));
    assert.deepEqual(calls, ['insert', 'focus']);
    unavailable = true;
    await click(button(mounted.container, 'Inserted term'));
    assert.deepEqual(calls, ['insert', 'focus', 'insert', 'focus']);
  } finally {
    await mounted.unmount();
    current.dispose();
  }
});

test('rc3 continuable sessions admit selection actions without the removed parentAvailable field', async () => {
  const current = host();
  createClientPlugin({ React, resources: { dictionaries: {}, errorCodes: [] }, styles: '' }).apply(
    current.ctx,
  );
  const Actions = current.slots.get('conversation.chat.text-interaction').Component;
  let show;
  let dismissals = 0;
  let inserted;
  function Conversation() {
    const [snapshot, setSnapshot] = React.useState({
      removed: false,
      subagent: { address: { mode: 'continuable' } },
    });
    const [visible, setVisible] = React.useState(true);
    show = (value) => {
      setSnapshot(value);
      setVisible(true);
    };
    return visible
      ? React.createElement(Actions, {
          sessionId: 'child',
          useSession: (select) => select(snapshot),
          t: (key) => key,
          readText: () => 'Selected child term',
          clearSelection() {},
          dismiss() {
            dismissals++;
            setVisible(false);
          },
          inputActions: {
            insertQuote(text) {
              inserted = text;
              return true;
            },
          },
        })
      : null;
  }
  const mounted = await mount(React.createElement(Conversation));
  try {
    assert(button(mounted.container, 'pin'));
    await click(button(mounted.container, 'quoteText'));
    assert.equal(inserted, 'Selected child term');
    assert.equal(dismissals, 1);
    await React.act(async () => {
      show({ removed: false, subagent: { address: { mode: 'one-shot' } } });
    });
    assert.equal(mounted.container.querySelector('.st-selection-actions'), null);
    assert.equal(dismissals, 2);
    await React.act(async () => {
      show({ removed: true, subagent: null });
    });
    assert.equal(mounted.container.querySelector('.st-selection-actions'), null);
    assert.equal(dismissals, 3);
    await React.act(async () => {
      show({ removed: false, subagent: null });
    });
    assert(button(mounted.container, 'pin'));
  } finally {
    await mounted.unmount();
    current.dispose();
  }
});

test('published artifact registers successfully and requests only the host React module', async () => {
  let declaration;
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(value) {
          declaration = value;
        },
      },
    },
  });
  assert.equal(declaration.id, '@fairyonthetree/dsh-session-terms');
  const requested = [];
  const plugin = declaration.factory((name) => {
    requested.push(name);
    return React;
  });
  assert.deepEqual(requested, ['react']);
  assert(plugin.inject.includes('remote.commands'));
});

test('transport adapter normalizes missing commands, failed responses, and thrown errors', async () => {
  assert.deepEqual(await createTermsRequest(null)('s', 'get'), { ok: false, code: 'transport' });
  assert.deepEqual(await createTermsRequest({ execute: async () => ({ ok: false }) })('s', 'get'), {
    ok: false,
    code: 'transport',
  });
  assert.deepEqual(
    await createTermsRequest({
      execute: async () => {
        throw Error('private details');
      },
    })('s', 'get'),
    { ok: false, code: 'failed' },
  );
  const malformed = {
    execute: async () => ({ ok: true, value: { result: { kind: 'success', text: '{' } } }),
  };
  assert.deepEqual(await createTermsRequest(malformed)('s', 'get'), { ok: false, code: 'failed' });
});
