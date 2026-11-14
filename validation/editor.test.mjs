import test from 'node:test';
import assert from 'node:assert/strict';
import { React, mount, input, click, button, submit } from './dom.mjs';
import { createTermsStore } from '../src/client/state.mjs';
import { createUiPrimitives } from '../src/client/common.mjs';
import { createTermEditor } from '../src/client/editor.mjs';
import { changeState, emptyState } from '../src/terms.mjs';

async function fixture(color) {
  let backend = changeState(emptyState(), 'create', { name: 'Alpha', note: 'original', color });
  backend = changeState(backend, 'create', { name: 'Beta', note: 'unrelated' });
  const calls = [];
  let closed = false;
  const store = createTermsStore('test', async (_session, action, payload) => {
    if (action === 'get') return { ok: true, state: structuredClone(backend) };
    calls.push({ action, payload });
    try {
      backend = changeState(backend, action, payload);
      return { ok: true, state: structuredClone(backend) };
    } catch (error) {
      return { ok: false, code: error.code };
    }
  });
  await store.load();
  const entry = store.getSnapshot().data.terms[0];
  const useTerms = () => [React.useSyncExternalStore(store.subscribe, store.getSnapshot), store];
  const ui = createUiPrimitives(React, ['conflict', 'missing-term']);
  const Editor = createTermEditor({ React, useTerms, ui });
  const mounted = await mount(
    React.createElement(Editor, {
      sessionId: 'test',
      term: entry,
      onClose() {
        closed = true;
      },
      t: (key) => key,
    }),
  );
  return {
    ...mounted,
    store,
    calls,
    backend: () => backend,
    closed: () => closed,
    updateElsewhere(name, note, color) {
      const term = backend.terms.find((item) => item.name === name);
      backend = changeState(backend, 'update', { id: term.id, name, note, color });
    },
    removeElsewhere() {
      backend = changeState(backend, 'delete', { id: entry.id });
    },
    async refresh() {
      await React.act(async () => {
        await store.load();
      });
    },
    async close() {
      await mounted.unmount();
      store.dispose();
    },
  };
}

async function chooseColor(container, color) {
  const picker = container.querySelector('input[type="color"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(picker, color);
  await React.act(async () => {
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

test('color selection previews and saves the chosen value with the edit baseline', async () => {
  const f = await fixture();
  try {
    assert.equal(button(f.container, 'defaultColor').getAttribute('aria-pressed'), 'true');
    await chooseColor(f.container, '#2868b4');
    assert.equal(button(f.container, 'defaultColor').getAttribute('aria-pressed'), 'false');
    assert.equal(f.container.querySelector('.st-color-preview').style.color, 'rgb(40, 104, 180)');
    await submit(f.container.querySelector('form'));
    assert.equal(f.calls[0].payload.color, '#2868b4');
    assert.equal(f.calls[0].payload.expectedVersion, 1);
    assert.equal(f.backend().terms[0].color, '#2868b4');
  } finally {
    await f.close();
  }
});

test('default color resets an existing selection and reload refreshes the color baseline', async () => {
  const f = await fixture('#2868b4');
  try {
    assert.equal(f.container.querySelector('input[type="color"]').value, '#2868b4');
    await click(button(f.container, 'defaultColor'));
    assert.equal(f.container.querySelector('.st-color-preview').style.color, '');
    await submit(f.container.querySelector('form'));
    assert.equal(f.backend().terms[0].color, null);
  } finally {
    await f.close();
  }
  const g = await fixture('#2868b4');
  try {
    await chooseColor(g.container, '#b45309');
    g.updateElsewhere('Alpha', 'original', '#ab2378');
    await g.refresh();
    assert.equal(button(g.container, 'save').disabled, true);
    assert.equal(g.container.querySelector('input[type="color"]').value, '#b45309');
    await click(button(g.container, 'reloadLatest'));
    assert.equal(g.container.querySelector('input[type="color"]').value, '#ab2378');
    assert.equal(button(g.container, 'save').disabled, false);
  } finally {
    await g.close();
  }
});

test('foreground refresh cannot combine an old draft with the new store revision', async () => {
  const f = await fixture();
  try {
    await input(f.container.querySelector('textarea'), 'my unsaved draft');
    f.updateElsewhere('Alpha', 'other window');
    await f.refresh();
    assert.equal(f.container.querySelector('textarea').value, 'my unsaved draft');
    assert(f.container.textContent.includes('editorConflict'));
    assert.equal(button(f.container, 'save').disabled, true);
    await submit(f.container.querySelector('form'));
    assert.equal(f.calls.length, 0);
    assert.equal(f.backend().terms[0].note, 'other window');
    assert.equal(f.closed(), false);
  } finally {
    await f.close();
  }
});

test('explicit reload resets draft and baseline; the next save uses that term version', async () => {
  const f = await fixture();
  try {
    f.updateElsewhere('Alpha', 'latest content');
    await f.refresh();
    await click(button(f.container, 'reloadLatest'));
    assert.equal(f.container.querySelector('textarea').value, 'latest content');
    assert.equal(button(f.container, 'save').disabled, false);
    await input(f.container.querySelector('textarea'), 'edited after reload');
    await submit(f.container.querySelector('form'));
    assert.equal(f.calls[0].payload.expectedVersion, 2);
    assert.equal(f.backend().terms[0].note, 'edited after reload');
    assert.equal(f.closed(), true);
  } finally {
    await f.close();
  }
});

test('changes to unrelated terms do not invalidate the editor baseline', async () => {
  const f = await fixture();
  try {
    await input(f.container.querySelector('textarea'), 'my edit');
    f.updateElsewhere('Beta', 'changed elsewhere');
    await f.refresh();
    assert.equal(button(f.container, 'save').disabled, false);
    await submit(f.container.querySelector('form'));
    assert.equal(f.calls[0].payload.expectedVersion, 1);
    assert.equal(f.calls[0].payload.expectedRevision, 3);
    assert.equal(f.backend().terms[0].note, 'my edit');
    assert.equal(f.backend().terms[1].note, 'changed elsewhere');
  } finally {
    await f.close();
  }
});

test('a server conflict refreshes state while retaining the draft and offering explicit recovery', async () => {
  const f = await fixture();
  try {
    await input(f.container.querySelector('textarea'), 'keep this draft');
    f.updateElsewhere('Alpha', 'other window');
    await submit(f.container.querySelector('form'));
    assert.equal(f.closed(), false);
    assert.equal(f.store.getSnapshot().error.code, 'conflict');
    assert.equal(f.container.querySelector('textarea').value, 'keep this draft');
    assert(f.container.textContent.includes('editorConflict'));
    assert.equal(f.backend().terms[0].note, 'other window');
  } finally {
    await f.close();
  }
});

test('deleted term draft is preserved and can explicitly be saved as a new term', async () => {
  const f = await fixture();
  try {
    await input(f.container.querySelector('textarea'), 'retained draft');
    f.removeElsewhere();
    await f.refresh();
    assert(f.container.textContent.includes('editorMissing'));
    assert.equal(button(f.container, 'save').disabled, true);
    await click(button(f.container, 'reloadLatest'));
    assert.equal(f.container.querySelector('textarea').value, 'retained draft');
    await submit(f.container.querySelector('form'));
    assert.equal(f.calls[0].action, 'create');
    assert.equal(f.backend().terms.find((term) => term.name === 'Alpha').note, 'retained draft');
  } finally {
    await f.close();
  }
});
