import { isTermColor } from '../color.mjs';

const bound = (value, max) => Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0));
const channel = (value) => Math.round(bound(value, 255));

export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const hex = value.startsWith('#') ? value : `#${value}`;
  return isTermColor(hex) ? hex.toLowerCase() : null;
}

export function hexToRgb(value) {
  const hex = normalizeHex(value);
  if (!hex) return null;
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

export function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map((value) => channel(value).toString(16).padStart(2, '0')).join('');
}

// Hue uses degrees; saturation and value use percentages; RGB uses 0–255.
export function rgbToHsv({ r, g, b }) {
  const red = bound(r, 255) / 255;
  const green = bound(g, 255) / 255;
  const blue = bound(b, 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let h = 0;
  if (delta) {
    if (max === red) h = ((green - blue) / delta) % 6;
    else if (max === green) h = (blue - red) / delta + 2;
    else h = (red - green) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : (delta / max) * 100, v: max * 100 };
}

export function hsvToRgb({ h, s, v }) {
  const hue = (bound(h, 360) % 360) / 60;
  const saturation = bound(s, 100) / 100;
  const value = bound(v, 100) / 100;
  const chroma = value * saturation;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const offset = value - chroma;
  const sectors = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x],
  ];
  const [r, g, b] = sectors[Math.floor(hue)];
  return {
    r: channel((r + offset) * 255),
    g: channel((g + offset) * 255),
    b: channel((b + offset) * 255),
  };
}
