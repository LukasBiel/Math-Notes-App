import type { BBox, Shape, ShapeKind } from './types';

type P = [number, number];

export interface ShapeText {
  x: number;
  y: number;
  text: string;
  size: number;
  align: 'left' | 'center' | 'right';
  baseline: 'top' | 'middle' | 'bottom';
}

/** Figura rozpisana na łamane, wypełnienia (groty strzałek) i podpisy – wspólne dla ekranu, PDF i gumki. */
export interface ShapeGeo {
  paths: { pts: P[]; closed: boolean }[];
  fills: P[][];
  texts: ShapeText[];
}

export const SHAPE_LABELS: Record<ShapeKind, string> = {
  line: 'Line',
  arrow: 'Arrow',
  rect: 'Rectangle',
  ellipse: 'Circle / ellipse',
  triangle: 'Triangle',
  angle: 'Angle',
  axes: 'Coordinate axes',
  numberline: 'Number line',
  arc: 'Compass arc',
};

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function box(a: P, b: P) {
  return { minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]) };
}

/** Grot strzałki: zwraca podstawę (tam kończy się linia) i trójkąt grotu. */
function arrowHead(from: P, to: P, width: number): { base: P; head: P[] } {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
  const L = Math.min(Math.max(10, width * 4), len * 0.5);
  const ux = (to[0] - from[0]) / len;
  const uy = (to[1] - from[1]) / len;
  const base: P = [to[0] - ux * L, to[1] - uy * L];
  const half = L * 0.42;
  return { base, head: [to, [base[0] - uy * half, base[1] + ux * half], [base[0] + uy * half, base[1] - ux * half]] };
}

/** Kąt (stopnie, 0–180) między ramionami. */
export function angleDegrees(v: P, a: P, b: P) {
  const d = Math.atan2(b[1] - v[1], b[0] - v[0]) - Math.atan2(a[1] - v[1], a[0] - v[0]);
  const n = Math.atan2(Math.sin(d), Math.cos(d));
  return Math.abs((n * 180) / Math.PI);
}

const fmt = (k: number) => String(k); // zwykły minus – czcionki PDF nie znają znaku „−”

function axisTicks(geo: ShapeGeo, s: Shape, o: P, b: ReturnType<typeof box>, withY: boolean) {
  const u = s.unit ?? 40;
  const t = clamp(u * 0.15, 3, 7);
  const fs = clamp(u * 0.32, 9, 14);
  const step = u >= 28 ? 1 : u >= 14 ? 2 : 5;
  const arrowRoom = Math.max(10, s.width * 4) * 1.3;

  const xs = arrowHead([b.minX, o[1]], [b.maxX, o[1]], s.width);
  geo.paths.push({ pts: [[b.minX, o[1]], xs.base], closed: false });
  geo.fills.push(xs.head);
  for (let k = Math.ceil((b.minX - o[0]) / u); o[0] + k * u <= b.maxX - arrowRoom; k++) {
    if (k === 0) continue;
    const x = o[0] + k * u;
    geo.paths.push({ pts: [[x, o[1] - t], [x, o[1] + t]], closed: false });
    if (k % step === 0) geo.texts.push({ x, y: o[1] + t + 2, text: fmt(k), size: fs, align: 'center', baseline: 'top' });
  }
  if (!withY) {
    // oś liczbowa: wyraźniejsze zero, bez nazwy osi
    geo.paths.push({ pts: [[o[0], o[1] - t * 1.6], [o[0], o[1] + t * 1.6]], closed: false });
    geo.texts.push({ x: o[0], y: o[1] + t * 1.6 + 2, text: '0', size: fs, align: 'center', baseline: 'top' });
    return;
  }
  geo.texts.push({ x: b.maxX, y: o[1] + t + 2, text: 'x', size: fs * 1.1, align: 'right', baseline: 'top' });

  const ys = arrowHead([o[0], b.maxY], [o[0], b.minY], s.width);
  geo.paths.push({ pts: [[o[0], b.maxY], ys.base], closed: false });
  geo.fills.push(ys.head);
  for (let k = Math.ceil((o[1] - b.maxY) / u); o[1] - k * u >= b.minY + arrowRoom; k++) {
    if (k === 0) continue;
    const y = o[1] - k * u;
    geo.paths.push({ pts: [[o[0] - t, y], [o[0] + t, y]], closed: false });
    if (k % step === 0) geo.texts.push({ x: o[0] - t - 3, y, text: fmt(k), size: fs, align: 'right', baseline: 'middle' });
  }
  geo.texts.push({ x: o[0] - 3, y: o[1] + 3, text: '0', size: fs, align: 'right', baseline: 'top' });
  geo.texts.push({ x: o[0] + t + 4, y: b.minY, text: 'y', size: fs * 1.1, align: 'left', baseline: 'top' });
}

function build(s: Shape): ShapeGeo {
  const geo: ShapeGeo = { paths: [], fills: [], texts: [] };
  const [p1, p2, p3] = s.pts;
  const b = box(p1, p2 ?? p1); // łuk ma tylko środek

  switch (s.kind) {
    case 'line':
      geo.paths.push({ pts: [p1, p2], closed: false });
      break;
    case 'arrow': {
      const { base, head } = arrowHead(p1, p2, s.width);
      geo.paths.push({ pts: [p1, base], closed: false });
      geo.fills.push(head);
      break;
    }
    case 'rect':
      geo.paths.push({ pts: [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]], closed: true });
      break;
    case 'ellipse': {
      const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
      const rx = (b.maxX - b.minX) / 2, ry = (b.maxY - b.minY) / 2;
      const n = 72;
      const pts: P[] = [];
      for (let i = 0; i < n; i++) pts.push([cx + rx * Math.cos((i / n) * Math.PI * 2), cy + ry * Math.sin((i / n) * Math.PI * 2)]);
      geo.paths.push({ pts, closed: true });
      break;
    }
    case 'triangle':
      if (s.right) {
        geo.paths.push({ pts: [[b.minX, b.minY], [b.minX, b.maxY], [b.maxX, b.maxY]], closed: true });
        const m = Math.min(14, (b.maxX - b.minX) / 4, (b.maxY - b.minY) / 4);
        geo.paths.push({ pts: [[b.minX, b.maxY - m], [b.minX + m, b.maxY - m], [b.minX + m, b.maxY]], closed: false });
      } else {
        geo.paths.push({ pts: [[(b.minX + b.maxX) / 2, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]], closed: true });
      }
      break;
    case 'angle': {
      const v = p1, a = p2, c = p3 ?? p2;
      geo.paths.push({ pts: [a, v, c], closed: false });
      const a1 = Math.atan2(a[1] - v[1], a[0] - v[0]);
      const d0 = Math.atan2(c[1] - v[1], c[0] - v[0]) - a1;
      const delta = Math.atan2(Math.sin(d0), Math.cos(d0));
      const r = clamp(Math.min(Math.hypot(a[0] - v[0], a[1] - v[1]), Math.hypot(c[0] - v[0], c[1] - v[1])) * 0.3, 10, 40);
      if (Math.abs(Math.abs(delta) - Math.PI / 2) < 0.012) {
        // kąt prosty – kwadracik zamiast łuku
        const q = r * 0.7;
        const u1: P = [Math.cos(a1), Math.sin(a1)];
        const u2: P = [Math.cos(a1 + delta), Math.sin(a1 + delta)];
        geo.paths.push({
          pts: [[v[0] + u1[0] * q, v[1] + u1[1] * q], [v[0] + (u1[0] + u2[0]) * q, v[1] + (u1[1] + u2[1]) * q], [v[0] + u2[0] * q, v[1] + u2[1] * q]],
          closed: false,
        });
      } else if (Math.abs(delta) > 0.01) {
        const n = Math.max(6, Math.ceil(Math.abs(delta) * 20));
        const pts: P[] = [];
        for (let i = 0; i <= n; i++) {
          const t = a1 + (delta * i) / n;
          pts.push([v[0] + Math.cos(t) * r, v[1] + Math.sin(t) * r]);
        }
        geo.paths.push({ pts, closed: false });
      }
      break;
    }
    case 'axes': {
      const o: P = [clamp(p3[0], b.minX, b.maxX), clamp(p3[1], b.minY, b.maxY)];
      axisTicks(geo, s, o, b, true);
      break;
    }
    case 'arc': {
      if (!s.arc) break;
      const { r, a0, sweep } = s.arc;
      const n = Math.max(8, Math.ceil(Math.abs(sweep) * 24));
      const pts: P[] = [];
      for (let i = 0; i <= n; i++) {
        const t = a0 + (sweep * i) / n;
        pts.push([p1[0] + Math.cos(t) * r, p1[1] + Math.sin(t) * r]);
      }
      geo.paths.push({ pts, closed: false });
      break;
    }
    case 'numberline': {
      const o: P = [clamp(p3[0], b.minX, b.maxX), p1[1]];
      axisTicks(geo, s, o, { ...b, minY: p1[1], maxY: p1[1] }, false);
      break;
    }
  }
  return geo;
}

const geoCache = new WeakMap<Shape, ShapeGeo>();
export function shapeGeometry(s: Shape): ShapeGeo {
  let g = geoCache.get(s);
  if (!g) {
    g = build(s);
    geoCache.set(s, g);
  }
  return g;
}

const bboxCache = new WeakMap<Shape, BBox>();
export function shapeBBox(s: Shape): BBox {
  let b = bboxCache.get(s);
  if (b) return b;
  const g = shapeGeometry(s);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const p of g.paths) for (const [x, y] of p.pts) add(x, y);
  for (const f of g.fills) for (const [x, y] of f) add(x, y);
  for (const t of g.texts) {
    const w = t.text.length * t.size * 0.6;
    const x0 = t.align === 'left' ? t.x : t.align === 'right' ? t.x - w : t.x - w / 2;
    const y0 = t.baseline === 'top' ? t.y : t.baseline === 'bottom' ? t.y - t.size : t.y - t.size / 2;
    add(x0, y0);
    add(x0 + w, y0 + t.size);
  }
  const r = s.width;
  b = { minX: minX - r, minY: minY - r, maxX: maxX + r, maxY: maxY + r };
  bboxCache.set(s, b);
  return b;
}

/** Wszystkie odcinki figury (do gumki, klikania i lassa). */
export function shapeSegments(s: Shape): [P, P][] {
  const g = shapeGeometry(s);
  const segs: [P, P][] = [];
  for (const p of g.paths) {
    for (let i = 1; i < p.pts.length; i++) segs.push([p.pts[i - 1], p.pts[i]]);
    if (p.closed && p.pts.length > 2) segs.push([p.pts[p.pts.length - 1], p.pts[0]]);
  }
  for (const f of g.fills) for (let i = 0; i < f.length; i++) segs.push([f[i], f[(i + 1) % f.length]]);
  return segs;
}
