import type { BBox, El, Point, Shape, Stroke } from './types';
import { shapeBBox, shapeSegments } from './shapes';

export function distPointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function segsIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
) {
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function distSegSeg(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
) {
  if (segsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    distPointSeg(ax, ay, cx, cy, dx, dy),
    distPointSeg(bx, by, cx, cy, dx, dy),
    distPointSeg(cx, cy, ax, ay, bx, by),
    distPointSeg(dx, dy, ax, ay, bx, by),
  );
}

const bboxCache = new WeakMap<Stroke, BBox>();

export function strokeBBox(s: Stroke): BBox {
  let b = bboxCache.get(s);
  if (b) return b;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of s.points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const r = s.width;
  b = { minX: minX - r, minY: minY - r, maxX: maxX + r, maxY: maxY + r };
  bboxCache.set(s, b);
  return b;
}

export function bboxOverlap(a: BBox, b: BBox) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function strokeGeometry(s: Stroke): Point[] {
  return s.straight && s.points.length > 1 ? [s.points[0], s.points[s.points.length - 1]] : s.points;
}

/** Czy odcinek gumki a→b o promieniu r dotyka kreski. */
export function hitStroke(s: Stroke, ax: number, ay: number, bx: number, by: number, r: number) {
  const R = r + s.width / 2;
  const box = strokeBBox(s);
  if (Math.max(ax, bx) < box.minX - r || Math.min(ax, bx) > box.maxX + r) return false;
  if (Math.max(ay, by) < box.minY - r || Math.min(ay, by) > box.maxY + r) return false;
  const pts = strokeGeometry(s);
  if (pts.length === 1) return distPointSeg(pts[0][0], pts[0][1], ax, ay, bx, by) <= R;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    if (distSegSeg(ax, ay, bx, by, p[0], p[1], q[0], q[1]) <= R) return true;
  }
  return false;
}

/** Przyciąga kierunek a→b do wielokrotności 45°, jeśli jest blisko. */
export function snapAngle(a: Point, b: Point): Point {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const snapped = Math.round(ang / step) * step;
  if (Math.abs(ang - snapped) < (5 * Math.PI) / 180) {
    return [a[0] + Math.cos(snapped) * len, a[1] + Math.sin(snapped) * len, b[2]];
  }
  return b;
}

export function elBBox(e: El): BBox {
  if (e.type === 'shape') return shapeBBox(e);
  if (e.type !== 'stroke') return { minX: e.x, minY: e.y, maxX: e.x + e.w, maxY: e.y + e.h };
  return strokeBBox(e);
}

export const insideRect = (x: number, y: number, r: BBox) => x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;

/** Czy odcinek a→b o promieniu r dotyka figury. */
export function hitShape(s: Shape, ax: number, ay: number, bx: number, by: number, r: number) {
  const box = shapeBBox(s);
  if (Math.max(ax, bx) < box.minX - r || Math.min(ax, bx) > box.maxX + r) return false;
  if (Math.max(ay, by) < box.minY - r || Math.min(ay, by) > box.maxY + r) return false;
  const R = r + s.width / 2;
  return shapeSegments(s).some(([p, q]) => distSegSeg(ax, ay, bx, by, p[0], p[1], q[0], q[1]) <= R);
}

export function pointInPolygon(x: number, y: number, poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Element jest w lassie, gdy co najmniej połowa jego punktów leży w środku. */
export function lassoContains(e: El, poly: [number, number][]) {
  let pts: [number, number][];
  if (e.type === 'stroke') {
    const step = Math.max(1, Math.floor(e.points.length / 40));
    pts = e.points.filter((_, i) => i % step === 0).map(([x, y]) => [x, y]);
  } else if (e.type === 'shape') {
    pts = shapeSegments(e).flatMap(([p, q]) => [p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as [number, number]]);
  } else {
    pts = [[e.x, e.y], [e.x + e.w, e.y], [e.x, e.y + e.h], [e.x + e.w, e.y + e.h], [e.x + e.w / 2, e.y + e.h / 2]];
  }
  if (!pts.length) return false;
  const inside = pts.filter(([x, y]) => pointInPolygon(x, y, poly)).length;
  return inside / pts.length >= 0.5;
}
