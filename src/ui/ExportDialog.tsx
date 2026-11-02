import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { autoPages, buildPdf, pdfFileName, type PageRect } from '../pdf/exportPdf';
import { drawInk, frameLabel, GRID, isFrame, isImage, isInk, sortFrames } from '../engine/render';
import { bboxOverlap, elBBox } from '../engine/geometry';
import type { El } from '../engine/types';
import { useUI } from './store';

export function ExportDialog() {
  const open = useUI((s) => s.exportOpen);
  return open ? <ExportForm /> : null;
}

const close = () => useUI.setState({ exportOpen: false });

function ExportForm() {
  const api = useUI((s) => s.api);
  const grid = useUI((s) => s.pdfGrid);
  const noteId = useUI((s) => s.currentNoteId);
  const note = useLiveQuery(() => (noteId ? db.notes.get(noteId) : undefined), [noteId]);
  const [els] = useState<El[]>(() => api?.getElements() ?? []);
  const frames = sortFrames(els.filter(isFrame));
  const [selected, setSelected] = useState(() => new Set(frames.map((f) => f.id)));
  const [error, setError] = useState('');
  // obrazki: data URL do PDF i gotowe <img> do miniatur
  const [imgs, setImgs] = useState<{ urls: Map<string, string>; els: Map<string, HTMLImageElement> } | null>(null);
  useEffect(() => {
    const ids = [...new Set(els.filter(isImage).map((e) => e.imageId))];
    void db.images.bulkGet(ids).then(async (recs) => {
      const urls = new Map<string, string>();
      const loaded = new Map<string, HTMLImageElement>();
      await Promise.all(
        recs.map(async (r) => {
          if (!r) return;
          urls.set(r.id, r.dataUrl);
          const img = new Image();
          img.src = r.dataUrl;
          await img.decode().catch(() => {});
          loaded.set(r.id, img);
        }),
      );
      setImgs({ urls, els: loaded });
    });
  }, [els]);
  const auto = frames.length ? [] : autoPages(els);
  const pages: PageRect[] = frames.length ? frames.filter((f) => selected.has(f.id)) : auto;
  const fileName = pdfFileName(note?.title ?? 'notes');
  const btn = useRef<HTMLButtonElement>(null);
  const runRef = useRef(() => {});

  // Enter/Escape działają niezależnie od tego, co ma fokus
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') {
        e.preventDefault();
        runRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const run = () => {
    if (!pages.length || !imgs) return;
    try {
      buildPdf(els, pages, { grid, images: imgs.urls }).save(fileName);
      close();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  runRef.current = run;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  return (
    <div className="backdrop" onPointerDown={close}>
      <div
        className="dialog export"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2>Export PDF</h2>

        {frames.length > 0 ? (
          <div className="pages">
            {frames.map((f, i) => (
              <label key={f.id} className={'page-thumb' + (selected.has(f.id) ? ' on' : '')}>
                <Thumb els={els} page={f} grid={grid} imgs={imgs?.els} />
                <span>
                  <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} />
                  {frameLabel(f, i)}
                </span>
              </label>
            ))}
          </div>
        ) : auto.length ? (
          <>
            <p className="muted">
              No pages marked – the whole note is split into {auto.length} A4 page{auto.length > 1 ? 's' : ''}. To choose exactly what goes
              on each page, use the Page tool (<kbd>F</kbd>) or <b>+ Page</b>.
            </p>
            <div className="pages">
              {auto.map((p, i) => (
                <div key={i} className="page-thumb on">
                  <Thumb els={els} page={p} grid={grid} imgs={imgs?.els} />
                  <span>Page {i + 1}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="muted">This note is empty – nothing to export yet.</p>
        )}

        <label className="check">
          <input type="checkbox" checked={grid} onChange={(e) => useUI.setState({ pdfGrid: e.target.checked })} />
          Grid background
        </label>
        {error && <p className="error">{error}</p>}

        <div className="dialog-footer">
          <span className="preview">{fileName}</span>
          <button ref={btn} className="primary" disabled={!pages.length || !imgs} onClick={run}>
            Export {pages.length > 0 && `${pages.length} page${pages.length > 1 ? 's' : ''}`} <kbd>Enter</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

/** Miniatura strony – rysowana tak samo jak tablica. */
function Thumb({ els, page, grid, imgs }: { els: El[]; page: PageRect; grid: boolean; imgs?: Map<string, HTMLImageElement> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const W = page.w > page.h ? 150 : 106;
  const H = Math.round((W * page.h) / page.w);

  useEffect(() => {
    const c = ref.current?.getContext('2d');
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const k = (W / page.w) * dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#fff';
    c.fillRect(0, 0, W * dpr, H * dpr);
    c.setTransform(k, 0, 0, k, -page.x * k, -page.y * k);
    if (grid) {
      c.strokeStyle = '#e3e9f2';
      c.lineWidth = 1 / k;
      c.beginPath();
      for (let x = Math.ceil(page.x / GRID) * GRID; x <= page.x + page.w; x += GRID) {
        c.moveTo(x, page.y);
        c.lineTo(x, page.y + page.h);
      }
      for (let y = Math.ceil(page.y / GRID) * GRID; y <= page.y + page.h; y += GRID) {
        c.moveTo(page.x, y);
        c.lineTo(page.x + page.w, y);
      }
      c.stroke();
    }
    const box = { minX: page.x, minY: page.y, maxX: page.x + page.w, maxY: page.y + page.h };
    for (const im of els.filter(isImage)) {
      const img = imgs?.get(im.imageId);
      if (img && bboxOverlap(elBBox(im), box)) c.drawImage(img, im.x, im.y, im.w, im.h);
    }
    for (const s of els.filter(isInk)) if (bboxOverlap(elBBox(s), box)) drawInk(c, s);
  }, [els, page, grid, W, H, imgs]);

  const dpr = window.devicePixelRatio || 1;
  return <canvas ref={ref} width={W * dpr} height={H * dpr} style={{ width: W, height: H }} />;
}
