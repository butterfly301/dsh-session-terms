'use strict';
// Run with ELECTRON_RUN_AS_NODE=1 and the installed DSH executable.
// Exercises complete client activation against installed Cordis, SlotRegistry,
// LocaleRuntime and ConversationEventRegistry in an isolated React test DOM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installedClientSources } = require('./installed-client-sources.cjs');
const { selected, loadClient, declaredSlot } = require('./selection-slot-feasibility.cjs');

async function main() {
  const installed = installedClientSources();
  const cordis = installed.runtime('@deepseek-ai/cordis');
  const { ConversationEventRegistry } = installed.load(
    'dsh-client-ui-conversation',
    'src/client/conversation/event-registry.ts',
  );
  const { commandDefinition } = installed.load(
    'dsh-client-ui-chat',
    'src/client/conversation-nodes/command.ts',
  );
  const { React, mount, click, button } = await import('./dom.mjs');
  const { SlotRegistry } = loadClient('dsh-client-ui-renderer', (name) => {
    if (name === '@deepseek-ai/cordis') return cordis;
    if (name === '@deepseek-ai/dsh-client-ui-slots') return { SlotCore: selected.SlotCore };
    return require(name);
  });
  const { LocaleRuntime } = loadClient(
    'dsh-client-locale',
    (name) => {
      // Only the LocaleRuntime export runs. Its settings row and store are unused.
      if (
        name === '@deepseek-ai/dsh-client-ui-primitives' ||
        name === '@deepseek-ai/dsh-client-store'
      )
        return {};
      return require(name);
    },
    { navigator, document },
  );
  const { emptyState, changeState } = await import('../src/terms.mjs');
  const { buildClient } = await import('../scripts/build.mjs');
  const fresh = (await buildClient(undefined, { write: false })).output;
  const bundles = [
    ...(process.argv.includes('--source-only')
      ? []
      : [['published', fs.readFileSync(path.join(__dirname, '../client.js'), 'utf8')]]),
    ['fresh-memory-build', fresh],
  ];
  for (const [label, source] of bundles) {
    let declaration;
    window.__ModuleLoader__ = {
      load(value) {
        declaration = value;
      },
    };
    vm.runInNewContext(source, { window, document, navigator, console, setTimeout, clearTimeout });
    const plugin = declaration.factory((name) => require(name));
    assert(
      plugin.inject.includes('conversation'),
      'Focus must declare its actual Cordis service dependency',
    );
    const root = new cordis.Context();
    let activated = 0,
      focusCalls = 0;
    const apply = plugin.apply;
    plugin.apply = (ctx) => {
      activated++;
      return apply(ctx);
    };
    const sessionContext = {};
    const data = changeState(emptyState(), 'create', { name: 'Inserted term', note: '' });
    let registry;
    let mounted;
    try {
      await root.plugin({
        apply(ctx) {
          new SlotRegistry(ctx);
          ctx.provide('locale', new LocaleRuntime(ctx));
          registry = new ConversationEventRegistry(ctx);
          registry.register(commandDefinition);
          ctx.provide('uiConversation', { events: registry });
          ctx.provide('sessions', {
            binding: (id) => (id === 'session' ? { ctx: sessionContext } : undefined),
          });
          const commands = {
            async execute() {
              return {
                ok: true,
                value: {
                  result: { kind: 'success', text: JSON.stringify({ ok: true, state: data }) },
                },
              };
            },
          };
          ctx.provide('remote', { commands });
          ctx.provide('remote.commands', commands);
        },
      });
      const releaseDock = root.slots.registerFactory(
        {
          name: 'conversation.content',
          scope: 'session-maybe',
          children: {
            'conversation.input.dock': declaredSlot(
              'dsh-client-ui-conversation',
              'conversation.input.dock',
            ),
          },
        },
        () => null,
      );
      const releaseSelection = root.slots.register(
        {
          name: 'root',
          children: {
            'conversation.chat.text-interaction': declaredSlot(
              'dsh-client-ui-chat',
              'conversation.chat.text-interaction',
            ),
          },
        },
        () => null,
      );
      const pending = root.plugin(plugin);
      assert.equal(activated, 0, 'Missing focus service must keep the entire plugin waiting');
      const provideFocus = () =>
        root.plugin({
          apply(ctx) {
            ctx.provide('conversation', {
              input: {
                for(scope) {
                  assert.equal(scope, sessionContext);
                  return {
                    focus() {
                      focusCalls++;
                    },
                  };
                },
              },
            });
          },
        });
      let focusProvider = await provideFocus();
      const consumer = await pending;
      const assertActive = () => {
        assert.equal(document.head.querySelectorAll('style[data-session-terms]').length, 1);
        assert.equal(root.slots.entries('conversation.input.dock').length, 1);
        assert.equal(root.slots.entries('conversation.chat.text-interaction').length, 1);
        assert.equal(
          registry.entries().filter((value) => value.kind === 'session-terms:command-display')
            .length,
          1,
        );
        assert.deepEqual(installed.errors, []);
      };
      assertActive();
      const Dock = root.slots.entries('conversation.input.dock')[0].component;
      const span = { start: 0, end: 0, draftRev: 1 };
      mounted = await mount(
        React.createElement(Dock, {
          sessionId: 'session',
          useSession: (select) => select({ running: true }),
          t: (key) => key,
          inputActions: {
            captureInsertion: () => span,
            insertText: (text, captured) => text === 'Inserted term' && captured === span,
          },
        }),
      );
      await click(button(mounted.container, 'Inserted term'));
      assert.equal(
        focusCalls,
        1,
        'Full mounted client resolves and focuses the actual scoped conversation input',
      );
      await mounted.unmount();
      mounted = undefined;
      await focusProvider.dispose();
      assert.equal(document.head.querySelectorAll('style[data-session-terms]').length, 0);
      assert.equal(root.slots.entries('conversation.input.dock').length, 0);
      assert.equal(
        registry.entries().filter((value) => value.kind === 'session-terms:command-display').length,
        0,
      );
      focusProvider = await provideFocus();
      await consumer.await();
      assert.equal(activated, 2, 'Returning service reactivates the complete plugin');
      assertActive();
      await consumer.dispose();
      assert.equal(document.head.querySelectorAll('style[data-session-terms]').length, 0);
      assert.equal(root.slots.entries('conversation.input.dock').length, 0);
      await focusProvider.dispose();
      await releaseSelection();
      await releaseDock();
      console.log(
        'PASS',
        label,
        'full apply, mounted insertion/focus, service loss/replay and cleanup',
      );
    } finally {
      if (mounted) await mounted.unmount();
      await root.fiber.dispose();
    }
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
