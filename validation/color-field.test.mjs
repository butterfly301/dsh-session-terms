import test from 'node:test';
import assert from 'node:assert/strict';
import { React, mount, input, click, button } from './dom.mjs';
import { createColorField } from '../src/client/color-field.mjs';

const Field = createColorField(React);
async function openCustom(container) {
  await click(button(container, 'color'));
  await click(button(container, 'customColor'));
}
async function pick(container, value) {
  await openCustom(container);
  await input(container.querySelector('.st-color-hex'), value);
  await click(button(container, 'closeColorPicker'));
}

async function controlled(initialColor = '#ff0000', options = {}) {
  const values = [];
  function Controlled() {
    const [color, setColor] = React.useState(initialColor);
    return React.createElement(Field, {
      color,
      preview: 'Alpha',
      t: (key) => key,
      ...options,
      onChange(value) {
        values.push(value);
        setColor(value);
      },
    });
  }
  return { ...(await mount(React.createElement(Controlled))), values };
}

test('swatch opens presets first and choosing a preset applies it and restores focus', async () => {
  const f = await controlled(null);
  try {
    await click(button(f.container, 'color'));
    const panel = f.container.querySelector('.st-color-palette');
    assert(panel);
    const choices = [...panel.querySelectorAll('.st-color-preset')];
    assert.equal(choices.length, 12);
    assert.equal(panel.querySelector('input'), null);
    assert.equal(panel.querySelector('.st-color-sv'), null);
    assert.equal(panel.querySelectorAll('.st-color-custom').length, 1);
    assert.equal(
      choices.filter((choice) => choice.getAttribute('aria-pressed') === 'true').length,
      0,
    );
    await click(choices[0]);
    assert.deepEqual(f.values, ['#e53935']);
    assert.equal(f.container.querySelector('.st-color-popover'), null);
    assert.equal(
      f.container.querySelector('.st-color-swatch').style.backgroundColor,
      'rgb(229, 57, 53)',
    );
    assert.equal(document.activeElement, button(f.container, 'color'));
    await click(button(f.container, 'color'));
    assert.equal(f.container.querySelectorAll('.st-color-preset[aria-pressed="true"]').length, 1);
    assert.equal(
      f.container.querySelectorAll('.st-color-preset[aria-pressed="true"] svg').length,
      1,
    );
    assert.equal(
      document.activeElement,
      f.container.querySelector('.st-color-preset[aria-pressed="true"]'),
    );
  } finally {
    await f.unmount();
  }
});

test('custom action replaces the palette with the detailed picker without changing color', async () => {
  const f = await controlled('#2868b4');
  try {
    await click(button(f.container, 'color'));
    assert.equal(f.container.querySelector('.st-color-hex'), null);
    await click(button(f.container, 'customColor'));
    assert.equal(f.container.querySelectorAll('.st-color-popover').length, 1);
    assert.equal(f.container.querySelector('.st-color-palette'), null);
    assert.equal(f.container.querySelector('.st-color-preset'), null);
    assert(f.container.querySelector('.st-color-sv'));
    assert.equal(f.container.querySelector('.st-color-hex').value, '#2868B4');
    assert.equal(f.container.querySelector('.st-color-percentages'), null);
    assert.equal(f.container.querySelector('.st-color-state'), null);
    assert.equal(
      f.container.querySelector('.st-color-popover').textContent.includes('defaultColor'),
      false,
    );
    assert.deepEqual(f.values, []);
    assert.equal(document.activeElement, f.container.querySelector('.st-color-sv'));
  } finally {
    await f.unmount();
  }
});

test('default swatch follows theme text, custom color stays fixed, reset immediately shows default', async () => {
  const originalStyle = document.body.getAttribute('style');
  document.body.style.color = 'rgb(17, 34, 51)';
  const values = [];
  function Controlled() {
    const [color, setColor] = React.useState(null);
    return React.createElement(Field, {
      color,
      preview: 'Alpha',
      disabled: false,
      t: (key) => key,
      onChange(value) {
        values.push(value);
        setColor(value);
      },
    });
  }
  const mounted = await mount(React.createElement(Controlled));
  const picker = () => mounted.container.querySelector('.st-color-swatch');
  const preview = () => mounted.container.querySelector('.st-color-preview');
  try {
    assert.equal(picker().style.backgroundColor, 'rgb(17, 34, 51)');
    assert.equal(window.getComputedStyle(preview()).color, 'rgb(17, 34, 51)');
    assert.equal(button(mounted.container, 'defaultColor').getAttribute('aria-pressed'), 'true');
    await React.act(async () => {
      document.body.style.color = 'rgb(226, 232, 240)';
    });
    assert.equal(picker().style.backgroundColor, 'rgb(226, 232, 240)');
    await pick(mounted.container, '#b45309');
    assert.equal(preview().style.color, 'rgb(180, 83, 9)');
    assert.equal(button(mounted.container, 'defaultColor').getAttribute('aria-pressed'), 'false');
    await React.act(async () => {
      document.body.style.color = 'rgb(32, 40, 48)';
    });
    assert.equal(picker().style.backgroundColor, 'rgb(180, 83, 9)');
    await click(button(mounted.container, 'defaultColor'));
    assert.equal(picker().style.backgroundColor, 'rgb(32, 40, 48)');
    assert.equal(preview().style.color, '');
    assert.equal(window.getComputedStyle(preview()).color, 'rgb(32, 40, 48)');
    assert.equal(button(mounted.container, 'defaultColor').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(values, ['#b45309', null]);
  } finally {
    await mounted.unmount();
    if (originalStyle === null) document.body.removeAttribute('style');
    else document.body.setAttribute('style', originalStyle);
  }
});

test('color field releases theme observation on custom selection and unmount', async () => {
  const Original = window.MutationObserver;
  let active = 0;
  window.MutationObserver = class {
    constructor(callback) {
      this.observer = new Original(callback);
      this.watching = false;
    }
    observe(...args) {
      if (!this.watching) {
        active++;
        this.watching = true;
      }
      this.observer.observe(...args);
    }
    disconnect() {
      if (this.watching) {
        active--;
        this.watching = false;
      }
      this.observer.disconnect();
    }
  };
  function Controlled() {
    const [color, setColor] = React.useState(null);
    return React.createElement(Field, {
      color,
      onChange: setColor,
      preview: 'Alpha',
      t: (key) => key,
    });
  }
  const mounted = await mount(React.createElement(Controlled));
  try {
    assert.equal(active, 1);
    await pick(mounted.container, '#abcdef');
    assert.equal(active, 0);
    await click(button(mounted.container, 'defaultColor'));
    assert.equal(active, 1);
  } finally {
    await mounted.unmount();
    window.MutationObserver = Original;
  }
  assert.equal(active, 0);
});

test('custom picker keeps RGB, hue, SV keyboard controls and Hex synchronized without removed fields', async () => {
  const f = await controlled();
  const field = (label) => f.container.querySelector(`[aria-label="${label}"]`);
  try {
    await openCustom(f.container);
    assert.equal(f.container.querySelector('input[type="color"]'), null);
    assert.equal(f.container.querySelectorAll('input[type="range"]').length, 4);
    assert.equal(f.container.querySelectorAll('input[type="number"]').length, 3);
    assert.equal(f.container.querySelector('.st-color-percentages'), null);
    assert.equal(f.container.querySelector('.st-color-state'), null);
    assert.equal(field('colorSaturation'), null);
    assert.equal(field('colorValue'), null);
    await input(field('colorHue'), '120');
    assert.equal(field('colorHex').value, '#00FF00');
    const square = f.container.querySelector('.st-color-sv');
    for (const [key, expected] of [
      ['ArrowDown', '#00E600'],
      ['ArrowUp', '#00FF00'],
      ['ArrowLeft', '#19FF19'],
      ['ArrowRight', '#00FF00'],
    ]) {
      await React.act(async () =>
        square.dispatchEvent(
          new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true, cancelable: true }),
        ),
      );
      assert.equal(field('colorHex').value, expected);
    }
    await input(field('colorHex'), '#808080');
    assert.equal(field('colorHue').value, '120');
    await input(field('colorHex'), '#008000');
    await input(field('colorBlueValue'), '255');
    assert.equal(field('colorHex').value, '#0080FF');
    assert.equal(field('colorBlue').value, '255');
    await input(field('colorRedValue'), '999');
    assert.equal(field('colorRedValue').value, '255');
    assert.equal(field('colorHex').value, '#FF80FF');
    await input(field('colorRed'), '0');
    assert.equal(field('colorRedValue').value, '0');
    assert(f.values.every((value) => /^#[\da-f]{6}$/.test(value)));
  } finally {
    await f.unmount();
  }
});

test('partial and invalid Hex drafts never replace the selected color and blur restores the committed value', async () => {
  const f = await controlled('#2868b4');
  try {
    await openCustom(f.container);
    const hex = f.container.querySelector('.st-color-hex');
    for (const draft of ['#12', '#11223344', 'orange', '#12GG44']) {
      await input(hex, draft);
      assert.equal(hex.getAttribute('aria-invalid'), 'true');
      assert.equal(
        f.container.querySelector('.st-color-swatch').style.backgroundColor,
        'rgb(40, 104, 180)',
      );
      assert.equal(f.values.length, 0);
    }
    await input(hex, '00FF00');
    assert.deepEqual(f.values, ['#00ff00']);
    assert.equal(hex.getAttribute('aria-invalid'), 'false');
    await React.act(async () => hex.focus());
    await input(hex, '#0');
    await React.act(async () => hex.blur());
    assert.equal(hex.value, '#00FF00');
    assert.equal(hex.getAttribute('aria-invalid'), 'false');
  } finally {
    await f.unmount();
  }
});

test('SV square supports pointer selection and bounded dragging without changing color after release', async () => {
  const f = await controlled();
  try {
    await openCustom(f.container);
    const square = f.container.querySelector('.st-color-sv');
    square.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
    async function pointer(type, x, y) {
      await React.act(async () =>
        square.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: x,
            clientY: y,
          }),
        ),
      );
    }
    await pointer('pointerdown', 50, 50);
    assert.equal(f.values.at(-1), '#804040');
    await pointer('pointermove', 200, -20);
    assert.equal(f.values.at(-1), '#ff0000');
    await pointer('pointerup', 200, -20);
    const count = f.values.length;
    await pointer('pointermove', 0, 100);
    assert.equal(f.values.length, count);
  } finally {
    await f.unmount();
  }
});

test('picker Enter and Escape never reach the parent form; outside clicks close only the picker', async () => {
  let submitted = 0;
  let escaped = 0;
  const f = await mount(
    React.createElement(
      'form',
      {
        onSubmit(event) {
          event.preventDefault();
          submitted++;
        },
        onKeyDown(event) {
          if (event.key === 'Escape') escaped++;
        },
      },
      React.createElement(Field, { color: '#2868b4', onChange() {}, t: (key) => key }),
      React.createElement('input', { 'aria-label': 'outside' }),
    ),
  );
  try {
    await openCustom(f.container);
    let panel = f.container.querySelector('.st-color-popover');
    const hex = panel.querySelector('.st-color-hex');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await React.act(async () => hex.dispatchEvent(enter));
    assert.equal(enter.defaultPrevented, true);
    assert.equal(submitted, 0);
    assert(f.container.querySelector('.st-color-popover'));
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await React.act(async () => hex.dispatchEvent(escape));
    assert.equal(escape.defaultPrevented, true);
    assert.equal(escaped, 0);
    assert.equal(f.container.querySelector('.st-color-popover'), null);
    assert.equal(document.activeElement, button(f.container, 'color'));
    await openCustom(f.container);
    panel = f.container.querySelector('.st-color-popover');
    assert.equal(panel.getAttribute('role'), 'dialog');
    assert.equal(panel.getAttribute('popover'), 'manual');
    assert.equal(button(f.container, 'color').getAttribute('aria-expanded'), 'true');
    await click(f.container.querySelector('[aria-label="outside"]'));
    assert.equal(f.container.querySelector('.st-color-popover'), null);
    assert(f.container.querySelector('form'));
    assert.equal(submitted, 0);
  } finally {
    await f.unmount();
  }
});

test('disabled color field cannot open the picker or reset the selection', async () => {
  const f = await controlled('#2868b4', { disabled: true });
  try {
    assert.equal(button(f.container, 'color').disabled, true);
    assert.equal(button(f.container, 'defaultColor').disabled, true);
    await click(button(f.container, 'color'));
    await click(button(f.container, 'defaultColor'));
    assert.equal(f.container.querySelector('.st-color-popover'), null);
    assert.deepEqual(f.values, []);
  } finally {
    await f.unmount();
  }
});
