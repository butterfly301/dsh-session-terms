const ICON_PATHS = {
  close: 'M4 4l8 8M12 4l-8 8',
  add: 'M8 3v10M3 8h10',
  manage: 'M6 4h7M6 8h7M6 12h7M3 4h.01M3 8h.01M3 12h.01',
  multiSelect: 'm2 4 1 1 2-2M7 4h7m-12 8 1 1 2-2M7 12h7',
  edit: 'm10 3 3 3M3 10l8-8a1.4 1.4 0 0 1 2 2l-8 8-3 1z',
  remove: 'M2.5 4.5h11M6 4.5V2.5h4v2M4 4.5l.6 9h6.8l.6-9M6.5 7v4M9.5 7v4',
};

/** React comes from the host, so the published client never bundles another copy. */
export function createUiPrimitives(React, errorCodes) {
  const h = React.createElement;
  const { useEffect, useId, useRef } = React;
  const knownErrors = new Set(errorCodes);
  const clientErrors = new Set(['transport', 'invalid', 'insertFailed', 'selectionExpired']);
  const icons = Object.fromEntries(
    Object.entries(ICON_PATHS).map(([name, d]) => [
      name,
      h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
        },
        h('path', { d }),
      ),
    ]),
  );

  function errorText(error, t) {
    if (!error) return '';
    const code = typeof error === 'object' ? error.code : '';
    if (knownErrors.has(code)) return t(`errors.${code}`);
    return t(clientErrors.has(code) ? code : 'failed');
  }

  function button(label, onClick, options = {}) {
    return h('button', { type: 'button', className: 'st-btn', onClick, ...options }, label);
  }

  function iconButton(action, label, onClick, options = {}) {
    return button(icons[action], onClick, {
      title: label,
      'aria-label': label,
      ...options,
      className: `${options.className ?? 'st-btn'} st-icon-btn`,
    });
  }

  function Modal({ title, onClose, children, t, wide = false, inert = false }) {
    const ref = useRef(null);
    const titleId = useId();
    useEffect(() => {
      const dialog = ref.current;
      const previous = dialog.ownerDocument.activeElement;
      dialog.showPopover();
      return () => {
        dialog.hidePopover();
        if (dialog.contains(dialog.ownerDocument.activeElement) && previous?.isConnected) {
          previous.focus?.({ preventScroll: true });
        }
      };
    }, []);

    return h(
      'dialog',
      {
        ref,
        popover: 'manual',
        inert,
        className: wide ? 'st-dialog st-dialog-wide' : 'st-dialog',
        'aria-labelledby': titleId,
        onKeyDown(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
          }
        },
        onCancel: (event) => event.preventDefault(),
      },
      h(
        'header',
        { className: 'st-dialog-head' },
        h('h2', { id: titleId }, title),
        wide ? iconButton('close', t('close'), onClose) : button(t('close'), onClose),
      ),
      h('div', { className: 'st-body' }, children),
    );
  }

  function Status({ state, store, t }) {
    return h(
      React.Fragment,
      null,
      state.error
        ? h('p', { className: 'st-error', role: 'alert' }, errorText(state.error, t))
        : null,
      state.undo
        ? h(
            'div',
            { className: 'st-notice', role: 'status' },
            h('span', null, t('deleted')),
            button(t('undo'), () => void store.mutate('restore', state.undo), {
              disabled: state.busy || state.loading,
            }),
          )
        : null,
    );
  }

  return { button, iconButton, Modal, Status, errorText };
}
