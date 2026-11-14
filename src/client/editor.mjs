import { createColorField } from './color-field.mjs';

export function createTermEditor({ React, useTerms, ui }) {
  const { createElement: h, useId, useRef, useState } = React;
  const { button, Modal, Status } = ui;
  const ColorField = createColorField(React);

  return function TermEditor({ sessionId, term, initialName = '', onClose, t }) {
    const [state, store] = useTerms(sessionId);
    const [name, setName] = useState(term?.name ?? initialName);
    const [note, setNote] = useState(term?.note ?? '');
    const [color, setColor] = useState(term?.color ?? null);
    const [entry, setEntry] = useState(() => (term ? { ...term } : null));
    const [notice, setNotice] = useState(false);
    const [invalid, setInvalid] = useState(false);
    const nameRef = useRef(null);
    const noteRef = useRef(null);
    const errorId = useId();
    const latest = entry && state.data?.terms.find((item) => item.id === entry.id);
    const missing = Boolean(entry && state.data && !latest);
    const conflict = Boolean(entry && latest && latest.version !== entry.version);
    const busy = state.busy || state.loading;

    function close() {
      if (!store.getSnapshot().busy) onClose();
    }

    function reloadLatest() {
      const snapshot = store.getSnapshot();
      if (snapshot.busy || snapshot.loading || !snapshot.data) return;
      const current = entry && snapshot.data.terms.find((item) => item.id === entry.id);
      if (current) {
        setEntry({ ...current });
        setName(current.name);
        setNote(current.note);
        setColor(current.color ?? null);
      } else {
        // Explicit recovery preserves a deleted term's draft as a new term.
        setEntry(null);
      }
      setNotice(false);
      setInvalid(false);
      nameRef.current?.focus();
    }

    async function save(event) {
      event.preventDefault();
      const snapshot = store.getSnapshot();
      if (!snapshot.data || snapshot.loading || snapshot.busy) return;
      const clean = name.trim();
      if (!clean) {
        setInvalid(true);
        nameRef.current?.focus();
        return;
      }
      if (entry) {
        const current = snapshot.data.terms.find((item) => item.id === entry.id);
        if (!current || current.version !== entry.version) return;
      }
      const duplicate = snapshot.data.terms.find(
        (item) => item.name === clean && item.id !== entry?.id,
      );
      if (duplicate) {
        setEntry({ ...duplicate });
        setName(duplicate.name);
        setNote(duplicate.note);
        setColor(duplicate.color ?? null);
        setNotice(true);
        setInvalid(false);
        noteRef.current?.focus();
        return;
      }
      const payload = entry
        ? { id: entry.id, expectedVersion: entry.version, name: clean, note, color }
        : { name: clean, note, color };
      if (await store.mutate(entry ? 'update' : 'create', payload)) onClose();
    }

    return h(
      Modal,
      { title: t(entry ? 'editTitle' : 'addTitle'), onClose: close, t },
      h(
        'form',
        { onSubmit: save },
        h(
          'div',
          { className: 'st-body', style: { padding: 0 } },
          h(
            'label',
            { className: 'st-label' },
            t('name'),
            h('input', {
              ref: nameRef,
              autoFocus: true,
              className: 'st-field',
              value: name,
              'aria-invalid': invalid,
              'aria-describedby': invalid ? errorId : undefined,
              onChange: (event) => {
                setName(event.target.value);
                setInvalid(false);
              },
              disabled: state.busy,
            }),
          ),
          invalid
            ? h('p', { id: errorId, className: 'st-error', role: 'alert' }, t('required'))
            : null,
          h(
            'label',
            { className: 'st-label' },
            t('note'),
            h('textarea', {
              ref: noteRef,
              className: 'st-field',
              value: note,
              onChange: (event) => setNote(event.target.value),
              disabled: state.busy,
            }),
          ),
          h(ColorField, { color, onChange: setColor, preview: name.trim(), disabled: busy, t }),
          notice ? h('p', { role: 'status' }, t('duplicate')) : null,
          missing || conflict
            ? h(
                'div',
                { className: 'st-notice', role: 'alert' },
                h('span', null, t(missing ? 'editorMissing' : 'editorConflict')),
                button(t('reloadLatest'), reloadLatest, { disabled: busy }),
              )
            : null,
          h(Status, { state, store, t }),
          state.loading ? h('p', { role: 'status' }, t('loading')) : null,
          !state.data && !state.loading ? button(t('retry'), () => void store.load()) : null,
          h(
            'div',
            { className: 'st-actions' },
            h(
              'button',
              {
                type: 'submit',
                className: 'st-btn st-primary',
                disabled: !state.data || busy || missing || conflict,
              },
              t(state.busy ? 'busy' : 'save'),
            ),
          ),
        ),
      ),
    );
  };
}
