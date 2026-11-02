import { jsPDF } from 'jspdf';
import { bboxOverlap, elBBox } from '../engine/geometry';
import { GRID, isImage, isInk, strokeOutline, traceOutline } from '../engine/render';
import { shapeGeometry } from '../engine/shapes';
import { A4, type El, type Shape } from '../engine/types';
import type { jsPDF as JsPDF } from 'jspdf';

/** Prostokąt świata, który staje się jedną stroną PDF. */
export interface PageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Brak ramek: dzieli treść na strony w proporcjach A4 (jedna kolumna, od góry), pomija puste.
 * Szersza treść = większa strona, czyli w PDF wszystko proporcjonalnie mniejsze, ale nic nie jest ucięte z boku.
 */
export function autoPages(els: El[]): PageRect[] {
  const content = els.filter((e) => e.type !== 'frame');
  if (!content.length) return [];
  const boxes = content.map(elBBox);
  const pad = 2 * GRID;
  const minX = Math.min(...boxes.map((b) => b.minX)) - pad;
  const minY = Math.min(...boxes.map((b) => b.minY)) - pad;
  const maxX = Math.max(...boxes.map((b) => b.maxX)) + pad;
  const maxY = Math.max(...boxes.map((b) => b.maxY)) + pad;
  const w = Math.max(A4.portrait[0], maxX - minX);
  const h = (w * A4.portrait[1]) / A4.portrait[0];
  const pages: PageRect[] = [];
  for (let y = minY; y < maxY; y += h) {
    const r = { minX, minY: y, maxX: minX + w, maxY: y + h };
    if (boxes.some((b) => bboxOverlap(b, r))) pages.push({ x: minX, y, w, h });
  }
  return pages;
}

const orientation = (p: PageRect) => (p.w > p.h ? 'landscape' : 'portrait');

/** Wektorowy PDF: kreski to te same krzywe co na ekranie, więc wydruk jest ostry. */
export function buildPdf(els: El[], pages: PageRect[], opts: { grid: boolean; images: Map<string, string> }) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: orientation(pages[0]) });
  const ink = els.filter(isInk);

  pages.forEach((page, i) => {
    if (i > 0) doc.addPage('a4', orientation(page));
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const k = pw / page.w;
    const X = (x: number) => (x - page.x) * k;
    const Y = (y: number) => (y - page.y) * k;

    if (opts.grid) {
      doc.setDrawColor('#d5dfeb');
      doc.setLineWidth(0.4);
      for (let x = Math.ceil(page.x / GRID) * GRID; x <= page.x + page.w; x += GRID) doc.line(X(x), 0, X(x), ph);
      for (let y = Math.ceil(page.y / GRID) * GRID; y <= page.y + page.h; y += GRID) doc.line(0, Y(y), pw, Y(y));
    }

    const box = { minX: page.x, minY: page.y, maxX: page.x + page.w, maxY: page.y + page.h };
    for (const im of els.filter(isImage)) {
      const url = opts.images.get(im.imageId);
      if (!url || !bboxOverlap(elBBox(im), box)) continue;
      doc.addImage(url, url.startsWith('data:image/png') ? 'PNG' : 'JPEG', X(im.x), Y(im.y), im.w * k, im.h * k, im.imageId);
    }
    for (const s of ink) {
      if (!bboxOverlap(elBBox(s), box)) continue;
      if (s.type === 'shape') {
        drawShapePdf(doc, s, X, Y, k);
        continue;
      }
      if (s.straight) {
        const a = s.points[0];
        const b = s.points[s.points.length - 1];
        doc.setDrawColor(s.color);
        doc.setLineWidth(s.width * k);
        doc.setLineCap('round');
        doc.line(X(a[0]), Y(a[1]), X(b[0]), Y(b[1]));
        continue;
      }
      // krzywe kwadratowe → sześcienne (PDF zna tylko sześcienne)
      let cx = 0, cy = 0;
      const ok = traceOutline(
        strokeOutline(s),
        (x, y) => {
          cx = X(x);
          cy = Y(y);
          doc.moveTo(cx, cy);
        },
        (qx, qy, x, y) => {
          const QX = X(qx), QY = Y(qy), EX = X(x), EY = Y(y);
          doc.curveTo(cx + (2 / 3) * (QX - cx), cy + (2 / 3) * (QY - cy), EX + (2 / 3) * (QX - EX), EY + (2 / 3) * (QY - EY), EX, EY);
          cx = EX;
          cy = EY;
        },
      );
      if (!ok) continue;
      doc.setFillColor(s.color);
      doc.close();
      doc.fill();
    }
  });
  return doc;
}

/** Figura: łamane, groty strzałek i podpisy osi – z tej samej geometrii co na ekranie. */
function drawShapePdf(doc: JsPDF, s: Shape, X: (x: number) => number, Y: (y: number) => number, k: number) {
  const g = shapeGeometry(s);
  doc.setDrawColor(s.color);
  doc.setFillColor(s.color);
  doc.setLineWidth(s.width * k);
  doc.setLineCap('round');
  doc.setLineJoin('round');
  for (const p of g.paths) {
    p.pts.forEach(([x, y], i) => (i ? doc.lineTo(X(x), Y(y)) : doc.moveTo(X(x), Y(y))));
    if (p.closed) doc.close();
    doc.stroke();
  }
  for (const f of g.fills) {
    f.forEach(([x, y], i) => (i ? doc.lineTo(X(x), Y(y)) : doc.moveTo(X(x), Y(y))));
    doc.close();
    doc.fill();
  }
  if (g.texts.length) {
    doc.setTextColor(s.color);
    doc.setFont('helvetica', 'normal');
    for (const t of g.texts) {
      doc.setFontSize(t.size * k);
      doc.text(t.text, X(t.x), Y(t.y), { align: t.align, baseline: t.baseline });
    }
  }
}

export const pdfFileName = (title: string) => (title.replace(/[\\/:*?"<>|]+/g, '').trim() || 'notes') + '.pdf';
