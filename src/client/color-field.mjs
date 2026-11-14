import { normalizeHex, hexToRgb, rgbToHex, rgbToHsv, hsvToRgb } from './color-values.mjs';

const channels = [
  ['r', 'R', 'colorRed', 'colorRedValue'],
  ['g', 'G', 'colorGreen', 'colorGreenValue'],
  ['b', 'B', 'colorBlue', 'colorBlueValue'],
];
const bound = (value, max) => Math.max(0, Math.min(max, value));
const selectionOf = (hex) => ({ hex, hsv: rgbToHsv(hexToRgb(hex)), draft: hex.toUpperCase() });

/** RGB-only editor picker. React is supplied by the host. */
export function createColorField(React) {
  const { createElement: h, useId, useLayoutEffect, useRef, useState } = React;
  return function ColorField({ color, onChange, preview, disabled, t }) {
    const previewRef = useRef(null);
    const swatchRef = useRef(null);
    const panelRef = useRef(null);
    const dragRef = useRef(null);
    const hexRef = useRef(null);
    const id = useId();
    const [open, setOpen] = useState(false);
    const [defaultColor, setDefaultColor] = useState('#000000');
    const resolvedColor = normalizeHex(color) ?? defaultColor;
    const [selection, setSelection] = useState(() => selectionOf(resolvedColor));
    // Keep external reloads in sync without discarding in-progress Hex drafts or
    // the chosen hue when saturation/value is zero.
    let current = selection;
    if (selection.hex !== resolvedColor) {
      current = selectionOf(resolvedColor);
      setSelection(current);
    }
    const { hsv, draft } = current;
    const rgb = hexToRgb(resolvedColor);
    const invalidHex = normalizeHex(draft) === null;

    useLayoutEffect(() => {
      if (color !== null) return;
      const element = previewRef.current;
      const doc = element.ownerDocument;
      const view = doc.defaultView;
      function update() {
        const computed = view.getComputedStyle(element).color;
        const match = computed.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
        if (match) setDefaultColor(rgbToHex({ r: +match[1], g: +match[2], b: +match[3] }));
      }
      update();
      const observer = new view.MutationObserver(update);
      const options = {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'],
      };
      observer.observe(doc.documentElement, options);
      if (doc.body) observer.observe(doc.body, options);
      const scheme = view.matchMedia?.('(prefers-color-scheme: dark)');
      scheme?.addEventListener('change', update);
      return () => {
        observer.disconnect();
        scheme?.removeEventListener('change', update);
      };
    }, [color]);

    useLayoutEffect(() => {
      if (!open) return;
      if (disabled) {
        setOpen(false);
        return;
      }
      const panel = panelRef.current;
      const swatch = swatchRef.current;
      const doc = panel.ownerDocument;
      const view = doc.defaultView;
      panel.showPopover();
      function position() {
        const anchor = swatch.getBoundingClientRect();
        const bounds = panel.getBoundingClientRect();
        const left = bound(anchor.left, Math.max(12, view.innerWidth - bounds.width - 12));
        const below = anchor.bottom + 6;
        const top =
          below + bounds.height <= view.innerHeight - 12 ? below : anchor.top - bounds.height - 6;
        panel.style.left = `${Math.max(12, left)}px`;
        panel.style.top = `${Math.max(12, Math.min(top, view.innerHeight - bounds.height - 12))}px`;
      }
      function outside(event) {
        if (!panel.contains(event.target) && !swatch.contains(event.target)) setOpen(false);
      }
      function escape(event) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        swatch.focus({ preventScroll: true });
      }
      position();
      panel.querySelector('input')?.focus({ preventScroll: true });
      doc.addEventListener('pointerdown', outside, true);
      doc.addEventListener('click', outside, true);
      doc.addEventListener('keydown', escape, true);
      doc.addEventListener('scroll', position, true);
      view.addEventListener('resize', position);
      return () => {
        dragRef.current = null;
        doc.removeEventListener('pointerdown', outside, true);
        doc.removeEventListener('click', outside, true);
        doc.removeEventListener('keydown', escape, true);
        doc.removeEventListener('scroll', position, true);
        view.removeEventListener('resize', position);
        if (panel.isConnected) panel.hidePopover();
      };
    }, [open, disabled]);

    function applyHsv(next) {
      if (disabled) return;
      const hex = rgbToHex(hsvToRgb(next));
      setSelection({ hex, hsv: next, draft: hex.toUpperCase() });
      onChange(hex);
    }
    function applyRgb(next) {
      if (disabled) return;
      const hex = rgbToHex(next);
      const nextHsv = rgbToHsv(hexToRgb(hex));
      if (nextHsv.s === 0) nextHsv.h = hsv.h;
      setSelection({ hex, hsv: nextHsv, draft: hex.toUpperCase() });
      onChange(hex);
    }
    function number(event, max, apply) {
      if (event.target.value === '') return;
      const value = Number(event.target.value);
      if (Number.isFinite(value)) apply(bound(value, max));
    }
    function point(event) {
      const rect = event.currentTarget.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      applyHsv({
        ...hsv,
        s: bound(((event.clientX - rect.left) / rect.width) * 100, 100),
        v: 100 - bound(((event.clientY - rect.top) / rect.height) * 100, 100),
      });
    }
    function resetDraft() {
      setSelection({ ...current, draft: resolvedColor.toUpperCase() });
    }
    function close() {
      setOpen(false);
      resetDraft();
      swatchRef.current.focus({ preventScroll: true });
    }
    function reset() {
      setSelection(selectionOf(defaultColor));
      onChange(null);
    }

    return h(
      'div',
      { className: 'st-color-row' },
      h('span', { className: 'st-color-label' }, t('color')),
      h(
        'button',
        {
          ref: swatchRef,
          type: 'button',
          className: 'st-color-button',
          disabled,
          'aria-label': t('color'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-controls': open ? `${id}-picker` : undefined,
          onClick: () => {
            resetDraft();
            setOpen(!open);
          },
        },
        h('span', { className: 'st-color-swatch', style: { backgroundColor: resolvedColor } }),
        h('span', { 'aria-hidden': true, className: 'st-color-chevron' }, '▾'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'st-btn st-color-default',
          disabled,
          'aria-pressed': color === null,
          onClick: reset,
        },
        t('defaultColor'),
      ),
      h(
        'span',
        {
          ref: previewRef,
          className: 'st-color-preview',
          style: { color: color ?? undefined },
        },
        preview || t('colorPreview'),
      ),
      open && !disabled
        ? h(
            'div',
            {
              ref: panelRef,
              id: `${id}-picker`,
              className: 'st-color-popover',
              popover: 'manual',
              role: 'dialog',
              'aria-labelledby': `${id}-title`,
              onKeyDown(event) {
                if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.target === hexRef.current) resetDraft();
                }
              },
            },
            h(
              'header',
              { className: 'st-color-picker-head' },
              h('strong', { id: `${id}-title` }, t('colorPicker')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'st-btn st-color-close',
                  'aria-label': t('closeColorPicker'),
                  onClick: close,
                },
                '×',
              ),
            ),
            h('div', {
              className: 'st-color-sv',
              'aria-hidden': true,
              style: { backgroundColor: `hsl(${hsv.h} 100% 50%)` },
              onPointerDown(event) {
                if (event.button !== 0 || disabled) return;
                event.preventDefault();
                dragRef.current = event.pointerId ?? 'mouse';
                if (event.pointerId !== undefined)
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                point(event);
              },
              onPointerMove(event) {
                if (dragRef.current === (event.pointerId ?? 'mouse')) point(event);
              },
              onPointerUp(event) {
                dragRef.current = null;
                if (event.currentTarget.hasPointerCapture?.(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              },
              onPointerCancel: () => {
                dragRef.current = null;
              },
              onLostPointerCapture: () => {
                dragRef.current = null;
              },
              children: h('span', {
                className: 'st-color-sv-cursor',
                style: { left: `${hsv.s}%`, top: `${100 - hsv.v}%` },
              }),
            }),
            h(
              'label',
              { className: 'st-color-hue-label' },
              t('colorHue'),
              h('input', {
                type: 'range',
                className: 'st-color-range st-color-hue',
                min: 0,
                max: 360,
                step: 1,
                value: Math.round(hsv.h),
                'aria-label': t('colorHue'),
                onChange: (event) => number(event, 360, (h) => applyHsv({ ...hsv, h })),
              }),
            ),
            h(
              'div',
              { className: 'st-color-percentages' },
              ...[
                ['s', 'colorSaturation'],
                ['v', 'colorValue'],
              ].map(([key, label]) =>
                h(
                  'label',
                  { key, className: 'st-color-percentage' },
                  t(label),
                  h(
                    'span',
                    null,
                    h('input', {
                      type: 'number',
                      className: 'st-field st-color-number',
                      min: 0,
                      max: 100,
                      step: 1,
                      value: Math.round(hsv[key]),
                      'aria-label': t(label),
                      onChange: (event) =>
                        number(event, 100, (value) => applyHsv({ ...hsv, [key]: value })),
                    }),
                    h('span', { 'aria-hidden': true }, '%'),
                  ),
                ),
              ),
            ),
            h(
              'div',
              { className: 'st-color-channels' },
              ...channels.map(([key, label, sliderLabel, valueLabel]) =>
                h(
                  'div',
                  { key, className: 'st-color-channel' },
                  h('span', { 'aria-hidden': true }, label),
                  h('input', {
                    type: 'range',
                    className: 'st-color-range',
                    min: 0,
                    max: 255,
                    step: 1,
                    value: rgb[key],
                    style: {
                      background: `linear-gradient(to right, ${rgbToHex({ ...rgb, [key]: 0 })}, ${rgbToHex({ ...rgb, [key]: 255 })})`,
                    },
                    'aria-label': t(sliderLabel),
                    onChange: (event) =>
                      number(event, 255, (value) => applyRgb({ ...rgb, [key]: value })),
                  }),
                  h('input', {
                    type: 'number',
                    className: 'st-field st-color-number',
                    min: 0,
                    max: 255,
                    step: 1,
                    value: rgb[key],
                    'aria-label': t(valueLabel),
                    onChange: (event) =>
                      number(event, 255, (value) => applyRgb({ ...rgb, [key]: value })),
                  }),
                ),
              ),
            ),
            h(
              'label',
              { className: 'st-color-hex-label' },
              t('colorHex'),
              h('input', {
                ref: hexRef,
                type: 'text',
                className: 'st-field st-color-hex',
                value: draft,
                maxLength: 7,
                autoComplete: 'off',
                spellCheck: false,
                'aria-label': t('colorHex'),
                'aria-invalid': invalidHex,
                'aria-describedby': invalidHex ? `${id}-hex-error` : undefined,
                onChange(event) {
                  const draft = event.target.value;
                  const hex = normalizeHex(draft);
                  if (hex) {
                    const next = selectionOf(hex);
                    if (next.hsv.s === 0) next.hsv.h = hsv.h;
                    setSelection({ ...next, draft });
                    onChange(hex);
                  } else setSelection({ ...current, draft });
                },
                onBlur: resetDraft,
              }),
            ),
            invalidHex
              ? h(
                  'p',
                  { className: 'st-color-hex-error', id: `${id}-hex-error` },
                  t('colorHexInvalid'),
                )
              : null,
            h(
              'p',
              { className: 'st-color-state' },
              t(color === null ? 'defaultColor' : 'customColor'),
            ),
          )
        : null,
    );
  };
}
