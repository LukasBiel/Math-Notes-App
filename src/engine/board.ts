import type { Camera, El, Frame, ImageEl, Point, Stroke } from './types';
import { A4 } from './types';
import { bboxOverlap, elBBox, hitStroke, insideRect, snapAngle, strokeBBox } from './geometry';
import { History, type Op } from './history';
import { isTyping, matchShortcut, type Action } from './shortcuts';
import { drawStroke, frameLabel, frameScale, GRID, isFrame, isImage, isStroke, sortFrames } from './render';
import { prepareImage } from './images';
import { useUI, WIDTHS, type BoardApi } from '../ui/store';
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

/** przerwa (ms), po której kolejne kreski nie należą już do tej samej „serii” */
const SERIES_GAP = 1000;
/** promień gumki w pikselach ekranu */
const ERASER_PX = 14;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;
/** odstęp między stronami dodawanymi przyciskiem „+ Page” */
const PAGE_GAP = 80;
/** zakres skali strony względem A4 */
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
/** uchwyt zmiany rozmiaru w rogu strony (piksele ekranu) */
const HANDLE_PX = 10;

type Mode =
  | { kind: 'draw'; stroke: Stroke; t0: number; pointerId: number }
  | { kind: 'erase'; items: { el: El; index: number }[]; last: [number, number]; t0: number; pointerId: number }
  | { kind: 'pan'; sx: number; sy: number; cx: number; cy: number; pointerId: number }
  | { kind: 'frameResize'; frame: Frame; sx: number; w: number; h: number; moved: boolean; pointerId: number }
  | { kind: 'imgMove'; el: ImageEl; sx: number; sy: number; dx: number; dy: number; moved: boolean; pointerId: number }
  | { kind: 'imgResize'; el: ImageEl; sx: number; w: number; h: number; pointerId: number }
  | {
      kind: 'frameDrag';
      frame: Frame;
      /** z Shiftem: kreski i obrazki, których środek leży w ramce – jadą razem z nią */
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
  if (e.type !== 'stroke') return { ...e, x: e.x + dx, y: e.y + dy };
  return { ...e, points: e.points.map(([x, y, p]): Point => [r2(x + dx), r2(y + dy), p]) };
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
  private keys = { space: false, shift: false };
  private hover: { x: number; y: number } | null = null;
  /** etykiety ramek na ekranie – do klikania i przeciągania */
  private labels: LabelRect[] = [];
  /** uchwyty w prawym dolnym rogu stron */
  private handles: LabelRect[] = [];
  /** elementy chwilowo rysowane na wierzchu (przeciągane) */
  private hidden = new Set<string>();
  /** zaznaczony obrazek (przesuwanie, zmiana rozmiaru, Delete) */
  private selected: string | null = null;
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
      this.keys.space = this.keys.shift = false;
      this.updateCursor();
    });
    this.listen(window, 'pagehide', () => this.flushSave());
    this.listen(window, 'paste', this.onPaste);
    this.listen(this.fg, 'dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    this.listen(this.fg, 'drop', this.onDrop);

    const unsub = useUI.subscribe((s, prev) => {
      if (s.tool !== prev.tool || s.frameOrientation !== prev.frameOrientation) {
        this.updateCursor();
        this.requestFg();
      }
    });
    this.disposers.push(unsub);

    useUI.setState({ api: this });
    this.updateCursor();
    this.syncUI();
  }

  destroy() {
    this.flushSave();
    this.disposers.forEach((d) => d());
    cancelAnimationFrame(this.raf);
    this.bg.remove();
    this.fg.remove();
    if (useUI.getState().api === this) useUI.setState({ api: null });
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
    if (last) {
      x = last.x;
      y = last.y + last.h + PAGE_GAP;
    } else {
      const strokes = this.doc.filter(isStroke);
      if (strokes.length) {
        x = Math.min(...strokes.map((s) => strokeBBox(s).minX)) - 2 * GRID;
        y = Math.min(...strokes.map((s) => strokeBBox(s).minY)) - 2 * GRID;
      } else {
        x = this.cam.x + this.w / this.cam.z / 2 - w / 2;
        y = this.cam.y + 60 / this.cam.z;
      }
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

  deleteFrame(id: string) {
    const index = this.doc.findIndex((e) => e.id === id);
    if (index < 0) return;
    const el = this.doc[index];
    this.doc.splice(index, 1);
    const now = performance.now();
    this.pushOp({ kind: 'remove', items: [{ el, index }], t0: now, t1: now });
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

  private updateFrame(id: string, fn: (f: Frame) => Frame) {
    const before = this.doc.find((e): e is Frame => e.id === id && isFrame(e));
    if (!before) return;
    const after = fn(before);
    this.replace(before, after);
    const now = performance.now();
    this.pushOp({ kind: 'update', items: [{ before, after }], t0: now, t1: now });
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
    return Date.now().toString(36) + (this.idCounter++).toString(36);
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

  // ---------- obrazki ----------

  private selectedImage() {
    return this.selected ? this.doc.find((e): e is ImageEl => e.id === this.selected && isImage(e)) : undefined;
  }

  private select(id: string | null) {
    if (this.selected === id) return;
    this.selected = id;
    this.requestBg();
  }

  private inEl(el: ImageEl, sx: number, sy: number) {
    const [wx, wy] = this.toWorld(sx, sy);
    return insideRect(wx, wy, elBBox(el));
  }

  private imageAt(sx: number, sy: number) {
    for (let i = this.doc.length - 1; i >= 0; i--) {
      const el = this.doc[i];
      if (isImage(el) && this.inEl(el, sx, sy)) return el;
    }
    return undefined;
  }

  private onImageHandle(el: ImageEl, sx: number, sy: number) {
    const hx = (el.x + el.w - this.cam.x) * this.cam.z;
    const hy = (el.y + el.h - this.cam.y) * this.cam.z;
    return Math.abs(sx - hx) <= HANDLE_PX && Math.abs(sy - hy) <= HANDLE_PX;
  }

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

  private drawImageEl(c: CanvasRenderingContext2D, el: ImageEl, w = el.w, h = el.h) {
    const img = this.getImg(el.imageId);
    if (img) {
      c.drawImage(img, el.x, el.y, w, h);
    } else {
      c.fillStyle = '#eef1f6';
      c.fillRect(el.x, el.y, w, h);
    }
  }

  private drawSelection(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
    const z = this.cam.z;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.strokeStyle = '#1f5fd1';
    c.lineWidth = 1.5;
    c.strokeRect((x - this.cam.x) * z, (y - this.cam.y) * z, w * z, h * z);
    this.drawHandle(c, (x + w - this.cam.x) * z, (y + h - this.cam.y) * z);
  }

  private onPaste = (e: ClipboardEvent) => {
    const ui = useUI.getState();
    if (isTyping(e.target) || ui.newNote.open || ui.exportOpen) return;
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (!file) return;
    e.preventDefault();
    void this.insertImage(file, this.w / 2, this.h / 2);
  };

  private onDrop = (e: DragEvent) => {
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
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
    this.select(el.id);
  }

  private deleteSelected() {
    const index = this.doc.findIndex((e) => e.id === this.selected);
    this.selected = null;
    if (index < 0) return;
    const el = this.doc[index];
    this.doc.splice(index, 1);
    const now = performance.now();
    this.pushOp({ kind: 'remove', items: [{ el, index }], t0: now, t1: now });
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

  resetFrameSize(id: string) {
    this.updateFrame(id, (f) => {
      const [w, h] = A4[f.w > f.h ? 'landscape' : 'portrait'];
      return { ...f, w, h };
    });
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

    // zaznaczony obrazek: róg = rozmiar, środek = przesuwanie, klik obok = odznacz
    if (e.button === 0) {
      const sel = this.selectedImage();
      if (sel && this.onImageHandle(sel, sx, sy)) {
        this.fg.setPointerCapture(id);
        this.mode = { kind: 'imgResize', el: sel, sx, w: sel.w, h: sel.h, pointerId: id };
        this.updateCursor();
        return;
      }
      const hit = sel && this.inEl(sel, sx, sy) ? sel : ui.tool === 'select' ? this.imageAt(sx, sy) : undefined;
      if (hit) {
        this.select(hit.id);
        this.fg.setPointerCapture(id);
        this.mode = { kind: 'imgMove', el: hit, sx, sy, dx: 0, dy: 0, moved: false, pointerId: id };
        this.updateCursor();
        return;
      }
      if (sel) {
        // klik obok tylko odznacza – nie zostawia kropki
        this.select(null);
        return;
      }
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

    // etykieta strony: przeciągnij = przesuń stronę z zawartością, kliknij = menu
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
    const m = this.mode;

    if (!m || m.pointerId !== e.pointerId) {
      const tool = useUI.getState().tool;
      if (tool === 'eraser' || tool === 'frame') this.requestFg();
      this.updateCursor();
      return;
    }

    if (m.kind === 'pan') {
      this.cam = { ...this.cam, x: m.cx - (sx - m.sx) / this.cam.z, y: m.cy - (sy - m.sy) / this.cam.z };
      this.requestBg();
      return;
    }

    if (m.kind === 'imgMove') {
      if (!m.moved && Math.hypot(sx - m.sx, sy - m.sy) < 3) return;
      if (!m.moved) {
        m.moved = true;
        this.hidden = new Set([m.el.id]);
        this.requestBg();
      }
      m.dx = (sx - m.sx) / this.cam.z;
      m.dy = (sy - m.sy) / this.cam.z;
      this.requestFg();
      return;
    }

    if (m.kind === 'imgResize') {
      if (!this.hidden.has(m.el.id)) {
        this.hidden = new Set([m.el.id]);
        this.requestBg();
      }
      m.w = Math.max(20, m.el.w + (sx - m.sx) / this.cam.z);
      m.h = (m.w * m.el.h) / m.el.w;
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
    } else if (m.kind === 'imgMove' || m.kind === 'imgResize') {
      this.hidden = new Set();
      const after: ImageEl =
        m.kind === 'imgMove'
          ? { ...m.el, x: r2(m.el.x + m.dx), y: r2(m.el.y + m.dy) }
          : { ...m.el, w: r2(m.w), h: r2(m.h) };
      if (after.x !== m.el.x || after.y !== m.el.y || after.w !== m.el.w) {
        this.replace(m.el, after);
        this.pushOp({ kind: 'update', items: [{ before: m.el, after }], t0: t1, t1 });
      } else {
        this.requestBg();
      }
    } else if (m.kind === 'frameResize') {
      this.hidden = new Set();
      if (m.w !== m.frame.w) {
        const after = { ...m.frame, w: m.w, h: m.h };
        this.replace(m.frame, after);
        this.pushOp({ kind: 'update', items: [{ before: m.frame, after }], t0: t1, t1 });
      } else {
        this.requestBg();
      }
    } else if (m.kind === 'frameDrag') {
      this.hidden = new Set();
      if (!m.moved) {
        this.frameMenu(m.frame, e.clientX, e.clientY);
      } else if (m.dx || m.dy) {
        const items = [m.frame, ...m.contents].map((before) => ({ before, after: moveEl(before, m.dx, m.dy) }));
        for (const { before, after } of items) this.replace(before, after);
        this.pushOp({ kind: 'update', items, t0: t1, t1 });
      } else {
        this.requestBg();
      }
    } else {
      this.camChanged();
    }
    this.updateCursor();
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
      if (isStroke(el) && hitStroke(el, a[0], a[1], b[0], b[1], r)) {
        this.doc.splice(i, 1);
        m.items.push({ el, index: i });
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
      this.camChanged();
      return;
    }
    const k = e.deltaMode === 1 ? 0.05 : 0.0015;
    this.zoomAt(sx, sy, Math.exp(-e.deltaY * k));
  };

  private onKeyDown = (e: KeyboardEvent) => {
    const ui = useUI.getState();
    if (isTyping(e.target) || ui.newNote.open || ui.exportOpen) return;
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
        this.requestFg();
      }
      return;
    }
    if (this.selected && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      this.deleteSelected();
      return;
    }
    if (e.key === 'Escape' && this.selected) {
      this.select(null);
      return;
    }
    if (e.key === 'Escape' && ui.tool === 'frame') {
      useUI.setState({ tool: 'pen' });
      return;
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
    if (e.key === 'Shift') this.keys.shift = false;
  };

  private run(action: Action) {
    const set = useUI.setState;
    switch (action) {
      case 'select':
      case 'pen':
      case 'eraser':
      case 'hand':
      case 'frame':
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
      default: runAppAction(action);
    }
  }

  private updateCursor() {
    const tool = useUI.getState().tool;
    const m = this.mode;
    let c = 'crosshair';
    const sel = this.selectedImage();
    if (m?.kind === 'pan') c = 'grabbing';
    else if (m?.kind === 'imgMove') c = 'move';
    else if (m?.kind === 'imgResize') c = 'nwse-resize';
    else if (!m && sel && this.hover && this.onImageHandle(sel, this.hover.x, this.hover.y)) c = 'nwse-resize';
    else if (!m && this.hover && ((sel && this.inEl(sel, this.hover.x, this.hover.y)) || (tool === 'select' && this.imageAt(this.hover.x, this.hover.y)))) c = 'move';
    else if (m?.kind === 'frameResize') c = 'nwse-resize';
    else if (!m && this.hover && this.handleAt(this.hover.x, this.hover.y)) c = 'nwse-resize';
    else if (m?.kind === 'frameDrag') c = m.moved ? 'grabbing' : 'pointer';
    else if (this.keys.space || tool === 'hand') c = 'grab';
    else if (!m && this.hover && this.labelAt(this.hover.x, this.hover.y)) c = 'move';
    else if (m?.kind === 'erase' || tool === 'eraser') c = 'none';
    else if (tool === 'frame') c = this.hover && this.frameAt(this.hover.x, this.hover.y) ? 'move' : 'copy';
    else if (tool === 'select') c = 'default';
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

  private renderBg() {
    const c = this.bctx;
    const { x, y, z } = this.cam;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, this.w, this.h);

    // kratka – przy dużym oddaleniu rzadsza
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

    this.worldTransform(c);
    const view = { minX: x, minY: y - 30 / z, maxX: x + this.w / z, maxY: y + this.h / z };
    const frames = sortFrames(this.doc.filter(isFrame));
    for (const f of frames) {
      if (!this.hidden.has(f.id) && bboxOverlap(elBBox(f), view)) this.drawFrameBox(c, f);
    }
    // obrazki pod pismem – żeby dało się po nich pisać
    for (const el of this.doc) {
      if (isImage(el) && !this.hidden.has(el.id) && bboxOverlap(elBBox(el), view)) this.drawImageEl(c, el);
    }
    for (const el of this.doc) {
      if (isStroke(el) && !this.hidden.has(el.id) && bboxOverlap(strokeBBox(el), view)) drawStroke(c, el);
    }

    // etykiety stron w pikselach ekranu (stała wielkość niezależnie od zoomu)
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.labels = [];
    frames.forEach((f, i) => {
      if (this.hidden.has(f.id) || !bboxOverlap(elBBox(f), view)) return;
      const r = this.drawLabel(c, frameLabel(f, i), (f.x - x) * z, (f.y - y) * z);
      this.labels.push({ id: f.id, ...r });
    });
    const sel = this.selectedImage();
    if (!sel) this.selected = null;
    else if (!this.hidden.has(sel.id)) this.drawSelection(c, sel.x, sel.y, sel.w, sel.h);

    this.handles = [];
    for (const f of frames) {
      if (this.hidden.has(f.id) || !bboxOverlap(elBBox(f), view)) continue;
      const hx = (f.x + f.w - x) * z;
      const hy = (f.y + f.h - y) * z;
      this.drawHandle(c, hx, hy);
      this.handles.push({ id: f.id, x: hx - HANDLE_PX, y: hy - HANDLE_PX, w: HANDLE_PX * 2, h: HANDLE_PX * 2 });
    }
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

    if (m?.kind === 'frameDrag' && m.moved) {
      this.worldTransform(c);
      c.translate(m.dx, m.dy);
      this.drawFrameBox(c, m.frame);
      for (const el of m.contents) {
        if (isImage(el)) this.drawImageEl(c, el);
      }
      for (const el of m.contents) {
        if (isStroke(el)) drawStroke(c, el);
      }
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const i = sortFrames(this.doc.filter(isFrame)).findIndex((f) => f.id === m.frame.id);
      this.drawLabel(c, frameLabel(m.frame, i), (m.frame.x + m.dx - this.cam.x) * this.cam.z, (m.frame.y + m.dy - this.cam.y) * this.cam.z);
    }

    if (m?.kind === 'imgMove' && m.moved) {
      this.worldTransform(c);
      c.translate(m.dx, m.dy);
      this.drawImageEl(c, m.el);
      this.drawSelection(c, m.el.x + m.dx, m.el.y + m.dy, m.el.w, m.el.h);
    }
    if (m?.kind === 'imgResize') {
      this.worldTransform(c);
      this.drawImageEl(c, m.el, m.w, m.h);
      this.drawSelection(c, m.el.x, m.el.y, m.w, m.h);
    }

    if (m?.kind === 'frameResize' && m.moved) {
      const f = { ...m.frame, w: m.w, h: m.h };
      this.worldTransform(c);
      this.drawFrameBox(c, f);
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const i = sortFrames(this.doc.filter(isFrame)).findIndex((fr) => fr.id === f.id);
      const z = this.cam.z;
      this.drawLabel(c, frameLabel(f, i), (f.x - this.cam.x) * z, (f.y - this.cam.y) * z);
      this.drawHandle(c, (f.x + f.w - this.cam.x) * z, (f.y + f.h - this.cam.y) * z);
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
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
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
