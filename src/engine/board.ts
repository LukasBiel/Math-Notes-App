import type { BBox, Camera, El, Frame, ImageEl, Point, Shape, ShapeKind, Stroke } from './types';
import { A4 } from './types';
import { bboxOverlap, elBBox, hitShape, hitStroke, insideRect, lassoContains, snapAngle } from './geometry';
import { History, type Op } from './history';
import { isTyping, matchShortcut, SHAPE_ACTIONS, type Action } from './shortcuts';
import { drawInk, drawStroke, frameLabel, frameScale, GRID, isFrame, isImage, isInk, sortFrames } from './render';
import { angleDegrees } from './shapes';
import { keyPoints, nearestKeyPoint } from './snap';
import { prepareImage } from './images';
import { startPdfImport, type PdfPageImage } from '../pdf/importPdf';
import { useUI, WIDTHS, type BoardApi, type SelectionUI } from '../ui/store';
import { runAppAction } from '../ui/appActions';

/** Pliki obrazków trzymane poza dokumentem (żeby zapis notatki był lekki). */
export interface ImageStore {
  get(id: string): Promise<string | undefined>;
  put(id: string, dataUrl: string): Promise<void>;
}

export interface BoardInit {
  doc: El[];
  cam?: Camera;
  images: ImageStore;
}

export type SaveFn = (doc: El[], cam: Camera, contentChanged: boolean) => void;

type P = [number, number];

/** przerwa (ms), po której kolejne kreski nie należą już do tej samej „serii” */
const SERIES_GAP = 1000;
/** promień gumki w pikselach ekranu */
const ERASER_PX = 14;
/** tolerancja klikania w kreskę narzędziem zaznaczania (piksele ekranu) */
const PICK_PX = 6;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;
/** odstęp między stronami dodawanymi przyciskiem „+ Page” */
const PAGE_GAP = 80;
/** zakres skali strony względem A4 */
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
/** uchwyt zmiany rozmiaru w rogu (piksele ekranu) */
const HANDLE_PX = 10;
/** jednostka na osiach: 2 kratki = 1 cm, jak w zeszycie */
const AXIS_UNIT = 2 * GRID;
/** schowek wewnętrzny (kopiuj/wklej zaznaczenia, także między notatkami) */
const CLIP_KEY = 'notatnik:clip';
const CLIP_PREFIX = 'math-notes-clip:';
/** zasięg przyciągania do punktów (piksele ekranu) */
const SNAP_PX = 12;

type Mode =
  | { kind: 'draw'; stroke: Stroke; t0: number; pointerId: number }
  | { kind: 'erase'; items: { el: El; index: number }[]; last: [number, number]; t0: number; pointerId: number }
  | { kind: 'pan'; sx: number; sy: number; cx: number; cy: number; pointerId: number }
  | { kind: 'shape'; shape: Shape; start: P; pointerId: number }
  | { kind: 'lasso'; pts: P[]; additive: boolean; pointerId: number }
  | { kind: 'compassSet'; c: P; p: P; pointerId: number }
  | { kind: 'compassArc'; a0: number; last: number; sweep: number; pointerId: number }
  | { kind: 'selMove'; els: El[]; sx: number; sy: number; dx: number; dy: number; moved: boolean; pointerId: number }
  | { kind: 'selScale'; els: El[]; box: BBox; s: number; pointerId: number }
  | { kind: 'frameResize'; frame: Frame; sx: number; w: number; h: number; moved: boolean; pointerId: number }
  | {
      kind: 'frameDrag';
      frame: Frame;
      /** z Shiftem: elementy, których środek leży w ramce – jadą razem z nią */
      contents: El[];
      sx: number;
      sy: number;
      dx: number;
      dy: number;
      moved: boolean;
      pointerId: number;
    };

interface LabelRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const snap = (n: number) => Math.round(n / GRID) * GRID;

function moveEl<T extends El>(e: T, dx: number, dy: number): T {
  if (e.type === 'stroke') return { ...e, points: e.points.map(([x, y, p]): Point => [r2(x + dx), r2(y + dy), p]) };
  if (e.type === 'shape') return { ...e, pts: e.pts.map(([x, y]): P => [r2(x + dx), r2(y + dy)]) };
  return { ...e, x: r2(e.x + dx), y: r2(e.y + dy) };
}

/** Skalowanie względem punktu (ax, ay) – razem z grubością kresek. */
function scaleEl<T extends El>(e: T, ax: number, ay: number, s: number): T {
  const X = (x: number) => r2(ax + (x - ax) * s);
  const Y = (y: number) => r2(ay + (y - ay) * s);
  if (e.type === 'stroke') return { ...e, width: r2(e.width * s), points: e.points.map(([x, y, p]): Point => [X(x), Y(y), p]) };
  if (e.type === 'shape')
    return {
      ...e,
      width: r2(e.width * s),
      unit: e.unit && r2(e.unit * s),
      arc: e.arc && { ...e.arc, r: r2(e.arc.r * s) },
      pts: e.pts.map(([x, y]): P => [X(x), Y(y)]),
    };
  return { ...e, x: X(e.x), y: Y(e.y), w: r2(e.w * s), h: r2(e.h * s) };
}

function unionBox(els: El[]): BBox | null {
  if (!els.length) return null;
  const bs = els.map(elBBox);
  return {
    minX: Math.min(...bs.map((b) => b.minX)),
    minY: Math.min(...bs.map((b) => b.minY)),
    maxX: Math.max(...bs.map((b) => b.maxX)),
    maxY: Math.max(...bs.map((b) => b.maxY)),
  };
}

/** Kierunek a→b przyciągnięty do wielokrotności 15°. */
function snap15(a: P, b: P): P {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const step = Math.PI / 12;
  const ang = Math.round(Math.atan2(b[1] - a[1], b[0] - a[0]) / step) * step;
  return [r2(a[0] + Math.cos(ang) * len), r2(a[1] + Math.sin(ang) * len)];
}

export class Board implements BoardApi {
  doc: El[] = [];
  cam: Camera = { x: 0, y: 0, z: 1 };

  private history = new History();
  private bg: HTMLCanvasElement;
  private fg: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private fctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private left = 0;
  private top = 0;
  private mode: Mode | null = null;
  private keys = { space: false, shift: false, alt: false, ctrl: false };
  private hover: { x: number; y: number } | null = null;
  /** etykiety ramek na ekranie – do klikania i przeciągania */
  private labels: LabelRect[] = [];
  /** uchwyty w prawym dolnym rogu stron */
  private handles: LabelRect[] = [];
  /** elementy chwilowo rysowane na wierzchu (przeciągane) */
  private hidden = new Set<string>();
  /** zaznaczone elementy (id) */
  private sel = new Set<string>();
  /** kąt w trakcie rysowania: po pierwszym ramieniu czekamy na kliknięcie drugiego */
  private angleDraft: { v: P; a: P; color: string; width: number } | null = null;
  /** ustawiony cyrkiel: nóżka (środek) i rozstaw */
  private compass: { c: P; r: number } | null = null;
  /** punkty kluczowe do przyciągania (przecięcia itd.) – liczone na żądanie */
  private snapCache: P[] | null = null;
  /** punkt, do którego właśnie przyciągnęło – pokazujemy kółeczko */
  private snapHit: P | null = null;
  /** ile razy wklejono ten sam schowek – kolejne wklejenia przesuwamy */
  private pasteCount = new Map<string, number>();
  private images: ImageStore;
  /** wczytane obrazki: null = wczytywanie */
  private imgCache = new Map<string, HTMLImageElement | null>();
  private bgDirty = false;
  private fgDirty = false;
  private raf = 0;
  private saveTimer = 0;
  private contentDirty = false;
  private camDirty = false;
  private idCounter = 0;
  private lastSelUI = '';
  private disposers: (() => void)[] = [];

  constructor(
    private root: HTMLElement,
    init: BoardInit,
    private onSave: SaveFn,
  ) {
    this.doc = init.doc;
    this.images = init.images;
    if (init.cam) this.cam = init.cam;
    this.bg = document.createElement('canvas');
    this.fg = document.createElement('canvas');
    this.bg.className = 'board-canvas';
    this.fg.className = 'board-canvas';
    root.append(this.bg, this.fg);
    this.bctx = this.bg.getContext('2d')!;
    this.fctx = this.fg.getContext('2d')!;

    this.resize();

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(root);
    this.disposers.push(() => ro.disconnect());

    this.listen(this.fg, 'pointerdown', this.onDown);
    this.listen(this.fg, 'pointermove', this.onMove);
    this.listen(this.fg, 'pointerup', this.onUp);
    this.listen(this.fg, 'pointercancel', this.onUp);
    this.listen(this.fg, 'pointerleave', () => {
      this.hover = null;
      this.requestFg();
    });
    this.listen(this.fg, 'wheel', this.onWheel, { passive: false });
    this.listen(this.fg, 'contextmenu', (e) => e.preventDefault());
    this.listen(window, 'keydown', this.onKeyDown);
    this.listen(window, 'keyup', this.onKeyUp);
    this.listen(window, 'blur', () => {
      this.keys.space = this.keys.shift = this.keys.alt = this.keys.ctrl = false;
      this.updateCursor();
    });
    this.listen(window, 'pagehide', () => this.flushSave());
    this.listen(window, 'copy', (e) => this.onCopy(e, false));
    this.listen(window, 'cut', (e) => this.onCopy(e, true));
    this.listen(window, 'paste', this.onPaste);
    this.listen(this.fg, 'dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    this.listen(this.fg, 'drop', this.onDrop);

    const unsub = useUI.subscribe((s, prev) => {
      if (s.tool !== prev.tool || s.shapeKind !== prev.shapeKind) this.angleDraft = null;
      if (s.showGrid !== prev.showGrid) this.requestBg();
      if (s.tool !== prev.tool || s.frameOrientation !== prev.frameOrientation || s.shapeKind !== prev.shapeKind) {
        this.updateCursor();
        this.requestFg();
      }
    });
    this.disposers.push(unsub);

    useUI.setState({ api: this, selection: null });
    this.updateCursor();
    this.syncUI();
  }

  destroy() {
    this.flushSave();
    this.disposers.forEach((d) => d());
    cancelAnimationFrame(this.raf);
    this.bg.remove();
    this.fg.remove();
    if (useUI.getState().api === this) useUI.setState({ api: null, selection: null });
  }

  // ---------- API dla interfejsu ----------

  undo() {
    if (this.mode) return;
    const op = this.history.undoStack.pop();
    if (!op) return;
    this.revert(op);
    this.history.redoStack.push(op);
    this.changed();
  }

  redo() {
    if (this.mode) return;
    const op = this.history.redoStack.pop();
    if (!op) return;
    this.apply(op);
    this.history.undoStack.push(op);
    this.changed();
  }

  undoSeries() {
    if (this.mode) return;
    const n = this.history.seriesLength(SERIES_GAP);
    for (let i = 0; i < n; i++) this.undo();
  }

  zoomBy(f: number) {
    this.zoomAt(this.w / 2, this.h / 2, f);
  }

  zoomReset() {
    this.zoomAt(this.w / 2, this.h / 2, 1 / this.cam.z);
  }

  getElements() {
    return this.doc;
  }

  /** Nowa strona pod ostatnią (albo na początku treści) i przewinięcie do niej. */
  addPage() {
    const frames = sortFrames(this.doc.filter(isFrame));
    const last = frames[frames.length - 1];
    // nowa strona w tej samej skali co poprzednia
    const k = last ? frameScale(last) : 1;
    const [aw, ah] = A4[useUI.getState().frameOrientation];
    const w = aw * k;
    const h = ah * k;
    let x: number, y: number;
    const content = unionBox(this.doc.filter((e) => !isFrame(e)));
    if (last) {
      x = last.x;
      y = last.y + last.h + PAGE_GAP;
    } else if (content) {
      x = content.minX - 2 * GRID;
      y = content.minY - 2 * GRID;
    } else {
      x = this.cam.x + this.w / this.cam.z / 2 - w / 2;
      y = this.cam.y + 60 / this.cam.z;
    }
    const f = this.makeFrame(snap(x), snap(y), w, h);
    this.addEls([f]);
    this.cam = { ...this.cam, x: f.x + f.w / 2 - this.w / this.cam.z / 2, y: f.y - 70 / this.cam.z };
    this.requestBg();
    this.camChanged();
  }

  renameFrame(id: string, name: string) {
    this.updateFrame(id, (f) => ({ ...f, name: name.trim() }));
  }

  rotateFrame(id: string) {
    // lewy górny róg zostaje – tam zwykle zaczyna się pisanie
    this.updateFrame(id, (f) => ({ ...f, w: f.h, h: f.w }));
  }

  resetFrameSize(id: string) {
    this.updateFrame(id, (f) => {
      const [w, h] = A4[f.w > f.h ? 'landscape' : 'portrait'];
      return { ...f, w, h };
    });
  }

  deleteFrame(id: string) {
    this.removeIds(new Set([id]));
  }

  recolorSelection(color: string) {
    const items = this.selEls()
      .filter(isInk)
      .filter((e) => e.color !== color)
      .map((before) => ({ before, after: { ...before, color } as El }));
    this.updateItems(items);
  }

  duplicateSelection() {
    const copies = this.selEls().map((e) => moveEl({ ...e, id: this.newId() }, 2 * GRID, 2 * GRID));
    if (!copies.length) return;
    this.addEls(copies);
    this.setSel(copies.map((e) => e.id));
  }

  deleteSelection() {
    this.removeIds(new Set(this.sel));
    this.setSel([]);
  }

  /** Kopiuje zaznaczenie do schowka wewnętrznego; zwraca znacznik do schowka systemowego. */
  copySelection() {
    const els = this.selEls();
    if (!els.length) return '';
    const marker = CLIP_PREFIX + this.newId();
    try {
      localStorage.setItem(CLIP_KEY, JSON.stringify({ marker, els }));
    } catch {
      return '';
    }
    // znacznik w schowku systemowym: późniejszy zrzut ekranu „wygra” z naszym schowkiem
    void navigator.clipboard?.writeText(marker).catch(() => {});
    return marker;
  }

  // ---------- dokument i historia ----------

  private makeFrame(x: number, y: number, w: number, h: number): Frame {
    return { id: this.newId(), type: 'frame', x, y, w, h, name: '' };
  }

  private addEls(els: El[]) {
    this.doc.push(...els);
    const now = performance.now();
    this.pushOp({ kind: 'add', els, t0: now, t1: now });
  }

  private removeIds(ids: Set<string>) {
    const items: { el: El; index: number }[] = [];
    for (let i = this.doc.length - 1; i >= 0; i--) {
      if (ids.has(this.doc[i].id)) {
        items.push({ el: this.doc[i], index: i });
        this.doc.splice(i, 1);
      }
    }
    if (!items.length) return;
    const now = performance.now();
    this.pushOp({ kind: 'remove', items, t0: now, t1: now });
  }

  private updateItems(items: { before: El; after: El }[]) {
    if (!items.length) return;
    for (const { before, after } of items) this.replace(before, after);
    const now = performance.now();
    this.pushOp({ kind: 'update', items, t0: now, t1: now });
  }

  private updateFrame(id: string, fn: (f: Frame) => Frame) {
    const before = this.doc.find((e): e is Frame => e.id === id && isFrame(e));
    if (before) this.updateItems([{ before, after: fn(before) }]);
  }

  private replace(from: El, to: El) {
    const i = this.doc.findIndex((e) => e.id === from.id);
    if (i >= 0) this.doc[i] = to;
  }

  private apply(op: Op) {
    if (op.kind === 'add') {
      this.doc.push(...op.els);
    } else if (op.kind === 'remove') {
      for (const { el } of op.items) {
        const i = this.doc.indexOf(el);
        if (i >= 0) this.doc.splice(i, 1);
      }
    } else {
      for (const { before, after } of op.items) this.replace(before, after);
    }
  }

  private revert(op: Op) {
    if (op.kind === 'add') {
      const set = new Set(op.els);
      this.doc = this.doc.filter((e) => !set.has(e));
    } else if (op.kind === 'remove') {
      for (let i = op.items.length - 1; i >= 0; i--) {
        const { el, index } = op.items[i];
        this.doc.splice(Math.min(index, this.doc.length), 0, el);
      }
    } else {
      for (const { before, after } of op.items) this.replace(after, before);
    }
  }

  private pushOp(op: Op) {
    this.history.push(op);
    this.changed();
  }

  private changed() {
    this.contentDirty = true;
    this.snapCache = null;
    this.requestBg();
    this.syncUI();
    this.scheduleSave();
  }

  private camChanged() {
    this.camDirty = true;
    this.scheduleSave();
  }

  private syncUI() {
    useUI.setState({
      zoom: this.cam.z,
      canUndo: this.history.undoStack.length > 0,
      canRedo: this.history.redoStack.length > 0,
      boardCount: this.doc.length,
    });
  }

  private newId() {
    return Date.now().toString(36) + (this.idCounter++).toString(36) + Math.random().toString(36).slice(2, 5);
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flushSave(), 400);
  }

  private flushSave() {
    clearTimeout(this.saveTimer);
    if (!this.contentDirty && !this.camDirty) return;
    this.onSave(this.doc, this.cam, this.contentDirty);
    this.contentDirty = this.camDirty = false;
  }

  // ---------- współrzędne ----------

  private screenOf(e: { clientX: number; clientY: number }): [number, number] {
    return [e.clientX - this.left, e.clientY - this.top];
  }

  private toWorld(sx: number, sy: number): [number, number] {
    return [sx / this.cam.z + this.cam.x, sy / this.cam.z + this.cam.y];
  }

  private toScreen(x: number, y: number): [number, number] {
    return [(x - this.cam.x) * this.cam.z, (y - this.cam.y) * this.cam.z];
  }

  private zoomAt(sx: number, sy: number, f: number) {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.cam.z * f));
    const [wx, wy] = this.toWorld(sx, sy);
    this.cam = { x: wx - sx / z, y: wy - sy / z, z };
    this.requestBg();
    this.requestFg();
    this.syncUI();
    this.camChanged();
  }

  private labelAt(sx: number, sy: number) {
    return this.rectAt(this.labels, sx, sy);
  }

  private handleAt(sx: number, sy: number) {
    return this.rectAt(this.handles, sx, sy);
  }

  private rectAt(rects: LabelRect[], sx: number, sy: number) {
    for (let i = rects.length - 1; i >= 0; i--) {
      const l = rects[i];
      if (sx >= l.x && sx <= l.x + l.w && sy >= l.y && sy <= l.y + l.h) return l;
    }
    return null;
  }

  /** Najwyżej położona strona pod punktem ekranu. */
  private frameAt(sx: number, sy: number) {
    const [wx, wy] = this.toWorld(sx, sy);
    const frames = this.doc.filter(isFrame);
    for (let i = frames.length - 1; i >= 0; i--) {
      if (insideRect(wx, wy, elBBox(frames[i]))) return frames[i];
    }
    return undefined;
  }

  // ---------- zaznaczenie ----------

  private selEls() {
    return this.doc.filter((e) => this.sel.has(e.id));
  }

  private setSel(ids: string[]) {
    this.sel = new Set(ids);
    this.requestBg();
  }

  private selBox() {
    return unionBox(this.selEls());
  }

  private onSelHandle(b: BBox, sx: number, sy: number) {
    const [hx, hy] = this.toScreen(b.maxX, b.maxY);
    return Math.abs(sx - hx) <= HANDLE_PX && Math.abs(sy - hy) <= HANDLE_PX;
  }

  private inBox(b: BBox, sx: number, sy: number) {
    const [x, y] = this.toWorld(sx, sy);
    return insideRect(x, y, b);
  }

  /** Element pod kursorem: najpierw pismo i figury, potem obrazki. */
  private elementAt(sx: number, sy: number) {
    const [x, y] = this.toWorld(sx, sy);
    const r = PICK_PX / this.cam.z;
    for (let i = this.doc.length - 1; i >= 0; i--) {
      const e = this.doc[i];
      if (e.type === 'stroke' && hitStroke(e, x, y, x, y, r)) return e;
      if (e.type === 'shape' && hitShape(e, x, y, x, y, r)) return e;
    }
    for (let i = this.doc.length - 1; i >= 0; i--) {
      const e = this.doc[i];
      if (isImage(e) && insideRect(x, y, elBBox(e))) return e;
    }
    return undefined;
  }

  /** Pokazuje / chowa pasek akcji zaznaczenia (React). */
  private publishSelection() {
    let ui: SelectionUI | null = null;
    const m = this.mode;
    const busy = m?.kind === 'selMove' || m?.kind === 'selScale' || m?.kind === 'lasso';
    const els = this.selEls();
    const b = unionBox(els);
    if (b && !busy) {
      const [x, y] = this.toScreen(b.minX, b.minY);
      ui = { x, y, w: (b.maxX - b.minX) * this.cam.z, h: (b.maxY - b.minY) * this.cam.z, count: els.length, ink: els.some(isInk) };
    }
    const key = JSON.stringify(ui);
    if (key !== this.lastSelUI) {
      this.lastSelUI = key;
      useUI.setState({ selection: ui });
    }
  }

  // ---------- obrazki i schowek ----------

  /** Obrazek z pamięci podręcznej; jeśli go nie ma – wczytuje i przerysowuje po wczytaniu. */
  private getImg(imageId: string) {
    if (this.imgCache.has(imageId)) return this.imgCache.get(imageId) ?? null;
    this.imgCache.set(imageId, null);
    void this.images.get(imageId).then((url) => {
      if (!url) return void this.imgCache.delete(imageId);
      const img = new Image();
      img.onload = () => {
        this.imgCache.set(imageId, img);
        this.requestBg();
        this.requestFg();
      };
      img.src = url;
    });
    return null;
  }

  private drawImageEl(c: CanvasRenderingContext2D, el: ImageEl) {
    const img = this.getImg(el.imageId);
    if (img) {
      c.drawImage(img, el.x, el.y, el.w, el.h);
    } else {
      c.fillStyle = '#eef1f6';
      c.fillRect(el.x, el.y, el.w, el.h);
    }
  }

  /** Rysuje elementy w kolejności warstw: obrazki pod spodem, pismo i figury na wierzchu. */
  private drawEls(c: CanvasRenderingContext2D, els: El[]) {
    for (const e of els) if (isImage(e)) this.drawImageEl(c, e);
    for (const e of els) if (isInk(e)) drawInk(c, e);
  }

  private onCopy = (e: ClipboardEvent, cut: boolean) => {
    const ui = useUI.getState();
    if (isTyping(e.target) || ui.newNote.open || ui.exportOpen || !this.sel.size) return;
    const marker = this.copySelection();
    if (!marker) return;
    e.clipboardData?.setData('text/plain', marker);
    e.preventDefault();
    if (cut) this.deleteSelection();
  };

  private onPaste = (e: ClipboardEvent) => {
    const ui = useUI.getState();
    if (isTyping(e.target) || ui.newNote.open || ui.exportOpen) return;
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (file) {
      e.preventDefault();
      void this.insertImage(file, this.w / 2, this.h / 2);
      return;
    }
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (text.startsWith(CLIP_PREFIX)) {
      e.preventDefault();
      this.pasteClip(text);
    }
  };

  private pasteClip(marker: string) {
    let els: El[] = [];
    try {
      const data = JSON.parse(localStorage.getItem(CLIP_KEY) ?? 'null');
      if (data?.marker === marker) els = data.els;
    } catch {
      return;
    }
    const b = unionBox(els);
    if (!b) return;
    // widoczne źródło → wklej obok (każde kolejne trochę dalej); niewidoczne → na środek ekranu
    const view = { minX: this.cam.x, minY: this.cam.y, maxX: this.cam.x + this.w / this.cam.z, maxY: this.cam.y + this.h / this.cam.z };
    let dx: number, dy: number;
    if (bboxOverlap(b, view)) {
      const n = (this.pasteCount.get(marker) ?? 0) + 1;
      this.pasteCount.set(marker, n);
      dx = dy = 2 * GRID * n;
    } else {
      const [cx, cy] = this.toWorld(this.w / 2, this.h / 2);
      dx = snap(cx - (b.minX + b.maxX) / 2);
      dy = snap(cy - (b.minY + b.maxY) / 2);
    }
    const copies = els.map((e) => moveEl({ ...e, id: this.newId() }, dx, dy));
    this.addEls(copies);
    this.setSel(copies.map((e) => e.id));
  }

  private onDrop = (e: DragEvent) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    const pdf = files.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (pdf) {
      e.preventDefault();
      void startPdfImport(pdf);
      return;
    }
    const file = files.find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    const [sx, sy] = this.screenOf(e);
    void this.insertImage(file, sx, sy);
  };

  /** Wstawia obrazek wyśrodkowany w punkcie ekranu; mieści się w ~60% widoku. */
  async insertImage(file: Blob, sx: number, sy: number) {
    const { dataUrl, w, h } = await prepareImage(file);
    const imageId = this.newId() + 'i';
    await this.images.put(imageId, dataUrl);
    const z = this.cam.z;
    const k = Math.min(1 / this.dpr, (this.w * 0.6) / z / w, (this.h * 0.7) / z / h);
    const [cx, cy] = this.toWorld(sx, sy);
    const el: ImageEl = { id: this.newId(), type: 'image', x: r2(cx - (w * k) / 2), y: r2(cy - (h * k) / 2), w: r2(w * k), h: r2(h * k), imageId };
    this.addEls([el]);
    this.setSel([el.id]);
  }

  /**
   * Strony zaimportowanego PDF: obrazek + ramka A4 na każdą stronę, jedna pod drugą,
   * pod dotychczasową treścią. Eksport PDF odda ten sam dokument z dopiskami.
   */
  async insertPdfPages(pages: PdfPageImage[]) {
    if (!pages.length) return;
    // 1 pt PDF → świat tak, żeby strona A4 miała dokładnie rozmiar ramki A4
    const K = A4.portrait[0] / 595.28;
    const content = unionBox(this.doc);
    let x: number, y: number;
    if (content) {
      x = snap(content.minX);
      y = snap(content.maxY + 4 * GRID);
    } else {
      const [cx, cy] = this.toWorld(this.w / 2, 90);
      x = snap(cx - (pages[0].wPt * K) / 2);
      y = snap(cy);
    }
    const els: El[] = [];
    for (const p of pages) {
      const w = r2(p.wPt * K);
      const h = r2(p.hPt * K);
      const imageId = this.newId() + 'i';
      await this.images.put(imageId, p.dataUrl);
      // inne formaty niż A4: najmniejsza strona A4 (w skali), w której mieści się cała kartka
      const [aw, ah] = A4[w > h ? 'landscape' : 'portrait'];
      const k = Math.max(w / aw, h / ah);
      els.push({ id: this.newId(), type: 'image', x, y, w, h, imageId });
      els.push(this.makeFrame(x, y, r2(aw * k), r2(ah * k)));
      y = snap(y + ah * k + PAGE_GAP);
    }
    this.addEls(els);
    const first = els[0] as ImageEl;
    const z = this.cam.z;
    this.cam = { ...this.cam, x: first.x + first.w / 2 - this.w / z / 2, y: first.y - 80 / z };
    this.requestBg();
    this.requestFg();
    this.camChanged();
  }

  // ---------- figury ----------

  /**
   * Punkt figury/cyrkla: najpierw przyciąga do punktów konstrukcji (końce, środki, przecięcia),
   * potem do kratki (gdy widoczna; przy dużym zoomie co pół kratki). Z Altem – swobodnie.
   */
  private shapePoint(sx: number, sy: number, free: boolean): P {
    const [x, y] = this.toWorld(sx, sy);
    this.snapHit = null;
    if (free) return [r2(x), r2(y)];
    this.snapCache ??= keyPoints(this.doc);
    const key = nearestKeyPoint(this.snapCache, x, y, SNAP_PX / this.cam.z);
    if (key) {
      this.snapHit = key;
      return [key[0], key[1]];
    }
    if (!useUI.getState().showGrid) return [r2(x), r2(y)];
    const step = this.cam.z >= 3 ? GRID / 2 : GRID;
    return [Math.round(x / step) * step, Math.round(y / step) * step];
  }

  /** Punkty figury z przeciągnięcia start→end (Shift: kwadrat, koło, 15°, trójkąt prostokątny…). */
  private shapeFrom(kind: ShapeKind, a: P, b: P, shift: boolean): Pick<Shape, 'pts' | 'right'> {
    switch (kind) {
      case 'line':
      case 'arrow':
      case 'angle':
        return { pts: [a, shift ? snap15(a, b) : b] };
      case 'rect':
      case 'ellipse': {
        if (!shift) return { pts: [a, b] };
        const d = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        return { pts: [a, [a[0] + Math.sign(b[0] - a[0] || 1) * d, a[1] + Math.sign(b[1] - a[1] || 1) * d]] };
      }
      case 'triangle':
        return { pts: [a, b], right: shift };
      case 'axes': {
        const minX = Math.min(a[0], b[0]), maxY = Math.max(a[1], b[1]);
        // domyślnie początek układu na środku; z Shiftem w lewym dolnym rogu (I ćwiartka)
        const o: P = shift ? [minX + AXIS_UNIT, maxY - AXIS_UNIT] : [snap((a[0] + b[0]) / 2), snap((a[1] + b[1]) / 2)];
        return { pts: [a, b, o] };
      }
      case 'numberline':
        return { pts: [a, [b[0], a[1]], [snap((a[0] + b[0]) / 2), a[1]]] };
      case 'arc':
        return { pts: [a, b] };
    }
  }

  private angleEnd(sx: number, sy: number, free: boolean, shift: boolean): P {
    const d = this.angleDraft!;
    const p = this.shapePoint(sx, sy, free);
    if (!shift) return p;
    // z Shiftem: kąt między ramionami co 15°
    const a1 = Math.atan2(d.a[1] - d.v[1], d.a[0] - d.v[0]);
    const step = Math.PI / 12;
    const rel = Math.round((Math.atan2(p[1] - d.v[1], p[0] - d.v[0]) - a1) / step) * step;
    const len = Math.hypot(p[0] - d.v[0], p[1] - d.v[1]);
    return [r2(d.v[0] + Math.cos(a1 + rel) * len), r2(d.v[1] + Math.sin(a1 + rel) * len)];
  }

  private finishShape(shape: Shape) {
    this.addEls([shape]);
    useUI.setState({ tool: 'pen' }); // jedna figura – potem od razu podpisywanie
  }

  // ---------- wejście ----------

  private listen<K extends keyof WindowEventMap>(
    target: HTMLElement | Window,
    type: K,
    fn: (e: WindowEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ) {
    target.addEventListener(type, fn as EventListener, opts);
    this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts));
  }

  private onDown = (e: PointerEvent) => {
    if (this.mode) return;
    const ui = useUI.getState();
    const [sx, sy] = this.screenOf(e);
    this.hover = { x: sx, y: sy };
    const id = e.pointerId;

    if (e.button === 1 || (e.button === 0 && (this.keys.space || ui.tool === 'hand'))) {
      this.fg.setPointerCapture(id);
      this.mode = { kind: 'pan', sx, sy, cx: this.cam.x, cy: this.cam.y, pointerId: id };
      this.updateCursor();
      return;
    }

    // zaznaczenie: róg = skalowanie, środek = przesuwanie, klik obok = odznacz
    if (e.button === 0 && this.sel.size) {
      const box = this.selBox();
      if (box && this.onSelHandle(box, sx, sy)) {
        this.fg.setPointerCapture(id);
        this.mode = { kind: 'selScale', els: this.selEls(), box, s: 1, pointerId: id };
        this.hidden = new Set(this.sel);
        this.requestBg();
        this.updateCursor();
        return;
      }
      if (box && this.inBox(box, sx, sy) && !(ui.tool === 'select' && e.shiftKey)) {
        this.fg.setPointerCapture(id);
        this.mode = { kind: 'selMove', els: this.selEls(), sx, sy, dx: 0, dy: 0, moved: false, pointerId: id };
        this.updateCursor();
        return;
      }
      if (ui.tool !== 'select') {
        // klik obok tylko odznacza – nie zostawia kropki
        this.setSel([]);
        return;
      }
    }

    if (e.button === 0 && ui.tool === 'select') {
      this.fg.setPointerCapture(id);
      const hit = this.elementAt(sx, sy);
      if (hit) {
        if (e.shiftKey) {
          const next = new Set(this.sel);
          if (next.has(hit.id)) next.delete(hit.id);
          else next.add(hit.id);
          this.setSel([...next]);
          this.mode = null;
          return;
        }
        this.setSel([hit.id]);
        this.mode = { kind: 'selMove', els: this.selEls(), sx, sy, dx: 0, dy: 0, moved: false, pointerId: id };
        return;
      }
      if (!e.shiftKey) this.setSel([]);
      this.mode = { kind: 'lasso', pts: [this.toWorld(sx, sy)], additive: e.shiftKey, pointerId: id };
      return;
    }

    // róg strony: zmiana rozmiaru (zawsze w proporcjach A4)
    const handle = e.button === 0 ? this.handleAt(sx, sy) : null;
    if (handle) {
      const frame = this.doc.find((el): el is Frame => el.id === handle.id && isFrame(el));
      if (frame) {
        this.fg.setPointerCapture(id);
        this.mode = { kind: 'frameResize', frame, sx, w: frame.w, h: frame.h, moved: false, pointerId: id };
        this.updateCursor();
        return;
      }
    }

    // etykieta strony: przeciągnij = przesuń stronę, kliknij = menu
    // z narzędziem strony (F) stronę łapie się w dowolnym miejscu
    const label = e.button === 0 ? this.labelAt(sx, sy) : null;
    const grabbed = label
      ? this.doc.find((el): el is Frame => el.id === label.id && isFrame(el))
      : e.button === 0 && ui.tool === 'frame'
        ? this.frameAt(sx, sy)
        : undefined;
    if (grabbed) {
      // sama strona – żeby dopasować ją do tekstu; z Shiftem razem z zawartością
      const box = elBBox(grabbed);
      const contents = !e.shiftKey
        ? []
        : this.doc.filter((el) => {
            if (isFrame(el)) return false;
            const b = elBBox(el);
            return insideRect((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, box);
          });
      this.fg.setPointerCapture(id);
      this.mode = { kind: 'frameDrag', frame: grabbed, contents, sx, sy, dx: 0, dy: 0, moved: false, pointerId: id };
      return;
    }

    // prawy przycisk (lub przycisk pióra ustawiony jako prawy klik) = gumka
    if (e.button === 2 || (e.button === 0 && ui.tool === 'eraser')) {
      this.fg.setPointerCapture(id);
      const w = this.toWorld(sx, sy);
      this.mode = { kind: 'erase', items: [], last: w, t0: performance.now(), pointerId: id };
      this.eraseSegment(w, w);
      this.updateCursor();
      this.requestFg();
      return;
    }

    if (e.button === 0 && ui.tool === 'frame') {
      const [w, h] = A4[ui.frameOrientation];
      const [wx, wy] = this.toWorld(sx, sy);
      this.addEls([this.makeFrame(snap(wx - w / 2), snap(wy - h / 2), w, h)]);
      useUI.setState({ tool: 'pen' }); // jedna strona na kliknięcie – potem od razu pisanie
      return;
    }

    if (e.button === 0 && ui.tool === 'compass') {
      const k = this.compass;
      // Jasny podział czynności:
      //   przeciąganie         = rysuj łuk (gdziekolwiek – liczy się kąt wokół nóżki)
      //   Shift + przeciąganie = nowe wbicie nóżki i nowy rozstaw
      //   Ctrl + klik          = przenieś nóżkę, rozstaw bez zmian
      if (k && (e.ctrlKey || e.metaKey)) {
        this.compass = { c: this.shapePoint(sx, sy, e.altKey), r: k.r };
        this.requestFg();
        return;
      }
      this.fg.setPointerCapture(id);
      if (k && !e.shiftKey) {
        const [wx, wy] = this.toWorld(sx, sy);
        const a0 = Math.atan2(wy - k.c[1], wx - k.c[0]);
        this.mode = { kind: 'compassArc', a0, last: a0, sweep: 0, pointerId: id };
        this.requestFg();
        return;
      }
      const c = this.shapePoint(sx, sy, e.altKey);
      this.mode = { kind: 'compassSet', c, p: c, pointerId: id };
      this.requestFg();
      return;
    }

    if (e.button === 0 && ui.tool === 'shape') {
      // kąt, drugie kliknięcie: drugie ramię
      if (ui.shapeKind === 'angle' && this.angleDraft) {
        const d = this.angleDraft;
        this.angleDraft = null;
        this.finishShape({
          id: this.newId(), type: 'shape', kind: 'angle', color: d.color, width: d.width,
          pts: [d.v, d.a, this.angleEnd(sx, sy, e.altKey, e.shiftKey)],
        });
        return;
      }
      this.fg.setPointerCapture(id);
      const p = this.shapePoint(sx, sy, e.altKey);
      this.mode = {
        kind: 'shape',
        start: p,
        pointerId: id,
        shape: {
          id: this.newId(), type: 'shape', kind: ui.shapeKind, color: ui.color, width: ui.width,
          unit: AXIS_UNIT, ...this.shapeFrom(ui.shapeKind, p, p, e.shiftKey),
        },
      };
      this.requestFg();
      return;
    }

    if (e.button === 0 && ui.tool === 'pen') {
      this.fg.setPointerCapture(id);
      const [x, y] = this.toWorld(sx, sy);
      const usePressure = ui.pressure && e.pointerType === 'pen';
      this.mode = {
        kind: 'draw',
        t0: performance.now(),
        pointerId: id,
        stroke: {
          id: this.newId(),
          type: 'stroke',
          points: [[x, y, usePressure ? e.pressure || 0.5 : 0.5]],
          color: ui.color,
          width: ui.width,
          pressure: usePressure,
          straight: this.keys.shift,
          streamline: 0.15 + ui.smoothing * 0.6,
        },
      };
      this.requestFg();
    }
  };

  private onMove = (e: PointerEvent) => {
    const [sx, sy] = this.screenOf(e);
    this.hover = { x: sx, y: sy };
    this.keys.alt = e.altKey;
    this.keys.ctrl = e.ctrlKey || e.metaKey;
    const m = this.mode;

    if (!m || m.pointerId !== e.pointerId) {
      const tool = useUI.getState().tool;
      if (tool === 'compass' || tool === 'shape') this.shapePoint(sx, sy, e.altKey); // kółeczko przyciągania
      if (tool === 'eraser' || tool === 'frame' || tool === 'compass' || tool === 'shape' || this.angleDraft) this.requestFg();
      this.updateCursor();
      return;
    }

    if (m.kind === 'pan') {
      this.cam = { ...this.cam, x: m.cx - (sx - m.sx) / this.cam.z, y: m.cy - (sy - m.sy) / this.cam.z };
      this.requestBg();
      return;
    }

    if (m.kind === 'compassSet') {
      m.p = this.shapePoint(sx, sy, e.altKey);
      this.requestFg();
      return;
    }

    if (m.kind === 'compassArc') {
      if (!this.compass) return;
      const [wx, wy] = this.toWorld(sx, sy);
      const ang = Math.atan2(wy - this.compass.c[1], wx - this.compass.c[0]);
      const d = ang - m.last;
      m.sweep += Math.atan2(Math.sin(d), Math.cos(d));
      m.sweep = Math.max(-Math.PI * 2, Math.min(Math.PI * 2, m.sweep));
      m.last = ang;
      this.requestFg();
      return;
    }

    if (m.kind === 'shape') {
      const p = this.shapePoint(sx, sy, e.altKey);
      m.shape = { ...m.shape, ...this.shapeFrom(m.shape.kind, m.start, p, e.shiftKey) };
      this.requestFg();
      return;
    }

    if (m.kind === 'lasso') {
      const p = this.toWorld(sx, sy);
      const last = m.pts[m.pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) * this.cam.z > 3) m.pts.push(p);
      this.requestFg();
      return;
    }

    if (m.kind === 'selMove') {
      if (!m.moved && Math.hypot(sx - m.sx, sy - m.sy) < 3) return;
      if (!m.moved) {
        m.moved = true;
        this.hidden = new Set(m.els.map((el) => el.id));
        this.requestBg();
      }
      m.dx = (sx - m.sx) / this.cam.z;
      m.dy = (sy - m.sy) / this.cam.z;
      this.requestFg();
      return;
    }

    if (m.kind === 'selScale') {
      const [x, y] = this.toWorld(sx, sy);
      const bw = m.box.maxX - m.box.minX || 1;
      const bh = m.box.maxY - m.box.minY || 1;
      m.s = Math.max(0.1, Math.max((x - m.box.minX) / bw, (y - m.box.minY) / bh));
      this.requestFg();
      return;
    }

    if (m.kind === 'frameResize') {
      if (!m.moved) {
        m.moved = true;
        this.hidden = new Set([m.frame.id]);
        this.requestBg();
      }
      const base = m.frame.w / frameScale(m.frame);
      const raw = m.frame.w + (sx - m.sx) / this.cam.z;
      const w = Math.min(base * MAX_SCALE, Math.max(base * MIN_SCALE, snap(raw)));
      m.w = w;
      m.h = (w * m.frame.h) / m.frame.w;
      this.requestFg();
      return;
    }

    if (m.kind === 'frameDrag') {
      if (!m.moved && Math.hypot(sx - m.sx, sy - m.sy) < 4) return;
      if (!m.moved) {
        m.moved = true;
        this.hidden = new Set([m.frame.id, ...m.contents.map((s) => s.id)]);
        this.requestBg();
      }
      // pozycja strony przyciągana do kratki
      m.dx = snap(m.frame.x + (sx - m.sx) / this.cam.z) - m.frame.x;
      m.dy = snap(m.frame.y + (sy - m.sy) / this.cam.z) - m.frame.y;
      this.requestFg();
      return;
    }

    if (m.kind === 'erase') {
      const w = this.toWorld(sx, sy);
      this.eraseSegment(m.last, w);
      m.last = w;
      this.requestFg();
      return;
    }

    const s = m.stroke;
    const events = e.getCoalescedEvents?.() ?? [];
    for (const ev of events.length ? events : [e]) {
      const [x, y] = this.toWorld(...this.screenOf(ev));
      const p = s.pressure ? ev.pressure || 0.5 : 0.5;
      if (s.straight) {
        s.points = [s.points[0], snapAngle(s.points[0], [x, y, p])];
        continue;
      }
      const last = s.points[s.points.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) < 0.3 / this.cam.z) continue;
      s.points.push([x, y, p]);
    }
    this.requestFg();
  };

  private onUp = (e: PointerEvent) => {
    const m = this.mode;
    if (!m || m.pointerId !== e.pointerId) return;
    this.mode = null;
    const t1 = performance.now();

    if (m.kind === 'draw') {
      const s = m.stroke;
      s.points = s.points.map(([x, y, p]): Point => [r2(x), r2(y), r2(p)]);
      this.doc.push(s);
      this.pushOp({ kind: 'add', els: [s], t0: m.t0, t1 });
    } else if (m.kind === 'erase') {
      if (m.items.length) this.pushOp({ kind: 'remove', items: m.items, t0: m.t0, t1 });
    } else if (m.kind === 'compassSet') {
      const r = Math.hypot(m.p[0] - m.c[0], m.p[1] - m.c[1]);
      if (r >= GRID / 4) this.compass = { c: m.c, r };
      // samo kliknięcie: przenieś nóżkę, rozstaw bez zmian (jak w konstrukcjach)
      else if (this.compass) this.compass = { c: m.c, r: this.compass.r };
    } else if (m.kind === 'compassArc') {
      const k = this.compass;
      if (k && Math.abs(m.sweep) > 0.03) {
        const ui = useUI.getState();
        this.addEls([
          {
            id: this.newId(), type: 'shape', kind: 'arc', pts: [k.c], color: ui.color, width: ui.width,
            arc: { r: r2(k.r), a0: m.a0, sweep: Math.abs(m.sweep) > Math.PI * 2 - 0.05 ? Math.PI * 2 : m.sweep },
          },
        ]);
      }
    } else if (m.kind === 'shape') {
      const [a, b] = m.shape.pts;
      const big = Math.hypot(b[0] - a[0], b[1] - a[1]) >= GRID / 2;
      if (big && m.shape.kind === 'angle') {
        // pierwsze ramię gotowe – drugie wskazujemy kliknięciem
        this.angleDraft = { v: a, a: b, color: m.shape.color, width: m.shape.width };
      } else if (big) {
        this.finishShape(m.shape);
      }
    } else if (m.kind === 'lasso') {
      if (m.pts.length > 2) {
        const hits = this.doc.filter((el) => !isFrame(el) && lassoContains(el, m.pts)).map((el) => el.id);
        this.setSel(m.additive ? [...this.sel, ...hits] : hits);
      }
    } else if (m.kind === 'selMove') {
      this.hidden = new Set();
      if (m.moved && (m.dx || m.dy)) {
        this.updateItems(m.els.map((before) => ({ before, after: moveEl(before, m.dx, m.dy) })));
      } else {
        this.requestBg();
      }
    } else if (m.kind === 'selScale') {
      this.hidden = new Set();
      if (Math.abs(m.s - 1) > 0.005) {
        this.updateItems(m.els.map((before) => ({ before, after: scaleEl(before, m.box.minX, m.box.minY, m.s) })));
      } else {
        this.requestBg();
      }
    } else if (m.kind === 'frameResize') {
      this.hidden = new Set();
      if (m.w !== m.frame.w) {
        this.updateItems([{ before: m.frame, after: { ...m.frame, w: m.w, h: m.h } }]);
      } else {
        this.requestBg();
      }
    } else if (m.kind === 'frameDrag') {
      this.hidden = new Set();
      if (!m.moved) {
        this.frameMenu(m.frame, e.clientX, e.clientY);
      } else if (m.dx || m.dy) {
        this.updateItems([m.frame, ...m.contents].map((before) => ({ before, after: moveEl(before, m.dx, m.dy) })));
      } else {
        this.requestBg();
      }
    } else {
      this.camChanged();
    }
    this.updateCursor();
    this.requestBg();
    this.requestFg();
  };

  private frameMenu(f: Frame, clientX: number, clientY: number) {
    const label = this.labels.find((l) => l.id === f.id);
    useUI.setState({
      menu: {
        x: clientX,
        y: clientY,
        items: [
          {
            label: 'Rename page',
            onClick: () =>
              label && useUI.setState({ frameEdit: { id: f.id, x: label.x, y: label.y, value: f.name } }),
          },
          { label: f.w > f.h ? 'Make portrait' : 'Make landscape', onClick: () => this.rotateFrame(f.id) },
          ...(Math.round(frameScale(f) * 100) !== 100
            ? [{ label: 'Reset to A4 size (100%)', onClick: () => this.resetFrameSize(f.id) }]
            : []),
          { label: 'Delete page (keeps drawings)', danger: true, onClick: () => this.deleteFrame(f.id) },
        ],
      },
    });
  }

  private eraseSegment(a: [number, number], b: [number, number]) {
    const m = this.mode;
    if (m?.kind !== 'erase') return;
    const r = ERASER_PX / this.cam.z;
    let hit = false;
    for (let i = this.doc.length - 1; i >= 0; i--) {
      const el = this.doc[i];
      const touched =
        (el.type === 'stroke' && hitStroke(el, a[0], a[1], b[0], b[1], r)) ||
        (el.type === 'shape' && hitShape(el, a[0], a[1], b[0], b[1], r));
      if (touched) {
        this.doc.splice(i, 1);
        m.items.push({ el, index: i });
        this.sel.delete(el.id);
        hit = true;
      }
    }
    if (hit) this.requestBg();
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [sx, sy] = this.screenOf(e);
    // jak w Miro: kółko = zoom; Shift + kółko = przewijanie w bok, Alt + kółko = w pionie
    if (e.shiftKey || e.altKey) {
      const k = e.deltaMode === 1 ? 20 : 1;
      const d = (e.deltaY || e.deltaX) * k;
      this.cam = e.shiftKey
        ? { ...this.cam, x: this.cam.x + d / this.cam.z }
        : { ...this.cam, y: this.cam.y + d / this.cam.z };
      this.requestBg();
      this.requestFg();
      this.camChanged();
      return;
    }
    const k = e.deltaMode === 1 ? 0.05 : 0.0015;
    this.zoomAt(sx, sy, Math.exp(-e.deltaY * k));
  };

  private onKeyDown = (e: KeyboardEvent) => {
    const ui = useUI.getState();
    if (isTyping(e.target) || ui.newNote.open || ui.exportOpen) return;
    if (e.key === 'Control' || e.key === 'Meta') {
      this.keys.ctrl = true;
      if (ui.tool === 'compass') this.requestFg();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      if (!this.keys.space) {
        this.keys.space = true;
        this.updateCursor();
      }
      return;
    }
    if (e.key === 'Shift') {
      this.keys.shift = true;
      const m = this.mode;
      if (m?.kind === 'draw' && !m.stroke.straight) {
        const s = m.stroke;
        s.straight = true;
        s.points = [s.points[0], snapAngle(s.points[0], s.points[s.points.length - 1])];
      }
      this.requestFg();
      return;
    }
    if (this.sel.size && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      this.deleteSelection();
      return;
    }
    if (e.key === 'Escape') {
      if (this.angleDraft) {
        this.angleDraft = null;
        this.requestFg();
        return;
      }
      if (this.sel.size) return this.setSel([]);
      if (ui.tool === 'compass' && this.compass) {
        this.compass = null;
        this.requestFg();
        return;
      }
      if (ui.tool === 'frame' || ui.tool === 'shape' || ui.tool === 'compass') return useUI.setState({ tool: 'pen' });
    }
    const action = matchShortcut(e, ui.shortcuts);
    if (action) {
      e.preventDefault();
      this.run(action);
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      e.preventDefault();
      this.keys.space = false;
      this.updateCursor();
    }
    if (e.key === 'Shift') {
      this.keys.shift = false;
      this.requestFg();
    }
    if (e.key === 'Control' || e.key === 'Meta') {
      this.keys.ctrl = false;
      this.requestFg();
    }
  };

  private run(action: Action) {
    const set = useUI.setState;
    if ((SHAPE_ACTIONS as readonly string[]).includes(action)) {
      set({ tool: 'shape', shapeKind: action as ShapeKind });
      return;
    }
    switch (action) {
      case 'select':
      case 'pen':
      case 'eraser':
      case 'hand':
      case 'frame':
      case 'compass':
        set({ tool: action });
        break;
      case 'undo': this.undo(); break;
      case 'redo': this.redo(); break;
      case 'undoSeries': this.undoSeries(); break;
      case 'width1': case 'width2': case 'width3': case 'width4':
        set({ width: WIDTHS[Number(action.slice(5)) - 1], tool: 'pen' });
        break;
      case 'zoomIn': this.zoomBy(1.25); break;
      case 'zoomOut': this.zoomBy(0.8); break;
      case 'zoomReset': this.zoomReset(); break;
      case 'togglePressure': set({ pressure: !useUI.getState().pressure }); break;
      case 'addPage': this.addPage(); break;
      case 'selectAll':
        this.setSel(this.doc.filter((el) => !isFrame(el)).map((el) => el.id));
        break;
      case 'duplicate': this.duplicateSelection(); break;
      case 'toggleGrid': {
        const g = !useUI.getState().showGrid;
        set({ showGrid: g, pdfGrid: g });
        break;
      }
      default: runAppAction(action);
    }
  }

  private updateCursor() {
    const tool = useUI.getState().tool;
    const m = this.mode;
    const hv = this.hover;
    const box = !m && hv && this.sel.size ? this.selBox() : null;
    let c = 'crosshair';
    if (m?.kind === 'pan') c = 'grabbing';
    else if (m?.kind === 'selMove') c = 'move';
    else if (m?.kind === 'selScale' || m?.kind === 'frameResize') c = 'nwse-resize';
    else if (box && hv && this.onSelHandle(box, hv.x, hv.y)) c = 'nwse-resize';
    else if (box && hv && this.inBox(box, hv.x, hv.y)) c = 'move';
    else if (!m && hv && this.handleAt(hv.x, hv.y)) c = 'nwse-resize';
    else if (m?.kind === 'frameDrag') c = m.moved ? 'grabbing' : 'pointer';
    else if (this.keys.space || tool === 'hand') c = 'grab';
    else if (!m && hv && this.labelAt(hv.x, hv.y)) c = 'move';
    else if (m?.kind === 'erase' || tool === 'eraser') c = 'none';
    else if (tool === 'frame') c = hv && this.frameAt(hv.x, hv.y) ? 'move' : 'copy';
    else if (tool === 'select') c = !m && hv && this.elementAt(hv.x, hv.y) ? 'move' : 'default';
    else if (tool === 'compass') c = 'none';
    if (this.fg.style.cursor !== c) this.fg.style.cursor = c;
  }

  // ---------- rysowanie ----------

  private resize() {
    const r = this.root.getBoundingClientRect();
    this.left = r.left;
    this.top = r.top;
    this.w = r.width;
    this.h = r.height;
    this.dpr = window.devicePixelRatio || 1;
    for (const c of [this.bg, this.fg]) {
      c.width = Math.round(this.w * this.dpr);
      c.height = Math.round(this.h * this.dpr);
    }
    this.requestBg();
    this.requestFg();
  }

  private requestBg() {
    this.bgDirty = true;
    this.schedule();
  }

  private requestFg() {
    this.fgDirty = true;
    this.schedule();
  }

  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = () => {
    this.raf = 0;
    if (this.bgDirty) this.renderBg();
    if (this.fgDirty) this.renderFg();
    this.bgDirty = this.fgDirty = false;
  };

  private worldTransform(c: CanvasRenderingContext2D) {
    const { x, y, z } = this.cam;
    const k = this.dpr * z;
    c.setTransform(k, 0, 0, k, -k * x, -k * y);
  }

  private screenTransform(c: CanvasRenderingContext2D) {
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private drawFrameBox(c: CanvasRenderingContext2D, f: Frame) {
    const z = this.cam.z;
    c.fillStyle = 'rgba(31, 95, 209, 0.025)';
    c.fillRect(f.x, f.y, f.w, f.h);
    c.strokeStyle = '#8fa3c4';
    c.lineWidth = 1.5 / z;
    c.strokeRect(f.x, f.y, f.w, f.h);
  }

  private drawLabel(c: CanvasRenderingContext2D, text: string, sx: number, sy: number) {
    c.font = '600 12px system-ui, "Segoe UI", sans-serif';
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    const grip = 14;
    const w = c.measureText(text).width + 12 + grip;
    c.fillStyle = '#e6ecf5';
    c.beginPath();
    c.roundRect(sx, sy - 22, w, 18, 5);
    c.fill();
    // uchwyt „przeciągnij” – 2 × 3 kropki
    c.fillStyle = '#8a9bb8';
    for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) c.fillRect(sx + 6 + i * 4, sy - 17 + j * 4, 2, 2);
    c.fillStyle = '#4a5878';
    c.fillText(text, sx + 6 + grip, sy - 9);
    return { x: sx, y: sy - 22, w, h: 18 };
  }

  private drawHandle(c: CanvasRenderingContext2D, sx: number, sy: number) {
    const s = HANDLE_PX;
    c.fillStyle = '#fff';
    c.strokeStyle = '#6f86ad';
    c.lineWidth = 1.5;
    c.beginPath();
    c.rect(sx - s / 2, sy - s / 2, s, s);
    c.fill();
    c.stroke();
  }

  /** Ramka zaznaczenia + uchwyt skalowania (w pikselach ekranu). */
  private drawSelBox(c: CanvasRenderingContext2D, b: BBox) {
    this.screenTransform(c);
    const [x0, y0] = this.toScreen(b.minX, b.minY);
    const [x1, y1] = this.toScreen(b.maxX, b.maxY);
    c.strokeStyle = '#1f5fd1';
    c.lineWidth = 1.5;
    c.setLineDash([6, 4]);
    c.strokeRect(x0 - 4, y0 - 4, x1 - x0 + 8, y1 - y0 + 8);
    c.setLineDash([]);
    this.drawHandle(c, x1, y1);
  }

  private renderBg() {
    const c = this.bctx;
    const { x, y, z } = this.cam;
    this.screenTransform(c);
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, this.w, this.h);

    // kratka (można wyłączyć) – przy dużym oddaleniu rzadsza
    if (useUI.getState().showGrid) {
      let step = GRID;
      while (step * z < 12) step *= 5;
      c.strokeStyle = '#dbe4ef';
      c.lineWidth = 1;
      c.beginPath();
      for (let wx = Math.floor(x / step) * step; (wx - x) * z <= this.w; wx += step) {
        const sx = Math.round((wx - x) * z) + 0.5;
        c.moveTo(sx, 0);
        c.lineTo(sx, this.h);
      }
      for (let wy = Math.floor(y / step) * step; (wy - y) * z <= this.h; wy += step) {
        const sy = Math.round((wy - y) * z) + 0.5;
        c.moveTo(0, sy);
        c.lineTo(this.w, sy);
      }
      c.stroke();
    }

    this.worldTransform(c);
    const view = { minX: x, minY: y - 30 / z, maxX: x + this.w / z, maxY: y + this.h / z };
    const frames = sortFrames(this.doc.filter(isFrame));
    for (const f of frames) {
      if (!this.hidden.has(f.id) && bboxOverlap(elBBox(f), view)) this.drawFrameBox(c, f);
    }
    this.drawEls(c, this.doc.filter((el) => !isFrame(el) && !this.hidden.has(el.id) && bboxOverlap(elBBox(el), view)));

    // etykiety stron w pikselach ekranu (stała wielkość niezależnie od zoomu)
    this.screenTransform(c);
    this.labels = [];
    frames.forEach((f, i) => {
      if (this.hidden.has(f.id) || !bboxOverlap(elBBox(f), view)) return;
      const r = this.drawLabel(c, frameLabel(f, i), (f.x - x) * z, (f.y - y) * z);
      this.labels.push({ id: f.id, ...r });
    });
    this.handles = [];
    for (const f of frames) {
      if (this.hidden.has(f.id) || !bboxOverlap(elBBox(f), view)) continue;
      const [hx, hy] = this.toScreen(f.x + f.w, f.y + f.h);
      this.drawHandle(c, hx, hy);
      this.handles.push({ id: f.id, x: hx - HANDLE_PX, y: hy - HANDLE_PX, w: HANDLE_PX * 2, h: HANDLE_PX * 2 });
    }

    // zaznaczenie (bez elementów, które zniknęły – np. po cofnięciu)
    if (this.sel.size) {
      const ids = new Set(this.doc.map((el) => el.id));
      this.sel = new Set([...this.sel].filter((id) => ids.has(id)));
      const b = this.selBox();
      const m = this.mode;
      if (b && m?.kind !== 'selMove' && m?.kind !== 'selScale') this.drawSelBox(c, b);
    }
    this.publishSelection();
  }

  /** Cyrkiel: nóżka w środku, ołówek na okręgu, przegub nad nimi (piksele ekranu). */
  private drawCompassFigure(c: CanvasRenderingContext2D, center: P, tip: P) {
    this.screenTransform(c);
    const [cx, cy] = this.toScreen(...center);
    const [tx, ty] = this.toScreen(...tip);
    const L = Math.hypot(tx - cx, ty - cy) || 1;
    // przegub nad środkiem odcinka, zawsze „w górę” ekranu
    let nx = -(ty - cy) / L, ny = (tx - cx) / L;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    const leg = Math.max(L * 0.62, 70);
    const h = Math.sqrt(Math.max(leg * leg - (L / 2) * (L / 2), 900));
    const hx = (cx + tx) / 2 + nx * h, hy = (cy + ty) / 2 + ny * h;
    c.lineCap = 'round';
    c.globalAlpha = 0.9;
    // ramiona
    c.strokeStyle = '#7a8499';
    c.lineWidth = 4;
    c.beginPath();
    c.moveTo(hx, hy);
    c.lineTo(cx, cy);
    c.moveTo(hx, hy);
    c.lineTo(tx, ty);
    c.stroke();
    // nóżka (igła) i ołówek
    c.fillStyle = '#3d4557';
    c.beginPath();
    c.arc(cx, cy, 3, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = useUI.getState().color;
    c.beginPath();
    c.arc(tx, ty, 4.5, 0, Math.PI * 2);
    c.fill();
    // przegub z uchwytem
    c.fillStyle = '#fff';
    c.strokeStyle = '#3d4557';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(hx, hy, 6, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.beginPath();
    c.moveTo(hx, hy - 6);
    c.lineTo(hx + nx * 16, hy + ny * 16 - 6);
    c.stroke();
    c.globalAlpha = 1;
  }

  /** Rozstaw w centymetrach zeszytowych (2 kratki = 1 cm). */
  private radiusLabel(c: CanvasRenderingContext2D, center: P, tip: P, r: number) {
    this.screenTransform(c);
    const [mx, my] = this.toScreen((center[0] + tip[0]) / 2, (center[1] + tip[1]) / 2);
    c.font = '600 12px system-ui, "Segoe UI", sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'bottom';
    c.fillStyle = '#1f5fd1';
    c.fillText(`r = ${(r / (2 * GRID)).toFixed(1).replace(/\.0$/, '')} cm`, mx, my - 6);
  }

  private renderCompass(c: CanvasRenderingContext2D) {
    const m = this.mode;
    if (m?.kind === 'compassSet') {
      // ustawianie rozstawu: przerywany promień + okrąg orientacyjny
      const r = Math.hypot(m.p[0] - m.c[0], m.p[1] - m.c[1]);
      this.worldTransform(c);
      c.setLineDash([6 / this.cam.z, 5 / this.cam.z]);
      c.strokeStyle = 'rgba(31, 95, 209, 0.55)';
      c.lineWidth = 1.2 / this.cam.z;
      c.beginPath();
      c.moveTo(...m.c);
      c.lineTo(...m.p);
      c.stroke();
      c.setLineDash([]);
      this.drawCompassFigure(c, m.c, m.p);
      if (r > 1) this.radiusLabel(c, m.c, m.p, r);
      this.cursorHint(c, 'Release to set the radius');
      return;
    }
    const k = this.compass;
    const crosshair = () => {
      if (!this.hover) return;
      this.screenTransform(c);
      const p = this.snapHit ? this.toScreen(...this.snapHit) : [this.hover.x, this.hover.y];
      c.strokeStyle = '#3d4557';
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(p[0] - 7, p[1]);
      c.lineTo(p[0] + 7, p[1]);
      c.moveTo(p[0], p[1] - 7);
      c.lineTo(p[0], p[1] + 7);
      c.stroke();
    };
    const guide = (center: P, alpha: number) => {
      // okrąg orientacyjny (kropkowany) – tu rysuje ołówek
      this.worldTransform(c);
      c.setLineDash([2 / this.cam.z, 6 / this.cam.z]);
      c.strokeStyle = `rgba(31, 95, 209, ${alpha})`;
      c.lineWidth = 1.2 / this.cam.z;
      c.beginPath();
      c.arc(center[0], center[1], k!.r, 0, Math.PI * 2);
      c.stroke();
      c.setLineDash([]);
    };
    if (!k) {
      // jeszcze nie ustawiony: tu wbijesz nóżkę
      crosshair();
      this.cursorHint(c, 'Drag from the needle point to set the radius');
      return;
    }
    if (m?.kind !== 'compassArc' && this.hover) {
      if (this.keys.ctrl) {
        // Ctrl: podgląd cyrkla przeniesionego w nowe miejsce (ten sam rozstaw)
        const nc: P = this.snapHit ?? this.toWorld(this.hover.x, this.hover.y);
        guide(k.c, 0.15);
        guide(nc, 0.45);
        this.drawCompassFigure(c, nc, [nc[0] + k.r, nc[1]]);
        this.radiusLabel(c, nc, [nc[0] + k.r, nc[1]], k.r);
        this.cursorHint(c, 'Click: move the needle here (same radius)', '#e07b00');
        return;
      }
      if (this.keys.shift) {
        // Shift: nowe wbicie i nowy rozstaw
        guide(k.c, 0.15);
        crosshair();
        this.cursorHint(c, 'Drag: new needle point + new radius', '#e07b00');
        return;
      }
    }
    guide(k.c, 0.35);

    let ang = 0;
    if (m?.kind === 'compassArc') {
      ang = m.last;
      const ui = useUI.getState();
      drawInk(c, { id: '', type: 'shape', kind: 'arc', pts: [k.c], color: ui.color, width: ui.width, arc: { r: k.r, a0: m.a0, sweep: m.sweep } });
    } else if (this.hover) {
      const [wx, wy] = this.toWorld(this.hover.x, this.hover.y);
      ang = Math.atan2(wy - k.c[1], wx - k.c[0]);
    }
    const tip: P = [k.c[0] + Math.cos(ang) * k.r, k.c[1] + Math.sin(ang) * k.r];
    this.drawCompassFigure(c, k.c, tip);
    this.radiusLabel(c, k.c, tip, k.r);
    if (m?.kind !== 'compassArc') this.cursorHint(c, 'Drag: draw arc  ·  Shift: new radius  ·  Ctrl: move needle');
  }

  /** Mała podpowiedź przy kursorze: co zrobi teraz kliknięcie / przeciągnięcie. */
  private cursorHint(c: CanvasRenderingContext2D, text: string, color = '#3d4557') {
    if (!this.hover) return;
    this.screenTransform(c);
    c.font = '500 12px system-ui, "Segoe UI", sans-serif';
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    const w = c.measureText(text).width + 14;
    let x = this.hover.x + 16, y = this.hover.y + 24;
    if (x + w > this.w - 4) x = this.hover.x - 16 - w;
    if (y + 12 > this.h - 4) y = this.hover.y - 24;
    c.globalAlpha = 0.92;
    c.fillStyle = '#fff';
    c.strokeStyle = color;
    c.lineWidth = 1;
    c.beginPath();
    c.roundRect(x, y - 11, w, 22, 6);
    c.fill();
    c.stroke();
    c.globalAlpha = 1;
    c.fillStyle = color;
    c.fillText(text, x + 7, y);
  }

  private renderFg() {
    const c = this.fctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.fg.width, this.fg.height);
    const m = this.mode;
    const ui = useUI.getState();

    if (m?.kind === 'draw') {
      this.worldTransform(c);
      drawStroke(c, m.stroke, true);
    }

    if (m?.kind === 'shape') {
      this.worldTransform(c);
      const s = m.shape;
      // kąt w pierwszym kroku to po prostu ramię
      drawInk(c, s.kind === 'angle' ? { ...s, kind: 'line' } : s);
    }

    if (ui.tool === 'compass') this.renderCompass(c);

    // kółeczko: tu przyciągnie (punkt konstrukcji)
    if ((ui.tool === 'compass' || ui.tool === 'shape') && this.snapHit && m?.kind !== 'compassArc') {
      this.screenTransform(c);
      const [hx, hy] = this.toScreen(...this.snapHit);
      c.beginPath();
      c.arc(hx, hy, 6, 0, Math.PI * 2);
      c.strokeStyle = '#e07b00';
      c.lineWidth = 2;
      c.stroke();
    }

    // kąt: drugie ramię za kursorem + podgląd miary
    if (!m && this.angleDraft && this.hover) {
      const d = this.angleDraft;
      const b = this.angleEnd(this.hover.x, this.hover.y, this.keys.alt, this.keys.shift);
      this.worldTransform(c);
      drawInk(c, { id: '', type: 'shape', kind: 'angle', pts: [d.v, d.a, b], color: d.color, width: d.width });
      // miara na dwusiecznej, za łukiem
      this.screenTransform(c);
      const [vx, vy] = this.toScreen(...d.v);
      const a1 = Math.atan2(d.a[1] - d.v[1], d.a[0] - d.v[0]);
      const d0 = Math.atan2(b[1] - d.v[1], b[0] - d.v[0]) - a1;
      const mid = a1 + Math.atan2(Math.sin(d0), Math.cos(d0)) / 2;
      const r = 40 * this.cam.z + 22;
      c.font = '600 13px system-ui, "Segoe UI", sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = '#1f5fd1';
      c.fillText(`${Math.round(angleDegrees(d.v, d.a, b))}°`, vx + Math.cos(mid) * r, vy + Math.sin(mid) * r);
    }

    if (m?.kind === 'lasso' && m.pts.length > 1) {
      this.worldTransform(c);
      c.beginPath();
      m.pts.forEach(([px, py], i) => (i ? c.lineTo(px, py) : c.moveTo(px, py)));
      c.closePath();
      c.fillStyle = 'rgba(31, 95, 209, 0.06)';
      c.fill();
      c.setLineDash([6 / this.cam.z, 4 / this.cam.z]);
      c.strokeStyle = '#1f5fd1';
      c.lineWidth = 1.2 / this.cam.z;
      c.stroke();
      c.setLineDash([]);
    }

    if (m?.kind === 'selMove' && m.moved) {
      this.worldTransform(c);
      c.translate(m.dx, m.dy);
      this.drawEls(c, m.els);
      const b = unionBox(m.els)!;
      this.drawSelBox(c, { minX: b.minX + m.dx, minY: b.minY + m.dy, maxX: b.maxX + m.dx, maxY: b.maxY + m.dy });
    }

    if (m?.kind === 'selScale') {
      const scaled = m.els.map((el) => scaleEl(el, m.box.minX, m.box.minY, m.s));
      this.worldTransform(c);
      this.drawEls(c, scaled);
      const b = m.box;
      this.drawSelBox(c, { minX: b.minX, minY: b.minY, maxX: b.minX + (b.maxX - b.minX) * m.s, maxY: b.minY + (b.maxY - b.minY) * m.s });
    }

    if (m?.kind === 'frameDrag' && m.moved) {
      this.worldTransform(c);
      c.translate(m.dx, m.dy);
      this.drawFrameBox(c, m.frame);
      this.drawEls(c, m.contents);
      this.screenTransform(c);
      const i = sortFrames(this.doc.filter(isFrame)).findIndex((f) => f.id === m.frame.id);
      const [lx, ly] = this.toScreen(m.frame.x + m.dx, m.frame.y + m.dy);
      this.drawLabel(c, frameLabel(m.frame, i), lx, ly);
    }

    if (m?.kind === 'frameResize' && m.moved) {
      const f = { ...m.frame, w: m.w, h: m.h };
      this.worldTransform(c);
      this.drawFrameBox(c, f);
      this.screenTransform(c);
      const i = sortFrames(this.doc.filter(isFrame)).findIndex((fr) => fr.id === f.id);
      this.drawLabel(c, frameLabel(f, i), ...this.toScreen(f.x, f.y));
      this.drawHandle(c, ...this.toScreen(f.x + f.w, f.y + f.h));
    }

    // podgląd nowej strony pod kursorem
    if (!m && ui.tool === 'frame' && this.hover && !this.frameAt(this.hover.x, this.hover.y)) {
      const [w, h] = A4[ui.frameOrientation];
      const [wx, wy] = this.toWorld(this.hover.x, this.hover.y);
      this.worldTransform(c);
      c.setLineDash([8 / this.cam.z, 6 / this.cam.z]);
      c.strokeStyle = '#1f5fd1';
      c.lineWidth = 1.5 / this.cam.z;
      c.strokeRect(snap(wx - w / 2), snap(wy - h / 2), w, h);
      c.setLineDash([]);
    }

    const showEraser = m?.kind === 'erase' || (!m && ui.tool === 'eraser');
    if (showEraser && this.hover) {
      this.screenTransform(c);
      c.beginPath();
      c.arc(this.hover.x, this.hover.y, ERASER_PX, 0, Math.PI * 2);
      c.fillStyle = 'rgba(120,130,150,0.12)';
      c.fill();
      c.strokeStyle = 'rgba(80,90,110,0.7)';
      c.lineWidth = 1;
      c.stroke();
    }
  }
}
