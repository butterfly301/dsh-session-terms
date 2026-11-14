import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHex,
  hexToRgb,
  rgbToHex,
  rgbToHsv,
  hsvToRgb,
} from '../src/client/color-values.mjs';

test('picker Hex accepts six RGB digits and rejects partial, alpha and CSS values', () => {
  assert.equal(normalizeHex('#Ab12Ef'), '#ab12ef');
  assert.equal(normalizeHex('Ab12Ef'), '#ab12ef');
  for (const value of ['', '#', '#abc', '#abcdef00', '#123456\n', 'red', 'rgb(1,2,3)', null]) {
    assert.equal(normalizeHex(value), null);
    assert.equal(hexToRgb(value), null);
  }
  assert.deepEqual(hexToRgb('#2868b4'), { r: 40, g: 104, b: 180 });
  assert.equal(rgbToHex({ r: 40, g: 104, b: 180 }), '#2868b4');
});

test('HSV conversions match primary colors, gray, white and black without alpha', () => {
  for (const [hex, hsv] of [
    ['#ff0000', { h: 0, s: 100, v: 100 }],
    ['#ffff00', { h: 60, s: 100, v: 100 }],
    ['#00ff00', { h: 120, s: 100, v: 100 }],
    ['#00ffff', { h: 180, s: 100, v: 100 }],
    ['#0000ff', { h: 240, s: 100, v: 100 }],
    ['#ff00ff', { h: 300, s: 100, v: 100 }],
    ['#ffffff', { h: 0, s: 0, v: 100 }],
    ['#000000', { h: 0, s: 0, v: 0 }],
  ]) {
    assert.deepEqual(rgbToHsv(hexToRgb(hex)), hsv);
    assert.equal(rgbToHex(hsvToRgb(hsv)), hex);
  }
  assert.equal(rgbToHex(hsvToRgb({ h: 360, s: 100, v: 100 })), '#ff0000');
  assert.deepEqual(rgbToHsv({ r: 128, g: 128, b: 128 }), { h: 0, s: 0, v: (128 / 255) * 100 });
});

test('RGB HSV round trips retain channel precision and channel edits are bounded', () => {
  for (const r of [0, 1, 64, 127, 128, 254, 255])
    for (const g of [0, 1, 64, 127, 128, 254, 255])
      for (const b of [0, 1, 64, 127, 128, 254, 255]) {
        const rgb = { r, g, b };
        assert.deepEqual(hsvToRgb(rgbToHsv(rgb)), rgb);
      }
  assert.equal(rgbToHex({ r: -1, g: 500, b: 127.6 }), '#00ff80');
  assert.equal(rgbToHex(hsvToRgb({ h: 120, s: 200, v: 200 })), '#00ff00');
});
