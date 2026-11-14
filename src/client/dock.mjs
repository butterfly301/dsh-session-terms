import {
  collectSelection,
  dragProps,
  matches,
  quoteSelection,
  scrollCollapsedTerms,
} from './interactions.mjs';

export function createDock({ React, useTerms, ui, TermEditor, Manager, focusInput }) {
  const h = React.createElement;
  const { useEffect, useId, useRef, useState } = React;
  const { button, iconButton, Modal, errorText } = ui;

  function TermChip({ term, store, busy, onInsert, onContext, t }) {
    const id = useId();
    const ref = useRef(null);
    const tipRef = useRef(null);
    const hideTimer = useRef();
    const captured = useRef(null);
    useEffect(() => () => clearTimeout(hideTimer.current), []);

    function show() {
      clearTimeout(hideTimer.current);
      const tip = tipRef.current;
      if (!tip || typeof tip.showPopover !== 'function') return;
      const rect = ref.current.getBoundingClientRect();
      tip.showPopover();
      const bounds = tip.getBoundingClientRect();
      tip.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - bounds.width - 8))}px`;
      tip.style.top = `${Math.max(8, rect.top - bounds.height - 6)}px`;
    }
    function hide() {
      hideTimer.current = setTimeout(() => tipRef.current?.hidePopover?.(), 160);
    }

    return h(
      'span',
      { className: 'st-chipwrap', ...dragProps(term, store, busy) },
      h(
        'button',
        {
          ref,
          type: 'button',
          className: 'st-chip',
          disabled: busy,
          'aria-describedby': id,
          onPointerDown(event) {
            if (event.button === 0) captured.current = onInsert.capture();
          },
          onClick() {
            onInsert.insert(term.name, captured.current);
            captured.current = null;
          },
          onMouseEnter: show,
          onMouseLeave: hide,
          onFocus: show,
          onBlur: hide,
          onContextMenu(event) {
            event.preventDefault();
            tipRef.current?.hidePopover?.();
            onContext(term);
          },
          onKeyDown(event) {
            if (event.key === 'Escape') tipRef.current?.hidePopover?.();
            if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
              event.preventDefault();
              onContext(term);
            }
          },
        },
        term.name,
      ),
      h(
        'div',
        {
          ref: tipRef,
          id,
          className: 'st-tip',
          role: 'tooltip',
          popover: 'manual',
          tabIndex: 0,
          onMouseEnter: () => clearTimeout(hideTimer.current),
          onMouseLeave: hide,
          onFocus: () => clearTimeout(hideTimer.current),
          onBlur: hide,
          onKeyDown(event) {
            if (event.key === 'Escape') tipRef.current?.hidePopover?.();
          },
        },
        term.note || t('noNote'),
      ),
    );
  }

  function CollapsedTerms({ children }) {
    const ref = useRef(null);
    useEffect(() => {
      const element = ref.current;
      const wheel = (event) => scrollCollapsedTerms(event, element);
      element.addEventListener('wheel', wheel, { passive: false });
      return () => element.removeEventListener('wheel', wheel);
    }, []);
    return h('div', { ref, className: 'st-collapsed' }, children);
  }

  function TermsDock({ sessionId, inputActions, t }) {
    const [state, store] = useTerms(sessionId);
    const [query, setQuery] = useState('');
    const [manager, setManager] = useState(false);
    const [contextTerm, setContextTerm] = useState(null);
    const data = state.data;
    const busy = state.busy || state.loading;
    const expanded = data?.expanded ?? false;
    const searchId = useId();
    const insertion = {
      capture() {
        try {
          return inputActions?.captureInsertion?.() ?? null;
        } catch {
          store.setError({ code: 'insertFailed' });
          return null;
        }
      },
      insert(text, span) {
        try {
          const captured = span ?? inputActions?.captureInsertion?.();
          if (!captured || inputActions?.insertText?.(text, captured) !== true) {
            store.setError({ code: 'insertFailed' });
            return;
          }
          store.setError(null);
          focusInput(sessionId);
        } catch {
          store.setError({ code: 'insertFailed' });
        }
      },
    };
    const chips = data?.terms
      .filter((term) => !expanded || matches(term, query))
      .map((term) =>
        h(TermChip, {
          key: term.id,
          term,
          store,
          busy,
          onInsert: insertion,
          onContext: setContextTerm,
          t,
        }),
      );
    const undo = () =>
      button(t('undo'), () => void store.mutate('restore', state.undo), { disabled: busy });
    const retry = () => button(t('retry'), () => void store.load(), { disabled: busy });
    const collapsedContents = data
      ? chips
      : state.error
        ? h(
            'span',
            { className: 'st-status st-error', role: 'alert', title: errorText(state.error, t) },
            errorText(state.error, t),
          )
        : h('span', { className: 'st-status', role: 'status' }, t('loading'));

    return h(
      React.Fragment,
      null,
      h(
        'section',
        {
          className: 'st-root',
          'data-expanded': expanded,
          'aria-label': t('terms'),
          'aria-busy': busy,
        },
        h(
          'div',
          { className: 'st-head' },
          h('span', { className: 'st-title' }, t('terms')),
          h(
            'span',
            { className: 'st-count', 'aria-label': t('total') },
            data ? String(data.terms.length) : '—',
          ),
          expanded
            ? h('span', { className: 'st-spacer' })
            : h(CollapsedTerms, null, collapsedContents),
          !expanded && state.undo ? undo() : null,
          !expanded && !data && !busy ? retry() : null,
          iconButton('add', t('add'), () => store.openEditor({}), { disabled: busy || !data }),
          iconButton('manage', t('manage'), () => setManager(true)),
          button(
            h(
              'svg',
              {
                width: 14,
                height: 14,
                viewBox: '0 0 16 16',
                'aria-hidden': true,
                focusable: 'false',
              },
              h('path', {
                d: expanded ? 'm4 6 4 4 4-4' : 'M4 10 8 6l4 4',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              }),
            ),
            () => void store.mutate('setExpanded', { expanded: !expanded }),
            {
              disabled: busy || !data,
              title: t(expanded ? 'collapse' : 'expand'),
              'aria-label': t(expanded ? 'collapse' : 'expand'),
              'aria-expanded': expanded,
            },
          ),
        ),
        expanded
          ? h(
              React.Fragment,
              null,
              h('label', { className: 'st-sr', htmlFor: searchId }, t('search')),
              h('input', {
                id: searchId,
                type: 'search',
                className: 'st-field st-search',
                placeholder: t('search'),
                value: query,
                onChange: (event) => setQuery(event.target.value),
              }),
              h(
                'div',
                { className: 'st-grid' },
                chips?.length
                  ? chips
                  : query
                    ? h('span', { className: 'st-muted' }, t('noResults'))
                    : null,
              ),
            )
          : null,
        expanded && state.error
          ? h(
              'div',
              { className: 'st-notice' },
              h(
                'span',
                { className: 'st-status st-error', role: 'alert' },
                errorText(state.error, t),
              ),
              !data ? retry() : null,
            )
          : null,
        expanded && state.loading && !data
          ? h('span', { className: 'st-status', role: 'status' }, t('loading'))
          : null,
        expanded && state.undo
          ? h(
              'div',
              { className: 'st-notice', role: 'status' },
              h('span', { className: 'st-status' }, t('deleted')),
              undo(),
            )
          : null,
      ),
      manager ? h(Manager, { sessionId, onClose: () => setManager(false), t }) : null,
      state.editorRequest
        ? h(TermEditor, {
            ...state.editorRequest,
            key: state.editorRequest.term
              ? `term:${state.editorRequest.term.id}`
              : `new:${state.editorRequest.initialName ?? ''}`,
            sessionId,
            onClose: () => store.closeEditor(),
            t,
          })
        : null,
      contextTerm
        ? h(
            Modal,
            { title: contextTerm.name, onClose: () => setContextTerm(null), t },
            h(
              'p',
              { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
              contextTerm.note || t('noNote'),
            ),
            h(
              'div',
              { className: 'st-actions' },
              iconButton('edit', t('edit'), () => {
                store.openEditor({ term: contextTerm });
                setContextTerm(null);
              }),
              iconButton(
                'remove',
                t('remove'),
                () => {
                  void store.mutate('delete', { id: contextTerm.id });
                  setContextTerm(null);
                },
                { disabled: busy, className: 'st-btn st-danger' },
              ),
            ),
          )
        : null,
    );
  }

  function SelectionActions(props) {
    const { sessionId, useSession, dismiss, t } = props;
    const [state, store] = useTerms(sessionId);
    const enabled = useSession(
      (session) =>
        !session.removed &&
        (session.subagent === null ||
          (session.subagent.address.mode === 'continuable' &&
            session.subagent.parentAvailable === true)),
    );
    useEffect(() => {
      if (!enabled) dismiss();
    }, [enabled, dismiss]);
    if (!enabled) return null;
    const preserveSelection = (event) => event.preventDefault();
    return h(
      'div',
      { className: 'st-selection-actions' },
      button(t('quoteText'), () => quoteSelection(props), { onPointerDown: preserveSelection }),
      button(t('pin'), () => collectSelection(props, store), {
        onPointerDown: preserveSelection,
        disabled: state.busy,
      }),
    );
  }

  function StartedTermsDock(props) {
    const started = props.useSession((session) =>
      Boolean(
        session &&
        (session.running ||
          session.promptAttempted ||
          (session.blank === false && !session.awaitingFirstTurn)),
      ),
    );
    return started ? h(TermsDock, { ...props, key: props.sessionId }) : null;
  }

  return { StartedTermsDock, SelectionActions };
}
