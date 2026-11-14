import test from 'node:test';
import assert from 'node:assert/strict';
import { isTermColor, TERM_COLOR_PATTERN, TERM_COLOR_LENGTH } from '../src/color.mjs';
import { createTermsStore } from '../src/client/state.mjs';

const validColors = ['#000000', '#ffffff', '#FFFFFF', '#aB09eF'];
const invalidColors = [
  '',
  '#',
  '#abc',
  '#12345',
  '#1234567',
  '#12345678',
  '123456',
  '1234567',
  '#gggggg',
  '#１２３４５６',
  ' #123456',
  '#123456 ',
  '#123456\n',
  '#123456\r',
  '#123456\r\n',
  '#123456\u2028',
  '#123456\u2029',
  '#123456\0',
  '#123456;color:red',
  null,
  undefined,
  123456,
  false,
  {},
  [],
  ['#123456'],
  new String('#123456'),
  {
    toString() {
      throw Error('must not coerce objects');
    },
  },
];

test('term color rule accepts every ASCII hex digit at each of exactly six positions', () => {
  for (const color of validColors) assert.equal(isTermColor(color), true, color);
  for (const digit of '0123456789abcdefABCDEF') {
    for (let index = 1; index < TERM_COLOR_LENGTH; index++) {
      const color = '#000000'.slice(0, index) + digit + '#000000'.slice(index + 1);
      assert.equal(isTermColor(color), true, color);
    }
  }
  for (const color of invalidColors) assert.equal(isTermColor(color), false);
});

test('shared schema pattern and length match the predicate without stateful regex behavior', () => {
  assert.equal(TERM_COLOR_LENGTH, 7);
  assert.equal(TERM_COLOR_PATTERN.global, false);
  assert.equal(TERM_COLOR_PATTERN.sticky, false);
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const value of [...validColors, ...invalidColors]) {
      const schemaAccepts =
        typeof value === 'string' &&
        value.length === TERM_COLOR_LENGTH &&
        TERM_COLOR_PATTERN.test(value);
      assert.equal(isTermColor(value), schemaAccepts);
    }
  }
});

test('client state accepts legacy and nullable colors, preserves casing, and rejects invalid loads', async () => {
  const entry = { id: 'term', name: 'term', note: '', version: 1, order: 0 };
  const legacy = { revision: 0, expanded: false, terms: [entry] };
  let state = legacy;
  const store = createTermsStore('colors', async () => ({ ok: true, state }));
  try {
    assert.equal(await store.load(), true);
    assert.equal(Object.hasOwn(store.getSnapshot().data.terms[0], 'color'), false);
    for (const color of [undefined, null, ...validColors]) {
      state = { ...legacy, terms: [{ ...entry, color }] };
      assert.equal(await store.load(), true);
      assert.equal(store.getSnapshot().data.terms[0].color, color);
    }
    const accepted = store.getSnapshot().data;
    for (const color of invalidColors.filter((value) => value != null)) {
      state = { ...legacy, terms: [{ ...entry, color }] };
      assert.equal(await store.load(), false);
      assert.equal(store.getSnapshot().data, accepted);
      assert.equal(store.getSnapshot().error.code, 'invalid');
    }
  } finally {
    store.dispose();
  }
});
