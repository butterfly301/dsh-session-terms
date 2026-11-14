import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteSelection, collectSelection } from '../src/client/interactions.mjs';

function fixture(text, accepted = true, terms = []) {
  const calls = [];
  let editorRequest = null;
  const props = {
    readText: () => text,
    inputActions: {
      insertQuote(value) {
        calls.push(['quote', value]);
        return accepted;
      },
    },
    clearSelection() {
      calls.push(['clear']);
    },
    dismiss() {
      calls.push(['dismiss']);
    },
  };
  const store = {
    getSnapshot: () => ({ data: { terms } }),
    openEditor(request) {
      editorRequest = request;
      calls.push(['editor']);
    },
    setError(error) {
      calls.push(['error', error.code]);
    },
  };
  return { props, store, calls, editor: () => editorRequest };
}

test('quote action preserves the stock success, rejected and expired semantics', () => {
  const valid = fixture('selected text');
  quoteSelection(valid.props);
  assert.deepEqual(valid.calls, [['quote', 'selected text'], ['clear'], ['dismiss']]);
  const rejected = fixture('selected text', false);
  quoteSelection(rejected.props);
  assert.deepEqual(rejected.calls, [['quote', 'selected text']]);
  const expired = fixture(null);
  quoteSelection(expired.props);
  assert.deepEqual(expired.calls, [['dismiss']]);
});

test('term action captures text before dismiss and keeps an editor request after dismissal', () => {
  const current = fixture('  selected term  ');
  collectSelection(current.props, current.store);
  assert.deepEqual(current.calls, [['editor'], ['clear'], ['dismiss']]);
  assert.deepEqual(current.editor(), { initialName: 'selected term' });
});

test('existing term opens for editing without replacing its note', () => {
  const term = { id: 'term', name: 'existing', note: 'keep this note' };
  const current = fixture('existing', true, [term]);
  collectSelection(current.props, current.store);
  assert.equal(current.editor().term, term);
  assert.equal(current.editor().term.note, 'keep this note');
});

test('empty or expired selection cannot create an editor request', () => {
  for (const value of [null, '', '   ']) {
    const current = fixture(value);
    collectSelection(current.props, current.store);
    assert.equal(current.editor(), null);
    assert.deepEqual(current.calls, [['error', 'selectionExpired'], ['dismiss']]);
  }
});
