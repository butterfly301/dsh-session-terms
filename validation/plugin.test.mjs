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
