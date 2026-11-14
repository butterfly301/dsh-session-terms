'use strict';
// Run with ELECTRON_RUN_AS_NODE=1 and the installed DeepSeek Harness executable.
// Executes the installed SlotCore and Cordis-backed SlotRegistry, without
// registering anything in the running application or changing the profile.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const archive =
  (require.main === module ? process.argv[2] : undefined) ||
  'D:/Program Files/DeepSeek Harness/resources/app.asar';
const modules = process.env.DSH_VERIFY_MODULES || archive + '/dsh/node_modules/@deepseek-ai';
const assets = path.join(modules, 'dsh-web-frontend/dist/assets');
const candidates = fs.readdirSync(assets).filter((name) => /^index-.*\.js$/.test(name));
function readBounded(file, max = 1024 * 1024) {
  assert(fs.statSync(file).size <= max, `Source exceeds read budget: ${file}`);
  return fs.readFileSync(file, 'utf8');
}
let selected;
for (const asset of candidates) {
  const bundle = readBounded(path.join(assets, asset), 3 * 1024 * 1024);
  const exported = /SlotCore:([\w$]+)/.exec(bundle);
  if (!exported) continue;
  const symbol = exported[1];
  const start = bundle.indexOf('var ' + symbol + '=class{records=new Map');
  const end = bundle.lastIndexOf(';const ', exported.index);
  assert(start > 0 && end > start, 'Recognized complete bundled SlotCore class required');
  const source = bundle.slice(start, end + 1);
  const emptyArray = /entries\(e\)\{return this\.records\.get\(e\)\?\.entries\?\?([\w$]+)/.exec(
    source,
  );
  assert(emptyArray, 'Recognized empty-array dependency required');
  const SlotCore = vm.runInNewContext(
    'const ' + emptyArray[1] + '=Object.freeze([]);' + source + ';' + symbol,
    { queueMicrotask, console },
  );
  selected = {
    SlotCore,
    bundle,
    asset,
    sha256: crypto.createHash('sha256').update(source).digest('hex'),
  };
  break;
}
assert(selected, 'Installed frontend must expose SlotCore');

function loadClient(packageName, resolve, globals = {}) {
  let declaration;
  vm.runInNewContext(readBounded(path.join(modules, packageName, 'lib/client.js')), {
    window: {
      __ModuleLoader__: {
        load(value) {
          declaration = value;
        },
      },
    },
    queueMicrotask,
    console,
    ...globals,
  });
  assert(declaration, `Installed ${packageName} must declare its client module`);
  return declaration.factory(resolve);
}

// Read each owner's declaration rather than inventing a test-only slot shape.
function declaredSlot(packageName, name) {
  const source = readBounded(path.join(modules, packageName, 'src/client/apply.ts'));
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`'${escaped}': \\{ kind: '([^']+)', scope: '([^']+)' \\}`).exec(source);
  assert(match, `Installed owner must declare ${name}`);
  return { kind: match[1], scope: match[2] };
}

function verifyTranscriptMarkers() {
  const source = readBounded(path.join(__dirname, '../src/client/highlight.mjs'));
  const selector = /const STREAM_BODY =\s*'([^']+)'/.exec(source)?.[1];
  assert(selector, 'Streaming selector must remain inspectable');
  const bodyClass = /^\.([\w-]+) > /.exec(selector)?.[1];
  const markdownClass = /"(_markdown_\w+_\d+)"/.exec(selected.bundle)?.[1];
  assert(
    bodyClass && markdownClass,
    'Installed assistant and Markdown classes must be identifiable',
  );
  const chat = readBounded(path.join(modules, 'dsh-client-ui-chat/lib/client.js'));
  assert(chat.includes(bodyClass), 'Streaming assistant body class must exist in installed Chat');
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM();
  try {
    const body = dom.window.document.createElement('div');
    body.className = bodyClass;
    const markdown = body.appendChild(dom.window.document.createElement('div'));
    markdown.className = markdownClass;
    assert(markdown.matches(selector), 'Fallback must match the installed Markdown token');
    markdown.className = `extra ${markdownClass} another`;
    assert(markdown.matches(selector), 'Extra host classes must preserve the Markdown token');
    markdown.className = `prefix${markdownClass}`;
    assert(!markdown.matches(selector), 'An embedded class fragment is not a Markdown token');
  } finally {
    dom.window.close();
  }
  const user = readBounded(
    path.join(modules, 'dsh-client-ui-chat/src/client/chat/UserContent.tsx'),
  );
  assert(user.includes('data-message-bubble="" data-text-interaction-source=""'));
  const userClass = /const USER_TEXT = '[^']*\.([\w-]+)'/.exec(source)?.[1];
  assert(
    userClass && selected.bundle.includes(`"${userClass}"`),
    'User plain-text class must exist in installed frontend',
  );
  const slots = readBounded(
    path.join(modules, 'dsh-client-ui-conversation/src/client/contract/slots.ts'),
  );
  assert(slots.includes('useInput: SnapshotSelectorHook<InputState>'));
  assert(slots.includes('inputActions: InputActions'));
  const input = readBounded(
    path.join(modules, 'dsh-client-ui-conversation/src/client/contract/input.ts'),
  );
  for (const method of ['captureInsertion()', 'insertText(', 'insertQuote('])
    assert(input.includes(method), `Installed public input contract must retain ${method}`);
  console.log('PASS installed streaming/user markers and public inputActions match client');
}

async function main() {
  const version = JSON.parse(readBounded(path.join(modules, 'dsh/package.json'))).version;
  const cordis = await import(pathToFileURL(path.join(modules, 'cordis/lib/index.js')).href);
  const { SlotRegistry } = loadClient('dsh-client-ui-renderer', (name) => {
    if (name === '@deepseek-ai/cordis') return cordis;
    if (name === '@deepseek-ai/dsh-client-ui-slots') return { SlotCore: selected.SlotCore };
    return require(name);
  });
  const { createClientPlugin } = await import('../src/client/plugin.mjs');
  const options = [];
  createClientPlugin({
    React: require('react'),
    resources: { dictionaries: {}, errorCodes: [] },
    styles: '',
  }).apply({
    remote: { commands: {} },
    effect() {},
    slots: {
      inject(_owner, register) {
        register();
      },
      register(value, component) {
        options.push({ value, component });
      },
    },
  });
  const dockName = 'conversation.input.dock';
  const selectionName = 'conversation.chat.text-interaction';
  const dock = options.find((entry) => entry.value.name === dockName);
  const selection = options.find((entry) => entry.value.name === selectionName);
  assert(dock && selection, 'Actual client must register both host surfaces');
  assert.equal(selection.value.key, 'quote');
  assert.equal(selection.value.priority, -100);
  const root = new cordis.Context();
  try {
    await root.plugin({
      apply(ctx) {
        new SlotRegistry(ctx);
      },
    });
    let consumer;
    const child = await root.plugin({
      inject: ['slots'],
      apply(ctx) {
        consumer = ctx;
        for (const { value, component } of options)
          ctx.slots.inject(value.name, () => ctx.slots.register(value, component));
      },
    });
    assert(consumer, 'Real Cordis must activate client slot consumer');
    assert.equal(root.slots.entries(dockName).length, 0, 'Injection waits for owner declaration');
    const declareOwners = () => {
      const releaseDock = root.slots.registerFactory(
        {
          name: 'conversation.content',
          scope: 'session-maybe',
          children: { [dockName]: declaredSlot('dsh-client-ui-conversation', dockName) },
        },
        function ConversationContent() {},
      );
      const releaseChat = root.slots.register(
        {
          name: 'root',
          children: {
            [selectionName]: declaredSlot('dsh-client-ui-chat', selectionName),
          },
        },
        function ChatOwner() {},
      );
      return async () => {
        await releaseChat();
        await releaseDock();
      };
    };
    let releaseOwners = declareOwners();
    const winner = () =>
      root.slots.entriesOfSlot(selectionName).find((entry) => entry.options.key === 'quote')
        ?.component;
    const Stock = function StockQuote() {};
    let releaseStock = root.slots.register({ name: selectionName, key: 'quote' }, Stock);
    assert.equal(root.slots.entries(dockName)[0].component, dock.component);
    assert.equal(winner(), selection.component, 'Actual quote replacement wins against stock');
    assert.equal(root.slots.entries(selectionName).length, 2);
    console.log('PASS actual client entries register against installed owner scopes and registry');
    await releaseOwners();
    assert.equal(root.slots.entries(dockName).length, 0);
    assert.equal(root.slots.entries(selectionName).length, 0);
    releaseOwners = declareOwners();
    releaseStock = root.slots.register({ name: selectionName, key: 'quote' }, Stock);
    assert.equal(root.slots.entries(dockName).length, 1, 'Owner replay restores exactly one dock');
    assert.equal(
      root.slots.entries(selectionName).length,
      2,
      'Owner replay restores one replacement',
    );
    assert.equal(winner(), selection.component);
    await child.dispose();
    assert.equal(root.slots.entries(dockName).length, 0);
    assert.equal(winner(), Stock, 'Plugin unload restores stock quote action');
    await child.dispose();
    await releaseStock();
    await releaseOwners();
    // A retired waiting injection must not resurrect on a later declaration.
    releaseOwners = declareOwners();
    assert.equal(root.slots.entries(dockName).length, 0);
    assert.equal(root.slots.entries(selectionName).length, 0);
    await releaseOwners();
    console.log(
      'PASS delayed owners, owner collapse/replay, idempotent unload and no resurrection',
    );
    verifyTranscriptMarkers();
    console.log(
      'SOURCE',
      JSON.stringify({ version, archive, asset: selected.asset, sha256: selected.sha256 }),
    );
  } finally {
    await root.fiber.dispose();
  }
}
module.exports = { selected, loadClient, declaredSlot };
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
