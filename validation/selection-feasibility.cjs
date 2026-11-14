'use strict';
// Read-only verification of the installed quote handler. No live plugin, DOM,
// session or profile is modified. This does not establish visual acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root =
  process.env.DSH_VERIFY_MODULES ||
  'D:/Program Files/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai';
const source = fs.readFileSync(path.join(root, 'dsh-message-quotes/lib/client.js'), 'utf8');
const marker = 'onClick: () => {';
const start = source.indexOf(marker);
assert(start !== -1, 'installed quote click handler exists');
const end = source.indexOf('children: t("quote.add")', start);
assert(end !== -1);
const expression = source
  .slice(start + 'onClick: '.length, end)
  .trim()
  .replace(/,$/, '');
function createClick(text, accepted = true) {
  const calls = [];
  const click = new Function(
    'readText',
    'inputActions',
    'clearSelection',
    'dismiss',
    `return (${expression});`,
  )(
    () => text,
    {
      insertQuote(value) {
        calls.push(['insertQuote', value]);
        return accepted;
      },
    },
    () => calls.push(['clearSelection']),
    () => calls.push(['dismiss']),
  );
  click();
  return calls;
}
assert.deepEqual(createClick('selected term'), [
  ['insertQuote', 'selected term'],
  ['clearSelection'],
  ['dismiss'],
]);
assert.deepEqual(createClick('selected term', false), [['insertQuote', 'selected term']]);
assert.deepEqual(createClick(null), [['dismiss']]);
console.log(
  JSON.stringify(
    {
      passed: true,
      checks: [
        'quote uses the public insertQuote interface with the selected text',
        'accepted quote clears selection and dismisses the action surface',
        'failed insertion preserves selection and the action surface',
        'expired selection dismisses without changing the draft',
      ],
      scope: 'actual installed quote click handler, no renderer or live UI mutation',
    },
    null,
    2,
  ),
);
