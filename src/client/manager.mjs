import { matches, dragProps, reorder } from './interactions.mjs';

export function createManager({ React, useTerms, ui, TermEditor }) {
  const { createElement: h, useEffect, useId, useState } = React;
  const { button, iconButton, Modal, Status, errorText } = ui;

  return function Manager({ sessionId, onClose, t }) {
    const [state, store] = useTerms(sessionId);
    // Opening management is an explicit refresh, even when the dock is subscribed.
    useEffect(() => {
      void store.load();
    }, [store]);
    const [query, setQuery] = useState('');
    const [editor, setEditor] = useState(null);
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState(() => new Set());
    const [pendingDelete, setPendingDelete] = useState(null);
    const searchId = useId();
    const terms = state.data?.terms ?? [];
    const busy = state.busy || state.loading;
    const nestedOpen = editor !== null || pendingDelete !== null;
    const visible = terms.filter((term) => matches(term, query));
    const selectedIds = terms.filter((term) => selected.has(term.id)).map((term) => term.id);
    const confirmedIds = pendingDelete === null ? null : new Set(pendingDelete);
    const remainingIds = confirmedIds
      ? terms.filter((term) => confirmedIds.has(term.id)).map((term) => term.id)
      : [];
    const allVisibleSelected = visible.length > 0 && visible.every((term) => selected.has(term.id));

    function parentAvailable() {
      const snapshot = store.getSnapshot();
      return Boolean(snapshot.data && !snapshot.busy && !snapshot.loading && !nestedOpen);
    }

    function close() {
      if (!store.getSnapshot().busy && !nestedOpen) onClose();
    }

    function toggleSelected(id) {
      if (!parentAvailable() || !selecting) return;
      setSelected((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }

    function toggleAll() {
      if (!parentAvailable() || !selecting) return;
      const currentVisible = store.getSnapshot().data.terms.filter((term) => matches(term, query));
      setSelected((previous) => {
        const next = new Set(previous);
        const remove =
          currentVisible.length > 0 && currentVisible.every((term) => next.has(term.id));
        for (const term of currentVisible) {
          if (remove) next.delete(term.id);
          else next.add(term.id);
        }
        return next;
      });
    }

    function openEditor(term) {
      if (!parentAvailable() || (selecting && term)) return;
      const current = term && store.getSnapshot().data.terms.find((item) => item.id === term.id);
      if (term && !current) return;
      setEditor(current ? { term: current } : {});
    }

    function removeTerm(id) {
      if (!parentAvailable() || selecting) return;
      if (store.getSnapshot().data.terms.some((term) => term.id === id)) {
        void store.mutate('delete', { id });
      }
    }

    function beginDelete() {
      if (!parentAvailable() || !selecting) return;
      const ids = store
        .getSnapshot()
        .data.terms.filter((term) => selected.has(term.id))
        .map((term) => term.id);
      if (ids.length) setPendingDelete(ids);
    }

    function dismissDelete() {
      if (!store.getSnapshot().busy) setPendingDelete(null);
    }

    async function deleteSelected() {
      const snapshot = store.getSnapshot();
      if (!snapshot.data || snapshot.busy || snapshot.loading || pendingDelete === null) return;
      const chosen = new Set(pendingDelete);
      const ids = snapshot.data.terms.filter((term) => chosen.has(term.id)).map((term) => term.id);
      if (!ids.length) return;
      if (await store.mutate('deleteMany', { ids })) {
        setSelected((previous) => new Set([...previous].filter((id) => !chosen.has(id))));
        setPendingDelete(null);
      }
    }

    function renderRow(term) {
      const drag = dragProps(term, store, busy || selecting || nestedOpen);
      const checked = selected.has(term.id);
      const handle = selecting
        ? h(
            'label',
            { className: 'st-select-control' },
            h('input', {
              type: 'checkbox',
              className: 'st-select-checkbox',
              checked,
              disabled: busy || nestedOpen,
              'aria-label': `${t(checked ? 'deselectTerm' : 'selectTerm')} ${term.name}`,
              onChange: () => toggleSelected(term.id),
            }),
            h(
              'svg',
              {
                width: 12,
                height: 12,
                viewBox: '0 0 16 16',
                'aria-hidden': true,
                focusable: 'false',
              },
              h('path', {
                d: 'm3 8 3 3 7-7',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 2,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              }),
            ),
          )
        : h(
            'button',
            {
              type: 'button',
              className: 'st-btn st-drag-handle',
              draggable: drag.draggable,
              onDragStart: (event) => {
                if (parentAvailable() && !selecting) drag.onDragStart(event);
                else event.preventDefault();
              },
              disabled: busy || nestedOpen,
              title: t('drag'),
              'aria-label': `${t('drag')} ${term.name}`,
              onKeyDown: (event) => {
                if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                event.preventDefault();
                if (!parentAvailable() || selecting) return;
                const currentTerms = store.getSnapshot().data.terms;
                const index = currentTerms.findIndex((item) => item.id === term.id);
                if (index < 0) return;
                const target = currentTerms[index + (event.key === 'ArrowUp' ? -1 : 1)];
                if (target) reorder(store, term.id, target.id);
              },
            },
            h(
              'svg',
              { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
              h('path', {
                d: 'M3 4h10M3 8h10M3 12h10',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
              }),
            ),
          );
      return h(
        'li',
        {
          key: term.id,
          className: 'st-row',
          'data-selected': selecting && checked,
          onDragOver: (event) => {
            if (parentAvailable() && !selecting) drag.onDragOver(event);
          },
          onDrop: (event) => {
            if (parentAvailable() && !selecting) drag.onDrop(event);
          },
        },
        handle,
        h(
          'div',
          { className: 'st-row-main' },
          h('div', { className: 'st-row-name' }, term.name),
          h('div', { className: 'st-row-note' }, term.note || t('noNote')),
        ),
        selecting
          ? null
          : h(
              'div',
              { className: 'st-row-actions' },
              iconButton('edit', t('edit'), () => openEditor(term), {
                disabled: busy || nestedOpen,
                'aria-label': `${t('edit')} ${term.name}`,
              }),
              iconButton('remove', t('remove'), () => removeTerm(term.id), {
                disabled: busy || nestedOpen,
                className: 'st-btn st-danger',
                'aria-label': `${t('remove')} ${term.name}`,
              }),
            ),
      );
    }

    return h(
      React.Fragment,
      null,
      h(
        Modal,
        { title: t('manageTitle'), wide: true, inert: nestedOpen, onClose: close, t },
        h(
          'div',
          { className: 'st-tools' },
          h('label', { className: 'st-sr', htmlFor: searchId }, t('search')),
          h('input', {
            id: searchId,
            autoFocus: true,
            className: 'st-field',
            type: 'search',
            value: query,
            placeholder: t('search'),
            onChange: (event) => {
              if (!nestedOpen) setQuery(event.target.value);
            },
          }),
          iconButton('add', t('add'), () => openEditor(), {
            disabled: busy || !state.data || nestedOpen,
          }),
          iconButton(
            'multiSelect',
            t(selecting ? 'exitMultiSelect' : 'multiSelect'),
            () => {
              if (!parentAvailable()) return;
              setSelecting((value) => !value);
              setSelected(new Set());
            },
            { disabled: busy || !state.data || nestedOpen, 'aria-pressed': selecting },
          ),
        ),
        h(Status, { state, store, t }),
        state.loading ? h('p', { role: 'status' }, t('loading')) : null,
        !state.data && !state.loading
          ? button(t('retry'), () => {
              const snapshot = store.getSnapshot();
              if (!snapshot.busy && !snapshot.loading && !nestedOpen) void store.load();
            })
          : null,
        h(
          'ul',
          { className: 'st-list', 'aria-label': t('terms'), 'aria-busy': busy },
          visible.map(renderRow),
        ),
        state.data && !state.loading && !terms.length
          ? h('p', { className: 'st-manager-empty' }, t('managerEmpty'))
          : state.data && !state.loading && !visible.length
            ? h('p', { className: 'st-manager-empty' }, t('noResults'))
            : null,
        selecting
          ? h(
              'div',
              { className: 'st-selection-footer' },
              h(
                'span',
                { className: 'st-selection-count', role: 'status', 'aria-live': 'polite' },
                t('selected'),
                ' ',
                String(selectedIds.length),
              ),
              button(t(allVisibleSelected ? 'deselectAll' : 'selectAll'), toggleAll, {
                disabled: busy || !visible.length || nestedOpen,
              }),
              iconButton('remove', t('deleteSelected'), beginDelete, {
                disabled: busy || !selectedIds.length || nestedOpen,
                className: 'st-btn st-danger',
              }),
            )
          : null,
      ),
      editor ? h(TermEditor, { ...editor, sessionId, onClose: () => setEditor(null), t }) : null,
      pendingDelete !== null
        ? h(
            Modal,
            { title: t('deleteSelectedTitle'), onClose: dismissDelete, t },
            h(
              'p',
              { role: 'status', 'aria-live': 'polite' },
              t('selected'),
              ' ',
              String(remainingIds.length),
            ),
            h('p', null, t(remainingIds.length ? 'deleteSelectedDetail' : 'noRemainingSelection')),
            state.error
              ? h('p', { className: 'st-error', role: 'alert' }, errorText(state.error, t))
              : null,
            h(
              'div',
              { className: 'st-actions' },
              button(t('cancel'), dismissDelete, { disabled: state.busy, autoFocus: true }),
              button(t('confirmDelete'), deleteSelected, {
                disabled: busy || !remainingIds.length,
                className: 'st-btn st-danger',
              }),
            ),
          )
        : null,
    );
  };
}
