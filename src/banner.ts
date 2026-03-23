/** Dot-matrix startup banner for the Pons kernel. */

const DOT = '● ';
const SPC = '  ';

// 5-row glyphs — each cell is either DOT or SPC
const G: Record<string, number[][]> = {
  P: [
    [1,1,1,0],
    [1,0,0,1],
    [1,1,1,0],
    [1,0,0,0],
    [1,0,0,0],
  ],
  O: [
    [0,1,1,0],
    [1,0,0,1],
    [1,0,0,1],
    [1,0,0,1],
    [0,1,1,0],
  ],
  N: [
    [1,0,0,1],
    [1,1,0,1],
    [1,0,1,1],
    [1,0,0,1],
    [1,0,0,1],
  ],
  S: [
    [0,1,1,1],
    [1,0,0,0],
    [0,1,1,0],
    [0,0,0,1],
    [1,1,1,0],
  ],
};

export function renderBanner(text: string): string[] {
  const rows = 5;
  const lines = Array.from({ length: rows }, () => '');
  for (const ch of text.toUpperCase()) {
    const glyph = G[ch];
    if (!glyph) {
      for (let r = 0; r < rows; r++) lines[r] += '    ';
      continue;
    }
    for (let r = 0; r < rows; r++) {
      lines[r] += glyph[r].map(v => v ? DOT : SPC).join('') + '  ';
    }
  }
  return lines;
}
