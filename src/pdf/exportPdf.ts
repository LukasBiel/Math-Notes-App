import { jsPDF } from 'jspdf';
import { bboxOverlap, elBBox } from '../engine/geometry';
import { GRID, isImage, isStroke, strokeOutline, traceOutline } from '../engine/render';
import { A4, type El } from '../engine/types';

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
  const strokes = els.filter(isStroke);

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
    for (const s of strokes) {
      if (!bboxOverlap(elBBox(s), box)) continue;
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

export const pdfFileName = (title: string) => (title.replace(/[\\/:*?"<>|]+/g, '').trim() || 'notes') + '.pdf';
