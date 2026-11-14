import test from 'node:test';
import assert from 'node:assert/strict';
import { scrollCollapsedTerms as scroll } from '../src/client/interactions.mjs';
function step(overrides = {}, elementOverrides = {}) {
  let prevented = false;
  const element = { scrollLeft: 0, scrollWidth: 900, clientWidth: 300, ...elementOverrides };
  const event = {
    ctrlKey: false,
    deltaX: 0,
    deltaY: 50,
    deltaMode: 0,
    preventDefault() {
      prevented = true;
    },
    ...overrides,
  };
  scroll(event, element);
  return { element, prevented };
}
test('vertical wheel scrolls terms horizontally and does not scroll chat', () => {
  const result = step();
  assert.equal(result.element.scrollLeft, 50);
  assert(result.prevented);
});
test('trackpad horizontal direction and reverse wheel are preserved', () => {
  assert.equal(step({ deltaX: 80, deltaY: 10 }).element.scrollLeft, 80);
  assert.equal(step({ deltaY: -40 }, { scrollLeft: 100 }).element.scrollLeft, 60);
});
test('line and page wheel deltas are converted and clamped', () => {
  assert.equal(step({ deltaY: 3, deltaMode: 1 }).element.scrollLeft, 84);
  assert.equal(step({ deltaY: 1, deltaMode: 2 }).element.scrollLeft, 300);
  assert.equal(step({ deltaY: 1000 }).element.scrollLeft, 600);
});
test('overflowing terms keep wheel input at both horizontal edges', () => {
  const left = step({ deltaY: -50 });
  assert.equal(left.element.scrollLeft, 0);
  assert(left.prevented);
  const right = step({ deltaY: 50 }, { scrollLeft: 600 });
  assert.equal(right.element.scrollLeft, 600);
  assert(right.prevented);
});
test('zoom and rows without overflow keep normal browser behavior', () => {
  assert.equal(step({ ctrlKey: true }).prevented, false);
  assert.equal(step({}, { scrollWidth: 300 }).prevented, false);
});
