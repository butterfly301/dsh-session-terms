import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';

// Install the DOM before importing React DOM so it selects modern input events.
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://localhost/',
});
for (const name of [
  'window',
  'document',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'navigator',
]) {
  Object.defineProperty(globalThis, name, {
    value: dom.window[name],
    configurable: true,
    writable: true,
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no top layer. Only that browser primitive is shimmed; components,
// hooks, subscriptions, DOM inputs and event handling use actual React.
dom.window.HTMLElement.prototype.showPopover = function () {
  this.dataset.popoverOpen = '';
};
dom.window.HTMLElement.prototype.hidePopover = function () {
  delete this.dataset.popoverOpen;
};
const { createRoot } = await import('react-dom/client');
export { React };

export async function mount(element) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await React.act(async () => {
    root.render(element);
  });
  return {
    container,
    async unmount() {
      await React.act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

export async function click(element) {
  assert(element, 'expected clickable element');
  await React.act(async () => {
    element.click();
  });
}

export async function input(element, value) {
  assert(element, 'expected input element');
  const prototype =
    element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
  await React.act(async () => {
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export function button(container, text) {
  const found = [...container.querySelectorAll('button')].find(
    (node) => node.textContent === text || node.getAttribute('aria-label') === text,
  );
  assert(found, `button exists: ${text}`);
  return found;
}

export async function submit(form) {
  assert(form, 'expected form');
  await React.act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
