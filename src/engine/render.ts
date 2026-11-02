import { getStroke } from 'perfect-freehand';
import { A4, type El, type Frame, type ImageEl, type Stroke } from './types';

export const GRID = 20;

export function strokeOutline(s: Stroke, last = true): number[][] {
  return getStroke(s.points, {
    size: s.width,
    thinning: s.pressure ? 0.6 : 0,
    smoothing: 0.5,
    streamline: s.streamline,
    simulatePressure: false,
    last,
  });
}

/**
 * Obrys kreski jako ciąg krzywych kwadratowych (to samo dla ekranu i PDF):
 * start w pts[0], potem dla każdego punktu Q(kontrolny = p[i], koniec = środek p[i]–p[i+1]).
 */
export function traceOutline(
  pts: number[][],
  moveTo: (x: number, y: number) => void,
  quadTo: (cx: number, cy: number, x: number, y: number) => void,
) {
  if (pts.length < 2) return false;
  moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    quadTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  return true;
}

const pathCache = new WeakMap<Stroke, Path2D>();

function strokePath(s: Stroke, live: boolean) {
  let path = live ? undefined : pathCache.get(s);
  if (!path) {
    const p = new Path2D();
    traceOutline(strokeOutline(s, !live), (x, y) => p.moveTo(x, y), (cx, cy, x, y) => p.quadraticCurveTo(cx, cy, x, y));
    p.closePath();
    path = p;
    if (!live) pathCache.set(s, path);
  }
  return path;
}

export function drawStroke(c: CanvasRenderingContext2D, s: Stroke, live = false) {
  if (s.straight) {
    const a = s.points[0];
    const b = s.points[s.points.length - 1];
    c.strokeStyle = s.color;
    c.lineWidth = s.width;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(a[0], a[1]);
    c.lineTo(b[0], b[1]);
    c.stroke();
    return;
  }
  c.fillStyle = s.color;
  c.fill(strokePath(s, live));
}

export const isStroke = (e: El): e is Stroke => e.type === 'stroke';
export const isFrame = (e: El): e is Frame => e.type === 'frame';
export const isImage = (e: El): e is ImageEl => e.type === 'image';

/** Kolejność stron: wiersze od góry (ramki zachodzące na siebie w pionie to jeden wiersz), w wierszu od lewej. */
export function sortFrames(frames: Frame[]): Frame[] {
  const rest = [...frames].sort((a, b) => a.y - b.y);
  const out: Frame[] = [];
  while (rest.length) {
    const top = rest[0];
    const row = rest.filter((f) => f.y < top.y + top.h / 2);
    row.sort((a, b) => a.x - b.x);
    out.push(...row);
    for (const f of row) rest.splice(rest.indexOf(f), 1);
  }
  return out;
}

/** Skala strony względem A4: 2 = strona dwa razy większa, w PDF wszystko o połowę mniejsze. */
export const frameScale = (f: { w: number; h: number }) => f.w / (f.w > f.h ? A4.landscape[0] : A4.portrait[0]);

export function frameLabel(f: Frame, index: number) {
  const k = Math.round(frameScale(f) * 100);
  return `${index + 1}. ${f.name || 'Page ' + (index + 1)}${k === 100 ? '' : ` · ${k}%`}`;
}
