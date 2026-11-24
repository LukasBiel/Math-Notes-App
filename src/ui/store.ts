import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ShortcutMap } from '../engine/shortcuts';
import type { NoteKind } from '../data/db';
import type { El, Orientation, ShapeKind } from '../engine/types';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfPageImage } from '../pdf/importPdf';

export type Tool = 'select' | 'pen' | 'eraser' | 'hand' | 'frame' | 'shape' | 'compass';

export const COLORS = ['#1d2433', '#1f5fd1', '#d1302f', '#1f9d55', '#e07b00', '#7b3fc4'];
export const WIDTHS = [1.5, 3, 6, 12];

export interface BoardApi {
  undo(): void;
  redo(): void;
  undoSeries(): void;
  zoomBy(f: number): void;
  zoomReset(): void;
  addPage(): void;
  getElements(): El[];
  renameFrame(id: string, name: string): void;
  recolorSelection(color: string): void;
  duplicateSelection(): void;
  deleteSelection(): void;
  copySelection(): void;
  insertPdfPages(pages: PdfPageImage[]): Promise<void>;
}

/** Zaznaczenie widoczne na ekranie – do paska z akcjami (współrzędne ekranu tablicy). */
export interface SelectionUI {
  x: number;
  y: number;
  w: number;
  h: number;
  count: number;
  /** czy są kreski/figury (można zmienić kolor) */
  ink: boolean;
}

export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  /** nagłówek sekcji (nieklikalny) */
  header?: boolean;
  checked?: boolean;
  /** kolorowe kółko przed etykietą */
  swatch?: string;
}

export interface SyncUser {
  id: string;
  email: string;
  name: string | null;
}

export interface SyncStatus {
  state: 'off' | 'syncing' | 'ok' | 'offline' | 'error';
  /** czas ostatniej udanej synchronizacji */
  at?: number;
  error?: string;
}

interface UIState {
  // narzędzia
  tool: Tool;
  color: string;
  width: number;
  pressure: boolean;
  /** 0..1 – jak mocno wygładzać pismo */
  smoothing: number;
  shortcuts: Partial<ShortcutMap>;
  frameOrientation: Orientation;
  pdfGrid: boolean;
  shapeKind: ShapeKind;
  /** kratka na tablicy */
  showGrid: boolean;

  // organizacja (zapisywane)
  currentNoteId: string | null;
  lastClassId: string | null;
  lastKind: NoteKind;
  sidebarOpen: boolean;
  hintsOpen: boolean;
  /** zwinięte grupy w panelu bocznym: klucz → true */
  collapsed: Record<string, boolean>;
  user: SyncUser | null;

  // stan chwilowy
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  /** liczba elementów w otwartej notatce; -1 = jeszcze nie wczytana */
  boardCount: number;
  api: BoardApi | null;
  newNote: { open: boolean };
  exportOpen: boolean;
  /** zmiana nazwy strony – pole tekstowe nad etykietą (współrzędne ekranu tablicy) */
  frameEdit: { id: string; x: number; y: number; value: string } | null;
  menu: { x: number; y: number; items: MenuItem[] } | null;
  toast: { id: number; text: string; undo?: () => void | Promise<void> } | null;
  searchFocusTick: number;
  sync: SyncStatus;
  /** zwiększane, gdy otwarta notatka zmieniła się na innym komputerze */
  boardReload: number;
  selection: SelectionUI | null;
  /** długi PDF czeka na wybór stron */
  pdfImport: { name: string; count: number; doc: PDFDocumentProxy } | null;
}

export const useUI = create<UIState>()(
  persist(
    (): UIState => ({
      tool: 'pen',
      color: COLORS[0],
      width: WIDTHS[1],
      pressure: false,
      smoothing: 0.5,
      shortcuts: {},
      frameOrientation: 'portrait',
      pdfGrid: true,
      shapeKind: 'line',
      showGrid: true,

      currentNoteId: null,
      lastClassId: null,
      lastKind: 'lesson',
      sidebarOpen: true,
      hintsOpen: true,
      collapsed: {},
      user: null,

      zoom: 1,
      canUndo: false,
      canRedo: false,
      boardCount: -1,
      api: null,
      newNote: { open: false },
      exportOpen: false,
      frameEdit: null,
      menu: null,
      toast: null,
      searchFocusTick: 0,
      sync: { state: 'off' },
      boardReload: 0,
      selection: null,
      pdfImport: null,
    }),
    {
      name: 'notatnik:v0:ui',
      partialize: (s) => ({
        tool: s.tool,
        color: s.color,
        width: s.width,
        pressure: s.pressure,
        smoothing: s.smoothing,
        shortcuts: s.shortcuts,
        frameOrientation: s.frameOrientation,
        pdfGrid: s.pdfGrid,
        shapeKind: s.shapeKind,
        showGrid: s.showGrid,
        currentNoteId: s.currentNoteId,
        lastClassId: s.lastClassId,
        lastKind: s.lastKind,
        sidebarOpen: s.sidebarOpen,
        hintsOpen: s.hintsOpen,
        collapsed: s.collapsed,
        user: s.user,
      }),
    },
  ),
);

export function toggleCollapsed(key: string) {
  const c = useUI.getState().collapsed;
  useUI.setState({ collapsed: { ...c, [key]: !c[key] } });
}

export function openMenu(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  useUI.setState({ menu: { x: e.clientX, y: e.clientY, items } });
}
