'use strict';

// Run with ELECTRON_RUN_AS_NODE=1 and the installed DSH Electron executable.
// This test reads the packaged implementation and the current client wrapper.
// It performs no live application calls and writes no files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const { hideTermsCommands } = await import('../src/client/host.mjs');
  const modules =
    process.env.DSH_VERIFY_MODULES ||
    'D:/Program Files/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai';
  const chatPath = path.join(modules, 'dsh-client-ui-chat/lib/client.js');
  const conversationPath = path.join(modules, 'dsh-client-ui-conversation/lib/client.js');
  const chatSource = fs.readFileSync(chatPath, 'utf8');
  const conversationSource = fs.readFileSync(conversationPath, 'utf8');

  function section(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
    assert.equal(
      source.indexOf(startMarker, start + startMarker.length),
      -1,
      `Ambiguous source marker: ${startMarker}`,
    );
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(end, -1, `Missing source end marker: ${endMarker}`);
    return source.slice(start, end);
  }

  // Load the actual stock definition and all its helpers from the installed build.
  const commonHelpers = section(
    chatSource,
    'function contextLocation(context)',
    '//#region lib/types/client/conversation-nodes/event-projection.js',
  );
  const surfaceHelpers = section(
    chatSource,
    'const SURFACE_EVENT_TYPES =',
    '//#region lib/types/client/conversation-nodes/command.js',
  );
  const stockSource = section(
    chatSource,
    'const COMPACT_KIND = "compact-checkpoint"',
    '//#region lib/types/client/conversation-nodes/compaction.js',
  );
  const stock = new Function(
    `${commonHelpers}\n${surfaceHelpers}\n${stockSource}\nreturn commandDefinition;`,
  )();

  // Execute the real registration lifecycle, including the stock arriving later.
  function installVisibility(initialDefinitions = []) {
    const definitions = [...initialDefinitions],
      listeners = new Set(),
      disposers = [];
    let registrations = 0;
    const notify = () => {
      for (const listener of [...listeners]) listener();
    };
    const registry = {
      entries: () => [...definitions],
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      register(definition) {
        assert(
          !definitions.some((item) => item.kind === definition.kind),
          'no duplicate definition kind',
        );
        definitions.push(definition);
        registrations++;
        notify();
        return () => {
          const index = definitions.indexOf(definition);
          if (index >= 0) {
            definitions.splice(index, 1);
            notify();
          }
        };
      },
    };
    disposers.push(hideTermsCommands(registry));
    return {
      registry,
      definitions,
      registrations: () => registrations,
      wrapper: () => definitions.find((item) => item.kind === 'session-terms:command-display'),
      dispose: () => {
        for (const dispose of disposers.toReversed()) dispose();
      },
    };
  }
  const late = installVisibility();
  assert.equal(late.wrapper(), undefined);
  const removeLateStock = late.registry.register(stock);
  assert.ok(
    late.wrapper(),
    'stock registered after plugin activation must still install visibility filtering',
  );
  removeLateStock();
  assert.equal(late.wrapper(), undefined, 'stock removal also removes its dependent wrapper');
  late.registry.register(stock);
  assert.ok(late.wrapper(), 'stock remount restores filtering');
  late.dispose();
  assert.equal(late.wrapper(), undefined, 'plugin unload removes its wrapper');
  const mounted = installVisibility([stock]);
  const wrapper = mounted.wrapper();
  assert.ok(wrapper, 'the current client must register its visibility wrapper');
  assert.notEqual(wrapper.kind, stock.kind, 'the wrapper owns a distinct context kind');
  assert.equal(wrapper.target, 'chat');
  assert.equal(wrapper.start, stock.start, 'reuse the real stock start');
  assert.equal(wrapper.update, stock.update, 'reuse the real stock update');

  // Exercise the actual legacy projection and exclusive event dispatcher as well.
  const contributionSource = section(
    chatSource,
    'const EMPTY_CONTRIBUTION =',
    'function sameContribution(left, right)',
  );
  const contribution = new Function(
    'EMPTY_LIST',
    `${contributionSource}\nreturn legacyContribution;`,
  )([]);
  const dispatchHelpers = section(
    conversationSource,
    'const PUBLICATION_RANK =',
    'const NO_GROUPS =',
  );
  const dispatchSource = section(
    conversationSource,
    'dispatchInput(input, accept) {',
    'createContext(definition, id, key) {',
  );
  const dispatch = new Function(
    `${dispatchHelpers}\nreturn ({${dispatchSource}}).dispatchInput;`,
  )();

  function lifecycle(name, id, outcomeKind = 'success') {
    const run = {
      event: {
        type: 'command/run',
        seq: 1,
        time: 1,
        data: { name, commandId: id, source: { kind: 'user' } },
      },
      role: 'start',
      location: { kind: 'session' },
    };
    const done = {
      event: {
        type: 'command/done',
        seq: 2,
        time: 2,
        data: { commandId: id, kind: outcomeKind, text: '{"ok":true}' },
      },
      role: 'update',
      location: { kind: 'session' },
    };
    const context = {
      key: `${wrapper.kind}:${id}`,
      kind: wrapper.kind,
      id,
      start: run,
      matches: [run],
      state: undefined,
      current: new Map(),
    };
    context.state = wrapper.start(context, run);
    context.state = wrapper.update(context, done);
    context.matches.push(done);
    return context;
  }

  const checks = ['filter follows delayed host registration, removal, remount and plugin cleanup'];
  function check(name, verify) {
    verify();
    checks.push(name);
  }

  const terms = lifecycle('session-terms', 'terms');
  const feedback = lifecycle('feedback', 'feedback');
  const compact = lifecycle('compact', 'compact');

  check('session-terms is hidden and contributes zero display rows', () => {
    const node = wrapper.buildViewNode(terms);
    assert.equal(node.visibility, 'hidden');
    assert.equal(contribution(node).nodes.length, 0);
    assert.equal(node.data.outcome.text, '{"ok":true}', 'preserve the recorded result');
  });
  check('other command nodes remain identical to the stock definition', () => {
    const node = wrapper.buildViewNode(feedback);
    assert.deepEqual(node, stock.buildViewNode(feedback));
    assert.equal(contribution(node).nodes.length, 1);
  });
  check('manual compaction retains its stock node and display projection', () => {
    const node = wrapper.buildViewNode(compact);
    assert.equal(node.kind, 'manual-compaction');
    assert.deepEqual(node, stock.buildViewNode(compact));
    assert.deepEqual(contribution(node), contribution(stock.buildViewNode(compact)));
  });
  check('the new context kind preserves the command node kind and context key', () => {
    const node = wrapper.buildViewNode(terms);
    assert.equal(terms.kind, wrapper.kind);
    assert.equal(node.kind, 'command');
    assert.equal(node.key, terms.key);
  });
  check('the real dispatcher selects the wrapper exclusively for run and done', () => {
    for (const context of [terms, feedback, compact]) {
      for (const match of context.matches) {
        const accepted = [];
        dispatch.call(
          {
            matchedDefinitions: [],
            matchedResults: [],
            locationIndex: { locationOf: () => ({ kind: 'session' }) },
            eventDefinitions: { entries: () => [stock, wrapper], fallbackEntry: () => undefined },
          },
          { event: match.event },
          function accept(definition) {
            accepted.push(definition.kind);
            return 'immediate';
          },
        );
        assert.deepEqual(accepted, [wrapper.kind]);
      }
    }
  });
  check('a done-only historical window remains identifiable only after its run loads', () => {
    const doneOnly = { ...terms, start: undefined, state: undefined, matches: [terms.matches[1]] };
    const partial = wrapper.buildViewNode(doneOnly);
    assert.equal(partial.data.name, null);
    assert.equal(partial.visibility, 'visible', 'do not hide unrelated nameless results');
    const complete = wrapper.buildViewNode(terms);
    assert.equal(complete.key, partial.key);
    assert.equal(complete.visibility, 'hidden');
  });
  check('failed session-terms results are hidden and failed other commands are retained', () => {
    const failedTerms = lifecycle('session-terms', 'failed-terms', 'error');
    const failedOther = lifecycle('feedback', 'failed-feedback', 'error');
    assert.equal(wrapper.buildViewNode(failedTerms).visibility, 'hidden');
    assert.deepEqual(wrapper.buildViewNode(failedOther), stock.buildViewNode(failedOther));
  });

  console.log(
    JSON.stringify(
      {
        passed: true,
        checks,
        scope:
          'imported client wrapper, installed stock definition, helpers, projection and dispatcher; no live application calls',
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
