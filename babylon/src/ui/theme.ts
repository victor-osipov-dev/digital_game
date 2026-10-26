export const UI = {
  bg: '#101014',
  panel: '#1b1c22',
  panel2: '#23242c',
  accent: '#4f8cff',
  accentDim: '#2c4c8f',
  ok: '#63c26a',
  bad: '#e05b5b',
  text: '#f2f2f5',
  textDim: '#9a9ba8',
  gold: '#fdd835',
  felt: '#1d4a30',
  feltDark: '#14321f',
};

export const FONT_MAIN = 'Segoe UI, Arial, sans-serif';
export const FONT_MONO = 'Consolas, monospace';

export function hexToColor3(hex: string): { r: number; g: number; b: number } {
  const v = hex.replace('#', '');
  const n = parseInt(v, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export function rgb(hex: string): [number, number, number] {
  const { r, g, b } = hexToColor3(hex);
  return [r, g, b];
}
