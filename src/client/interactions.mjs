const DRAG_TYPE = 'application/x-dsh-session-term';

export function matches(term, query) {
  return `${term.name}\n${term.note}`
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());
}

export function reorder(store, sourceId, targetId) {
  const data = store.getSnapshot().data;
  if (!data || sourceId === targetId) return;
  const ids = data.terms.map((term) => term.id);
  const from = ids.indexOf(sourceId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0) return;
  ids.splice(from, 1);
  ids.splice(to, 0, sourceId);
  void store.mutate('reorder', { ids });
}

export function dragProps(term, store, disabled) {
  return {
    draggable: !disabled,
    onDragStart(event) {
      if (disabled) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(DRAG_TYPE, term.id);
    },
    onDragOver(event) {
      if (disabled || ![...event.dataTransfer.types].includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    },
    onDrop(event) {
      if (disabled) return;
      const id = event.dataTransfer.getData(DRAG_TYPE);
      if (!id) return;
      event.preventDefault();
      reorder(store, id, term.id);
    },
  };
}

/** An overflowing row owns wheel input, including momentum at either edge. */
export function scrollCollapsedTerms(event, element) {
  if (event.ctrlKey || !element || element.scrollWidth <= element.clientWidth) return;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  const scale = event.deltaMode === 1 ? 28 : event.deltaMode === 2 ? element.clientWidth : 1;
  event.preventDefault();
  element.scrollLeft = Math.max(
    0,
    Math.min(element.scrollWidth - element.clientWidth, element.scrollLeft + delta * scale),
  );
}

export function quoteSelection({ readText, inputActions, clearSelection, dismiss }) {
  const text = readText();
  if (text === null) {
    dismiss();
    return;
  }
  if (!inputActions.insertQuote(text)) return;
  clearSelection();
  dismiss();
}

export function collectSelection({ readText, clearSelection, dismiss }, store) {
  const text = readText();
  if (typeof text !== 'string' || !text.trim()) {
    store.setError({ code: 'selectionExpired' });
    dismiss();
    return;
  }
  const name = text.trim();
  const existing = store.getSnapshot().data?.terms.find((term) => term.name === name);
  // The dock owns the editor; dismissing the transient selection must not close it.
  store.openEditor(existing ? { term: existing } : { initialName: name });
  clearSelection();
  dismiss();
}
