'use strict';
// Run with ELECTRON_RUN_AS_NODE=1 and the installed DeepSeek Harness executable.
// Reads the installed archive and runs its actual SlotCore in an isolated VM.
// No plugin registration is made in the running application.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const archive = process.argv[2] || 'D:/Program Files/DeepSeek Harness/resources/app.asar';
const assets = archive + '/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets';
const candidates = fs.readdirSync(assets).filter((name) => /^index-.*\.js$/.test(name));
let selected;
for (const asset of candidates) {
  const bundle = fs.readFileSync(assets + '/' + asset, 'utf8');
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
    asset,
    start,
    end,
    sha256: crypto.createHash('sha256').update(source).digest('hex'),
  };
  break;
}
assert(selected, 'Installed frontend must expose SlotCore');

async function main() {
  const { createClientPlugin } = await import('../src/client/plugin.mjs');
  let actualOptions;
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
      register(options) {
        if (options.name === 'conversation.chat.text-interaction') actualOptions = options;
      },
    },
  });
  assert.equal(actualOptions.key, 'quote');
  assert.equal(actualOptions.priority, -100);
  const registry = new selected.SlotCore();
  const name = 'conversation.chat.text-interaction';
  const releaseRoot = registry.register(
    { name: 'root', children: { [name]: { kind: 'keyed', scope: 'chat' } } },
    function Root() {},
  );
  const Stock = function StockQuote() {};
  const Double = function QuoteAndTerm() {};
  const releaseStock = registry.register({ name, key: 'quote', registrant: 'stock' }, Stock);
  let notifications = 0;
  const unsubscribe = registry.subscribe(name, () => notifications++);
  const winner = () =>
    registry.entriesOfSlot(name).find((entry) => entry.options.key === 'quote').component;
  try {
    const releasePositive = registry.register({ name, key: 'quote', priority: 100 }, Double);
    assert.equal(winner(), Stock);
    releasePositive();
    console.log('PASS same key priority 100 accepted; stock priority 0 wins');
    const releaseOverride = registry.register(
      { ...actualOptions, registrant: 'candidate' },
      Double,
    );
    assert.equal(winner(), Double);
    assert.equal(registry.entries(name).length, 2);
    assert.throws(
      () => registry.register({ name, key: 'quote', priority: -100 }, Double),
      /already has an entry/,
    );
    assert.throws(() => registry.register({ name, key: 'quote' }, Double), /already has an entry/);
    console.log(
      'PASS same key different priorities coexist; -100 wins; repeated priority rejected',
    );
    console.log('ACTIVE', JSON.stringify(registry.snapshot(name)));
    await new Promise((resolve) => queueMicrotask(resolve));
    assert(notifications > 0);
    const version = registry.getVersion(name);
    releaseOverride();
    assert.equal(winner(), Stock);
    assert(registry.getVersion(name) > version);
    const previousNotifications = notifications;
    await new Promise((resolve) => queueMicrotask(resolve));
    assert(notifications > previousNotifications);
    releaseOverride();
    assert.equal(winner(), Stock);
    console.log(
      'PASS disposal restores original stock component, advances version, notifies subscribers; repeated disposal safe',
    );
    console.log('RESTORED', JSON.stringify(registry.snapshot(name)));
    console.log(
      'SOURCE',
      JSON.stringify({
        archive,
        asset: selected.asset,
        start: selected.start,
        end: selected.end,
        sha256: selected.sha256,
      }),
    );
  } finally {
    unsubscribe();
    releaseStock();
    releaseRoot();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
