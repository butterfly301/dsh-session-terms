'use strict';
// Read-only installed-runtime probe. Exercises the shipped module factory and
// React action component, without minifier-dependent function extraction.
// The JSDOM renderer verifies behavior, not visual acceptance in the live app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root =
  process.env.DSH_VERIFY_MODULES ||
  'D:/Program Files/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai';

async function main() {
  const { React, mount, click, button } = await import('./dom.mjs');
  const file = path.join(root, 'dsh-message-quotes/lib/client.js');
  assert(fs.statSync(file).size < 256 * 1024, 'Installed quote module read must remain bounded');
  let declaration;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    window: {
      __ModuleLoader__: {
        load(value) {
          declaration = value;
        },
      },
    },
  });
  const plugin = declaration.factory((name) => {
    if (name === '@deepseek-ai/dsh-client-ui-primitives')
      return new Proxy(
        {},
        {
          get(_target, property) {
            throw Error(`Unused primitive requested: ${String(property)}`);
          },
        },
      );
    return require(name);
  });
  let interaction, Action, snapshot;
  let available = true;
  plugin.apply({
    effect(setup) {
      setup();
    },
    locale: { register() {} },
    sessions: {
      binding: () => (available ? { session: { getSnapshot: () => snapshot } } : undefined),
    },
    uiConversation: {
      userText: { register() {} },
      interactions: {
        register(value) {
          interaction = value;
        },
      },
    },
    slots: {
      inject(_name, setup) {
        setup();
      },
      register(options, Component) {
        if (options.name === 'conversation.chat.text-interaction') Action = Component;
      },
    },
  });
  assert(Action && interaction && interaction.id === 'quote');
  const ordinary = { removed: false, subagent: null };
  const continuable = { removed: false, subagent: { address: { mode: 'continuable' } } };
  const oneShot = { removed: false, subagent: { address: { mode: 'one-shot' } } };
  const removed = { removed: true, subagent: null };
  const admit = (value, { trigger = 'selection', text = 'term' } = {}) => {
    snapshot = value;
    let opened = false;
    interaction.onInteraction({
      sessionId: 'session',
      trigger,
      readText: () => text,
      open() {
        opened = true;
      },
    });
    return opened;
  };
  assert(admit(ordinary));
  assert(admit(continuable), 'rc3 continuable snapshots do not need parentAvailable');
  assert(!admit(oneShot));
  assert(!admit(removed));
  assert(!admit(ordinary, { text: null }));
  assert(!admit(ordinary, { trigger: 'contextmenu' }));
  available = false;
  assert(!admit(ordinary));
  available = true;

  async function clickQuote(text, accepted = true, value = ordinary) {
    const calls = [];
    const mounted = await mount(
      React.createElement(Action, {
        useSession: (select) => select(value),
        readText: () => text,
        inputActions: {
          insertQuote(value) {
            calls.push(['insertQuote', value]);
            return accepted;
          },
        },
        clearSelection: () => calls.push(['clearSelection']),
        dismiss: () => calls.push(['dismiss']),
        t: (key) => key,
      }),
    );
    try {
      await click(button(mounted.container, 'quote.add'));
    } finally {
      await mounted.unmount();
    }
    return calls;
  }
  const accepted = [['insertQuote', 'selected term'], ['clearSelection'], ['dismiss']];
  assert.deepEqual(await clickQuote('selected term'), accepted);
  assert.deepEqual(await clickQuote('selected term', true, continuable), accepted);
  assert.deepEqual(await clickQuote('selected term', false), [['insertQuote', 'selected term']]);
  assert.deepEqual(await clickQuote(null), [['dismiss']]);
  console.log(
    JSON.stringify(
      {
        passed: true,
        version: JSON.parse(fs.readFileSync(path.join(root, 'dsh/package.json'), 'utf8')).version,
        checks: [
          'actual installed quote admission accepts current continuable snapshot shape',
          'one-shot, removed, expired, context-menu and missing-session gestures stay closed',
          'actual installed React quote action inserts through public inputActions',
          'accepted quote clears selection and dismisses; rejected insertion retains both',
          'expired selection dismisses without changing the draft',
        ],
        scope: 'installed module factory and React/JSDOM behavior, no live UI mutation',
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
