export type Action =
  | 'select' | 'pen' | 'eraser' | 'hand'
  | 'undo' | 'redo' | 'undoSeries'
  | 'width1' | 'width2' | 'width3' | 'width4'
  | 'zoomIn' | 'zoomOut' | 'zoomReset'
  | 'togglePressure'
  | 'newNote' | 'search' | 'toggleSidebar'
  | 'frame' | 'addPage' | 'exportPdf';

export type ShortcutMap = Record<Action, string[]>;

export const ACTION_LABELS: Record<Action, string> = {
  select: 'Select / move images',
  pen: 'Pen',
  eraser: 'Eraser',
  hand: 'Hand (pan)',
  undo: 'Undo',
  redo: 'Redo',
  undoSeries: 'Undo last burst (word / formula)',
  width1: 'Width 1',
  width2: 'Width 2',
  width3: 'Width 3',
  width4: 'Width 4',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  zoomReset: 'Zoom 100%',
  togglePressure: 'Pen pressure on/off',
  newNote: 'New note',
  search: 'Find note',
  toggleSidebar: 'Show/hide sidebar',
  frame: 'Page frame (A4)',
  addPage: 'Add next page',
  exportPdf: 'Export PDF',
};

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  select: ['v'],
  pen: ['p'],
  eraser: ['e'],
  hand: ['h'],
  undo: ['ctrl+z'],
  redo: ['ctrl+y', 'ctrl+shift+z'],
  undoSeries: ['alt+z'],
  width1: ['1'],
  width2: ['2'],
  width3: ['3'],
  width4: ['4'],
  zoomIn: ['ctrl+=', '='],
  zoomOut: ['ctrl+-', '-'],
  zoomReset: ['ctrl+0', '0'],
  togglePressure: [],
  newNote: ['alt+n'],
  search: ['ctrl+k'],
  toggleSidebar: ['tab', 'ctrl+b'],
  frame: ['f'],
  addPage: ['shift+f'],
  exportPdf: ['ctrl+p'],
};

function keyName(e: KeyboardEvent) {
  const c = e.code;
  if (c.startsWith('Key')) return c.slice(3).toLowerCase();
  if (c.startsWith('Digit')) return c.slice(5);
  if (/^Numpad\d$/.test(c)) return c.slice(6);
  if (c === 'Equal' || c === 'NumpadAdd') return '=';
  if (c === 'Minus' || c === 'NumpadSubtract') return '-';
  return e.key.toLowerCase();
}

/** Zamienia zdarzenie na tekst typu „ctrl+shift+z”. */
export function comboFromEvent(e: KeyboardEvent) {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(keyName(e));
  return parts.join('+');
}

export function matchShortcut(e: KeyboardEvent, custom: Partial<ShortcutMap>): Action | null {
  const combo = comboFromEvent(e);
  const map = { ...DEFAULT_SHORTCUTS, ...custom };
  for (const action of Object.keys(map) as Action[]) {
    if (map[action].includes(combo)) return action;
  }
  return null;
}

/** Pole tekstowe ma fokus – skróty jednoklawiszowe nie mogą wtedy działać. */
export function isTyping(target: EventTarget | null) {
  const t = target as HTMLElement | null;
  if (!t) return false;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return true;
  return t.tagName === 'INPUT' && !['range', 'checkbox', 'button', 'radio'].includes((t as HTMLInputElement).type);
}
