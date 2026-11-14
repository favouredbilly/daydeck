// Canvas-drawn visuals for cards, panels and buttons. Text in VR needs to be
// big and high-contrast, so everything is drawn at 2x and shown on planes.

import {
  CanvasTexture,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from '@iwsdk/core';

export const C = {
  ink: '#1d1b2e',
  card: '#fffdf8',
  cardEdge: '#e6dfd2',
  accent: '#5b4bdb',
  accentSoft: '#ece9ff',
  gold: '#f2b705',
  green: '#1f9d63',
  muted: '#77738a',
  panel: 'rgba(255,255,255,0.97)',
  part: { morning: '#f59e0b', afternoon: '#3b82f6', evening: '#8b5cf6' } as Record<string, string>,
};

const FONT = 'Inter, "Segoe UI", Roboto, system-ui, sans-serif';

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export function wrapText(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (g.measureText(t).width <= maxW) cur = t;
    else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (g.measureText(`${last}…`).width > maxW && last.length) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last}…`;
    return kept;
  }
  return lines;
}

/** A plane mesh backed by its own canvas; call redraw(fn) to update it. */
export class CanvasPlane {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  tex: CanvasTexture;
  mesh: Mesh;
  constructor(public pxW: number, public pxH: number, w: number, h: number, opts: { transparent?: boolean; opacity?: number } = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = pxW;
    this.canvas.height = pxH;
    this.g = this.canvas.getContext('2d')!;
    this.tex = new CanvasTexture(this.canvas);
    this.tex.colorSpace = SRGBColorSpace;
    this.tex.anisotropy = 4;
    const mat = new MeshBasicMaterial({
      map: this.tex,
      transparent: true,
      opacity: opts.opacity ?? 1,
      side: DoubleSide,
      toneMapped: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(w, h), mat);
  }
  redraw(fn: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
    this.g.clearRect(0, 0, this.pxW, this.pxH);
    fn(this.g, this.pxW, this.pxH);
    this.tex.needsUpdate = true;
  }
}

export function drawCard(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  title: string,
  minutes: number,
  opts: { ghost?: boolean; selected?: boolean; partColor?: string } = {},
) {
  const pad = 10;
  roundRect(g, pad, pad, w - pad * 2, h - pad * 2, 26);
  if (opts.ghost) {
    g.fillStyle = 'rgba(236,233,255,0.78)';
    g.fill();
    g.setLineDash([18, 12]);
    g.lineWidth = 6;
    g.strokeStyle = C.accent;
    g.stroke();
    g.setLineDash([]);
  } else {
    g.fillStyle = C.card;
    g.fill();
    g.lineWidth = opts.selected ? 8 : 4;
    g.strokeStyle = opts.selected ? C.accent : C.cardEdge;
    g.stroke();
  }
  // color bar
  if (opts.partColor && !opts.ghost) {
    g.save();
    roundRect(g, pad, pad, w - pad * 2, h - pad * 2, 26);
    g.clip();
    g.fillStyle = opts.partColor;
    g.fillRect(pad, pad, 16, h - pad * 2);
    g.restore();
  }
  g.fillStyle = C.ink;
  g.font = `700 54px ${FONT}`;
  g.textBaseline = 'middle';
  let lines = wrapText(g, title, w - 230, 1);
  if (g.measureText(title).width > w - 230) {
    g.font = `700 44px ${FONT}`;
    lines = wrapText(g, title, w - 230, 2);
  }
  const lh = 50;
  const y0 = h / 2 - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => g.fillText(l, 44, y0 + i * lh));
  // minutes chip / AI badge
  const chip = opts.ghost ? '✦ AI' : `${minutes}m`;
  g.font = `700 38px ${FONT}`;
  const cw = g.measureText(chip).width + 36;
  roundRect(g, w - pad - 24 - cw, h / 2 - 28, cw, 56, 28);
  g.fillStyle = opts.ghost ? C.accent : '#f1eee7';
  g.fill();
  g.fillStyle = opts.ghost ? '#fff' : C.muted;
  g.fillText(chip, w - pad - 24 - cw + 18, h / 2 + 1);
}

export function drawButton(g: CanvasRenderingContext2D, w: number, h: number, label: string, style: 'primary' | 'secondary' | 'chip', hover = false) {
  roundRect(g, 6, 6, w - 12, h - 12, (h - 12) / 2);
  if (style === 'primary') g.fillStyle = hover ? '#4a3bc4' : C.accent;
  else if (style === 'chip') g.fillStyle = hover ? '#dcd6ff' : C.accentSoft;
  else g.fillStyle = hover ? '#e9e6f0' : '#f4f2f8';
  g.fill();
  if (style !== 'primary') {
    g.lineWidth = 4;
    g.strokeStyle = style === 'chip' ? '#c9c1ff' : '#dad6e4';
    g.stroke();
  }
  g.fillStyle = style === 'primary' ? '#fff' : C.ink;
  g.font = `700 ${Math.round(h * 0.36)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, w / 2, h / 2 + 2);
  g.textAlign = 'left';
}

export { FONT };
