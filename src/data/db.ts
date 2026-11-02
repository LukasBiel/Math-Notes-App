import Dexie, { type Table } from 'dexie';
import type { Camera, El } from '../engine/types';

export type NoteKind = 'lesson' | 'review' | 'testReview' | 'exercises' | 'quiz' | 'homework' | 'notes';

/** Pola synchronizacji – ustawiane automatycznie przez hooki w sync.ts. */
export interface SyncFields {
  /** 1 = zmiana jeszcze nie wysłana na serwer */
  _dirty?: number;
  /** czas ostatniej zmiany (wygrywa nowszy) */
  _ts?: number;
}

export interface ClassGroup extends SyncFields {
  id: string;
  name: string;
  color: string;
  createdAt: number;
}

export interface NoteMeta extends SyncFields {
  id: string;
  title: string;
  /** true = nazwa generowana automatycznie (typ – temat · data), aktualizuje się przy zmianie typu/tematu */
  autoTitle: boolean;
  classId: string | null;
  topic: string;
  kind: NoteKind;
  createdAt: number;
  updatedAt: number;
  openedAt: number;
  deletedAt: number | null;
  count: number;
  /** utworzona przez aplikację (np. przy pierwszym starcie), nie przez użytkownika – pusta znika sama */
  scratch?: boolean;
  cam?: Camera;
}

export interface NoteDoc extends SyncFields {
  noteId: string;
  elements: El[];
}

export interface ImageRec extends SyncFields {
  id: string;
  dataUrl: string;
}

export type SyncTable = 'classes' | 'notes' | 'docs' | 'images';

/** Ślad po trwałym usunięciu – żeby usunięcie dotarło na serwer. */
export interface Tombstone {
  key: string;
  tbl: SyncTable;
  id: string;
  ts: number;
}

class NotebookDB extends Dexie {
  classes!: Table<ClassGroup, string>;
  notes!: Table<NoteMeta, string>;
  docs!: Table<NoteDoc, string>;
  tombstones!: Table<Tombstone, string>;
  images!: Table<ImageRec, string>;
  kv!: Table<{ key: string; value: unknown }, string>;

  constructor() {
    super('notatnik');
    this.version(1).stores({
      classes: 'id',
      notes: 'id, classId, updatedAt',
      docs: 'noteId',
    });
    this.version(2).stores({
      classes: 'id, _dirty',
      notes: 'id, classId, updatedAt, _dirty',
      docs: 'noteId, _dirty',
      tombstones: 'key',
      kv: 'key',
    });
    this.version(3).stores({ images: 'id, _dirty' });
  }
}

export const db = new NotebookDB();

export async function tomb(tbl: SyncTable, id: string) {
  await db.tombstones.put({ key: `${tbl}:${id}`, tbl, id, ts: Date.now() });
}
