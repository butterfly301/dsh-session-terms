import test from 'node:test';
import assert from 'node:assert/strict';
import { React, mount, click, input, button } from './dom.mjs';
import { createTermsStore } from '../src/client/state.mjs';
import { createUiPrimitives } from '../src/client/common.mjs';
import { createTermEditor } from '../src/client/editor.mjs';
import { createManager } from '../src/client/manager.mjs';
import { changeState, emptyState } from '../src/terms.mjs';

async function fixture() {
  let backend = emptyState();
  for (const name of ['Alpha', 'Beta', 'Gamma']) backend = changeState(backend, 'create', { name });
  const calls = [];
  let fail = false;
  const store = createTermsStore('test', async (_session, action, payload) => {
    if (action === 'get') return { ok: true, state: structuredClone(backend) };
    calls.push({ action, payload });
    if (fail) return { ok: false, code: 'transport' };
    try {
      backend = changeState(backend, action, payload);
      return { ok: true, state: structuredClone(backend) };
    } catch (error) {
      return { ok: false, code: error.code };
    }
  });
  await store.load();
  const useTerms = () => [React.useSyncExternalStore(store.subscribe, store.getSnapshot), store];
  const ui = createUiPrimitives(React, ['conflict', 'missing-term']);
  const TermEditor = createTermEditor({ React, useTerms, ui });
  const Manager = createManager({ React, useTerms, ui, TermEditor });
  const mounted = await mount(
    React.createElement(Manager, { sessionId: 'test', onClose() {}, t: (key) => key }),
  );
  return {
    ...mounted,
    store,
    calls,
    backend: () => backend,
    fail(value) {
      fail = value;
    },
    removeElsewhere(name) {
      const term = backend.terms.find((item) => item.name === name);
      backend = changeState(backend, 'delete', { id: term.id });
    },
    async close() {
      await mounted.unmount();
      store.dispose();
    },
  };
}

const checkbox = (container, name) => {
  const element = container.querySelector(
    `input[aria-label="selectTerm ${name}"],input[aria-label="deselectTerm ${name}"]`,
  );
  assert(element, `checkbox exists for ${name}`);
  return element;
};
const confirmation = (container) =>
  [...container.querySelectorAll('dialog')].find(
    (dialog) => dialog.querySelector('h2').textContent === 'deleteSelectedTitle',
  );

test('actual React selection mode replaces drag handles, toggles checkboxes and exits', async () => {
  const f = await fixture();
  try {
    assert.equal(f.container.querySelectorAll('[draggable=true]').length, 3);
    await click(button(f.container, 'multiSelect'));
    assert.equal(f.container.querySelectorAll('[draggable=true]').length, 0);
    assert.equal(f.container.querySelectorAll('input[type=checkbox]').length, 3);
    assert.equal(button(f.container, 'deleteSelected').disabled, true);
    await click(checkbox(f.container, 'Alpha'));
    assert.equal(checkbox(f.container, 'Alpha').checked, true);
    await click(checkbox(f.container, 'Alpha'));
    assert.equal(checkbox(f.container, 'Alpha').checked, false);
    await click(button(f.container, 'exitMultiSelect'));
    assert.equal(f.container.querySelectorAll('input[type=checkbox]').length, 0);
    assert.equal(f.container.querySelectorAll('[draggable=true]').length, 3);
  } finally {
    await f.close();
  }
});

test('select all covers search results and preserves hidden selections; confirmation is required', async () => {
  const f = await fixture();
  try {
    await click(button(f.container, 'multiSelect'));
    await click(checkbox(f.container, 'Alpha'));
    await input(f.container.querySelector('input[type=search]'), 'Beta');
    await click(button(f.container, 'selectAll'));
    assert.equal(checkbox(f.container, 'Beta').checked, true);
    await click(button(f.container, 'deselectAll'));
    assert.equal(checkbox(f.container, 'Beta').checked, false);
    await click(button(f.container, 'selectAll'));
    await click(button(f.container, 'deleteSelected'));
    assert.equal(f.calls.length, 0);
    assert.equal(f.container.querySelector('.st-dialog-wide').hasAttribute('inert'), true);
    assert.equal(
      confirmation(f.container).querySelector('[role=status]').textContent,
      'selected 2',
    );
    await click(button(confirmation(f.container), 'confirmDelete'));
    assert.deepEqual(
      f.backend().terms.map((term) => term.name),
      ['Gamma'],
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].action, 'deleteMany');
    assert.equal(f.calls[0].payload.ids.length, 2);
  } finally {
    await f.close();
  }
});

test('cancelling confirmation retains actual checked inputs and makes manager interactive again', async () => {
  const f = await fixture();
  try {
    await click(button(f.container, 'multiSelect'));
    await click(checkbox(f.container, 'Alpha'));
    await click(button(f.container, 'deleteSelected'));
    await click(button(confirmation(f.container), 'cancel'));
    assert.equal(f.calls.length, 0);
    assert.equal(confirmation(f.container), undefined);
    assert.equal(checkbox(f.container, 'Alpha').checked, true);
    assert.equal(f.container.querySelector('.st-dialog-wide').hasAttribute('inert'), false);
  } finally {
    await f.close();
  }
});

test('real revision conflict refreshes confirmation survivors and retry deletes only remaining IDs', async () => {
  const f = await fixture();
  try {
    await click(button(f.container, 'multiSelect'));
    await click(checkbox(f.container, 'Alpha'));
    await click(checkbox(f.container, 'Beta'));
    await click(button(f.container, 'deleteSelected'));
    f.removeElsewhere('Alpha');
    await click(button(confirmation(f.container), 'confirmDelete'));
    assert(confirmation(f.container));
    assert.equal(
      confirmation(f.container).querySelector('[role=status]').textContent,
      'selected 1',
    );
    assert.equal(f.calls.length, 1);
    await click(button(confirmation(f.container), 'confirmDelete'));
    assert.equal(f.calls[1].payload.ids.length, 1);
    assert.deepEqual(
      f.backend().terms.map((term) => term.name),
      ['Gamma'],
    );
    assert.equal(confirmation(f.container), undefined);
  } finally {
    await f.close();
  }
});

test('transport failure preserves confirmation and selection for retry', async () => {
  const f = await fixture();
  try {
    await click(button(f.container, 'multiSelect'));
    await click(button(f.container, 'selectAll'));
    await click(button(f.container, 'deleteSelected'));
    f.fail(true);
    await click(button(confirmation(f.container), 'confirmDelete'));
    assert.equal(f.backend().terms.length, 3);
    assert.equal(f.container.querySelectorAll('input:checked').length, 3);
    f.fail(false);
    await click(button(confirmation(f.container), 'confirmDelete'));
    assert.equal(f.backend().terms.length, 0);
    assert.equal(button(f.container, 'deleteSelected').disabled, true);
  } finally {
    await f.close();
  }
});

test('when all confirmed terms disappear, confirm is disabled and the dialog can be dismissed', async () => {
  const f = await fixture();
  try {
    await click(button(f.container, 'multiSelect'));
    await click(checkbox(f.container, 'Alpha'));
    await click(button(f.container, 'deleteSelected'));
    f.removeElsewhere('Alpha');
    await click(button(confirmation(f.container), 'confirmDelete'));
    assert(confirmation(f.container).textContent.includes('noRemainingSelection'));
    assert.equal(button(confirmation(f.container), 'confirmDelete').disabled, true);
    await click(button(confirmation(f.container), 'cancel'));
    assert.equal(confirmation(f.container), undefined);
  } finally {
    await f.close();
  }
});
