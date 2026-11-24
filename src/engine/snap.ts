import type { El } from './types';
import { shapeGeometry } from './shapes';

type P = [number, number];
interface Seg {
  a: P;
  b: P;
}
/** Okrąg albo łuk (a0 + sweep, kąty w radianach); bez sweep = pełny okrąg. */
interface Circ {
  c: P;
  r: number;
  a0?: number;
  sweep?: number;
}

const EPS = 1e-6;
const TAU = Math.PI * 2;

/** Czy punkt leżący na okręgu należy też do łuku. */
function onArc(k: Circ, p: P) {
  if (k.sweep === undefined) return true;
  const ang = Math.atan2(p[1] - k.c[1], p[0] - k.c[0]);
  const norm = (x: number) => ((x % TAU) + TAU) % TAU;
  const rel = k.sweep >= 0 ? norm(ang - k.a0!) : norm(k.a0! - ang);
  return rel <= Math.abs(k.sweep) + 0.01;
}

function segSeg(s: Seg, t: Seg): P[] {
  const [x1, y1] = s.a, [x2, y2] = s.b, [x3, y3] = t.a, [x4, y4] = t.b;
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < EPS) return [];
  const u = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const v = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
  if (u < -EPS || u > 1 + EPS || v < -EPS || v > 1 + EPS) return [];
  return [[x1 + u * (x2 - x1), y1 + u * (y2 - y1)]];
}

function segCirc(s: Seg, k: Circ): P[] {
  const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
  const fx = s.a[0] - k.c[0], fy = s.a[1] - k.c[1];
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - k.r * k.r;
  const disc = b * b - 4 * a * c;
  if (a < EPS || disc < 0) return [];
  const sq = Math.sqrt(disc);
  const out: P[] = [];
  for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
    if (t < -EPS || t > 1 + EPS) continue;
    const p: P = [s.a[0] + t * dx, s.a[1] + t * dy];
    if (onArc(k, p)) out.push(p);
  }
  return out;
}

function circCirc(k1: Circ, k2: Circ): P[] {
  const dx = k2.c[0] - k1.c[0], dy = k2.c[1] - k1.c[1];
  const d = Math.hypot(dx, dy);
  if (d < EPS || d > k1.r + k2.r + EPS || d < Math.abs(k1.r - k2.r) - EPS) return [];
  const a = (k1.r * k1.r - k2.r * k2.r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, k1.r * k1.r - a * a));
  const mx = k1.c[0] + (a * dx) / d, my = k1.c[1] + (a * dy) / d;
  const pts: P[] = [
    [mx - (h * dy) / d, my + (h * dx) / d],
    [mx + (h * dy) / d, my - (h * dx) / d],
  ];
  return pts.filter((p) => onArc(k1, p) && onArc(k2, p));
}

/**
 * Punkty, do których przyciągają cyrkiel i figury: końce odcinków, wierzchołki,
 * środki okręgów/łuków, końce łuków i wszystkie przecięcia linii i łuków.
 */
export function keyPoints(els: El[]): P[] {
  const segs: Seg[] = [];
  const circs: Circ[] = [];
  const pts: P[] = [];
  const poly = (vs: P[], closed: boolean) => {
    pts.push(...vs);
    for (let i = 1; i < vs.length; i++) segs.push({ a: vs[i - 1], b: vs[i] });
    if (closed && vs.length > 2) segs.push({ a: vs[vs.length - 1], b: vs[0] });
  };

  for (const e of els) {
    if (e.type === 'stroke') {
      // proste z Shiftem też są „liniami konstrukcyjnymi”
      if (e.straight && e.points.length > 1) {
        const a = e.points[0], b = e.points[e.points.length - 1];
        poly([[a[0], a[1]], [b[0], b[1]]], false);
      }
      continue;
    }
    if (e.type !== 'shape') continue;
    const [p1, p2, p3] = e.pts;
    switch (e.kind) {
      case 'line':
      case 'arrow':
        poly([p1, p2], false);
        break;
      case 'rect':
      case 'triangle':
        poly(shapeGeometry(e).paths[0].pts, true);
        break;
      case 'ellipse': {
        const c: P = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
        const rx = Math.abs(p2[0] - p1[0]) / 2, ry = Math.abs(p2[1] - p1[1]) / 2;
        pts.push(c);
        if (Math.abs(rx - ry) < 0.5) circs.push({ c, r: rx });
        break;
      }
      case 'arc':
        if (e.arc) {
          const { r, a0, sweep } = e.arc;
          circs.push({ c: p1, r, a0, sweep });
          pts.push(p1, [p1[0] + r * Math.cos(a0), p1[1] + r * Math.sin(a0)], [p1[0] + r * Math.cos(a0 + sweep), p1[1] + r * Math.sin(a0 + sweep)]);
        }
        break;
      case 'angle':
        poly([p2, p1, p3 ?? p2], false);
        break;
      case 'axes':
      case 'numberline':
        if (p3) pts.push(p3);
        break;
    }
  }

  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) pts.push(...segSeg(segs[i], segs[j]));
    for (const k of circs) pts.push(...segCirc(segs[i], k));
  }
  for (let i = 0; i < circs.length; i++) for (let j = i + 1; j < circs.length; j++) pts.push(...circCirc(circs[i], circs[j]));
  return pts;
}

/** Najbliższy punkt kluczowy w promieniu tol (świat) albo null. */
export function nearestKeyPoint(pts: P[], x: number, y: number, tol: number): P | null {
  let best: P | null = null;
  let bd = tol;
  for (const p of pts) {
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (d <= bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}
