import type { El } from './types';

export type Op =
  | { kind: 'add'; els: El[]; t0: number; t1: number }
  /** items w kolejności usuwania; index = pozycja w dokumencie w chwili usunięcia */
  | { kind: 'remove'; items: { el: El; index: number }[]; t0: number; t1: number }
  /** podmiana elementów (to samo id) – przesunięcie, zmiana nazwy, obrót strony */
  | { kind: 'update'; items: { before: El; after: El }[]; t0: number; t1: number };

const LIMIT = 1000;

export class History {
  undoStack: Op[] = [];
  redoStack: Op[] = [];

  push(op: Op) {
    this.undoStack.push(op);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Ile operacji z wierzchu stosu tworzy „serię” – kreski pisane bez przerwy dłuższej niż gap ms. */
  seriesLength(gap: number) {
    const s = this.undoStack;
    if (!s.length) return 0;
    if (s[s.length - 1].kind !== 'add') return 1;
    let n = 1;
    for (let i = s.length - 2; i >= 0; i--) {
      if (s[i].kind !== 'add' || s[i + 1].t0 - s[i].t1 > gap) break;
      n++;
    }
    return n;
  }
}
