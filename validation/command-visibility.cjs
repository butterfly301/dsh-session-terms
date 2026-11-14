'use strict';

// Run with the installed Electron runtime. The stock registry, assembler,
// command definition and Chat snapshot builder are compiled from installed
// source, rather than extracted from minifier-dependent bundle markers.
const assert = require('node:assert/strict');
const { installedClientSources } = require('./installed-client-sources.cjs');

async function main() {
  const host = installedClientSources();
  const { Context } = host.runtime('@deepseek-ai/cordis');
  const { ConversationEventRegistry } = host.load(
    'dsh-client-ui-conversation',
    'src/client/conversation/event-registry.ts',
  );
  const { ConversationNodeAssembler } = host.load(
    'dsh-client-ui-conversation',
    'src/client/conversation/assembler.ts',
  );
  const { commandDefinition } = host.load(
    'dsh-client-ui-chat',
    'src/client/conversation-nodes/command.ts',
  );
  const { chatViewDefinition } = host.load(
    'dsh-client-ui-chat',
    'src/client/conversation-nodes/chat-snapshot-builder.ts',
  );
  const { hideTermsCommands } = await import('../src/client/host.mjs');
  const ctx = new Context();
  const registry = new ConversationEventRegistry(ctx);
  const assembler = new ConversationNodeAssembler(registry, {
    entries: () => [chatViewDefinition],
  });
  let alive = true;
  let queued = false;
  const unsubscribe = registry.subscribe(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (alive) {
        assembler.rebuildRegistry();
        assembler.flush();
      }
    });
  });
  const checks = [];
  const visible = () => {
    const snapshot = assembler.snapshot('chat');
    return snapshot.order.map((key) => snapshot.nodes.get(key));
  };
  const names = () =>
    visible().map((node) =>
      node.kind === 'manual-compaction' ? node.data.command.name : node.data.name,
    );
  async function settled() {
    await Promise.resolve();
    await Promise.resolve();
    assembler.flush();
    assert.deepEqual(
      host.errors.map((error) => error.message),
      [],
    );
  }
  async function check(name, run) {
    await run();
    checks.push(name);
  }
  function lifecycle(name, commandId, seq, kind = 'success') {
    return [
      {
        type: 'event',
        event: {
          type: 'command/run',
          seq,
          time: seq,
          data: { name, commandId, source: { kind: 'user' } },
        },
      },
      {
        type: 'event',
        event: {
          type: 'command/done',
          seq: seq + 1,
          time: seq + 1,
          data: { commandId, kind, text: '{"ok":true}' },
        },
      },
    ];
  }
  let removeStock = registry.register(commandDefinition);
  let removeFilter;
  try {
    assembler.replaceWindow(lifecycle('session-terms', 'initial', 1), false);
    assembler.activateTarget('chat');
    await check('unloaded plugin reproduces visible historical sync receipt', async () => {
      assert.deepEqual(names(), ['session-terms']);
    });
    await check(
      'loading visibility contribution removes historical sync rows without changing the log',
      async () => {
        removeFilter = hideTermsCommands(registry);
        await settled();
        assert.deepEqual(names(), []);
        const stored = assembler.snapshot('chat').nodes.values();
        assert.equal(stored.length, 1);
        assert.equal(stored[0].visibility, 'hidden');
        assert.equal(stored[0].data.outcome.text, '{"ok":true}');
      },
    );
    await check('repeated reads remain hidden through actual incremental dispatch', async () => {
      for (let i = 0; i < 12; i++) {
        for (const entry of lifecycle('session-terms', `read-${i}`, 3 + i * 2))
          assembler.append(entry);
        assembler.flush();
        assert.deepEqual(names(), []);
      }
    });
    await check(
      'ordinary and manual-compaction commands retain stock data and visibility',
      async () => {
        for (const entry of lifecycle('feedback', 'feedback', 30)) assembler.append(entry);
        for (const entry of lifecycle('compact', 'compact', 32)) assembler.append(entry);
        assembler.flush();
        assert.deepEqual(names(), ['feedback', 'compact']);
        assert.equal(visible()[1].kind, 'manual-compaction');
      },
    );
    await check(
      'failed internal receipts stay hidden while unrelated errors remain visible',
      async () => {
        for (const entry of lifecycle('session-terms', 'failed-sync', 34, 'error'))
          assembler.append(entry);
        for (const entry of lifecycle('feedback', 'failed-feedback', 36, 'error'))
          assembler.append(entry);
        assembler.flush();
        assert.deepEqual(names(), ['feedback', 'compact', 'feedback']);
        assert.equal(visible().at(-1).data.outcome.kind, 'error');
      },
    );
    await check('stock withdrawal and remount rebuild the same hidden history', async () => {
      removeStock();
      await settled();
      assert.equal(
        registry.entries().some((item) => item.kind === 'session-terms:command-display'),
        false,
      );
      removeStock = registry.register({ ...commandDefinition });
      await settled();
      assert.deepEqual(names(), ['feedback', 'compact', 'feedback']);
    });
    await check(
      'filter unload and reinstall restore and re-hide only internal receipts',
      async () => {
        removeFilter();
        await settled();
        assert(names().includes('session-terms'));
        removeFilter = hideTermsCommands(registry);
        await settled();
        assert.deepEqual(names(), ['feedback', 'compact', 'feedback']);
        assert.equal(
          registry.entries().filter((item) => item.kind === 'session-terms:command-display').length,
          1,
        );
      },
    );
    await check(
      'partial history waits for the real run name before hiding a nameless result',
      async () => {
        const entries = lifecycle('session-terms', 'paged', 50);
        assembler.replaceWindow([entries[1]], true);
        assembler.flush();
        assert.deepEqual(names(), [null]);
        assembler.prepend([entries[0]], false);
        assembler.flush();
        assert.deepEqual(names(), []);
      },
    );
    await check(
      'delayed stock registration replays the loaded window once contributions are ready',
      async () => {
        removeStock();
        await settled();
        assembler.replaceWindow(lifecycle('session-terms', 'late', 60), false);
        assembler.flush();
        removeStock = registry.register(commandDefinition);
        await settled();
        assert.deepEqual(names(), []);
        assert.equal(
          registry.entries().filter((item) => item.kind === 'session-terms:command-display').length,
          1,
        );
      },
    );
    console.log(
      JSON.stringify(
        {
          passed: true,
          checks,
          scope:
            'actual installed Cordis registry, event dispatcher, assembler and Chat snapshot builder; no live UI calls or profile changes',
        },
        null,
        2,
      ),
    );
  } finally {
    alive = false;
    unsubscribe();
    removeFilter?.();
    removeStock();
    await ctx.fiber.dispose();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
