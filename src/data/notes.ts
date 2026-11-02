import type { Camera, El } from '../engine/types';
import { useUI } from '../ui/store';
import { db, tomb, type ClassGroup, type NoteKind, type NoteMeta } from './db';

export const KINDS: { id: NoteKind; label: string; icon: string }[] = [
  { id: 'lesson', label: 'Lesson', icon: '📘' },
  { id: 'review', label: 'Review', icon: '🔁' },
  { id: 'testReview', label: 'Test review', icon: '📝' },
  { id: 'exercises', label: 'Exercises', icon: '✏️' },
  { id: 'quiz', label: 'Quiz', icon: '⚡' },
  { id: 'homework', label: 'Homework', icon: '🏠' },
  { id: 'notes', label: 'Notes', icon: '🗒️' },
];

export const kindInfo = (k: NoteKind) => KINDS.find((x) => x.id === k) ?? KINDS[0];

/** Podpowiedzi tematów (oprócz tych już użytych). */
export const MATH_TOPICS = [
  'Natural numbers', 'Integers', 'Fractions', 'Decimals', 'Percentages', 'Powers and roots',
  'Algebraic expressions', 'Equations', 'Inequalities', 'Systems of equations', 'Proportions',
  'Functions', 'Linear functions', 'Quadratic functions', 'Polynomials', 'Rational functions',
  'Exponential functions', 'Logarithms', 'Sequences', 'Trigonometry',
  'Angles', 'Triangles', 'Pythagorean theorem', 'Quadrilaterals', 'Polygons', 'Circles',
  'Area and perimeter', 'Coordinate geometry', 'Solid geometry', 'Vectors',
  'Probability', 'Statistics', 'Combinatorics', 'Derivatives', 'Exam prep',
];

const CLASS_COLORS = ['#4f7cff', '#ff8a3d', '#2bb673', '#e5484d', '#8e6cf0', '#00a3bf', '#d4a017', '#e86fb0'];

const TRASH_DAYS = 30;

export const shortDate = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function relDate(t: number) {
  const d = new Date(t);
  const today = new Date();
  const yest = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === yest.toDateString()) return 'yesterday';
  return shortDate(t);
}

export function makeTitle(kind: NoteKind, topic: string, createdAt: number) {
  const t = topic.trim();
  return `${kindInfo(kind).label}${t ? ' – ' + t : ''} · ${shortDate(createdAt)}`;
}

const uid = () => crypto.randomUUID();

export function sortClasses(cs: ClassGroup[]) {
  return [...cs].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

// ---------- notatki ----------

export interface NewNoteOpts {
  classId?: string | null;
  kind?: NoteKind;
  topic?: string;
  title?: string;
}

export async function createNote(opts: NewNoteOpts = {}) {
  const ui = useUI.getState();
  const now = Date.now();
  const classId = opts.classId !== undefined ? opts.classId : ui.lastClassId;
  const kind = opts.kind ?? ui.lastKind;
  const topic = (opts.topic ?? '').trim();
  const title = opts.title?.trim();
  const note: NoteMeta = {
    id: uid(),
    title: title || makeTitle(kind, topic, now),
    autoTitle: !title,
    classId: classId && (await db.classes.get(classId)) ? classId : null,
    topic,
    kind,
    createdAt: now,
    updatedAt: now,
    openedAt: now,
    deletedAt: null,
    count: 0,
  };
  await db.transaction('rw', db.notes, db.docs, async () => {
    await db.notes.add(note);
    await db.docs.add({ noteId: note.id, elements: [] });
  });
  useUI.setState({ lastClassId: note.classId, lastKind: kind });
  await openNote(note.id);
  return note;
}

export async function openNote(id: string) {
  const ui = useUI.getState();
  const prev = ui.currentNoteId;
  if (prev === id) return;
  // pusta notatka z automatyczną nazwą znika sama – nie zaśmieca listy
  if (prev && ui.boardCount === 0) {
    const p = await db.notes.get(prev);
    if (p && p.autoTitle && !p.deletedAt) await purgeNote(prev);
  }
  await db.notes.update(id, { openedAt: Date.now() });
  useUI.setState({ currentNoteId: id, boardCount: -1 });
}

export async function updateNote(id: string, patch: Partial<Pick<NoteMeta, 'classId' | 'topic' | 'kind'>>) {
  const n = await db.notes.get(id);
  if (!n) return;
  const next = { ...n, ...patch };
  if (patch.topic !== undefined) next.topic = patch.topic.trim();
  if (next.autoTitle) next.title = makeTitle(next.kind, next.topic, next.createdAt);
  await db.notes.put(next);
  if (patch.classId !== undefined) useUI.setState({ lastClassId: patch.classId });
  if (patch.kind) useUI.setState({ lastKind: patch.kind });
}

export async function renameNote(id: string, title: string) {
  const n = await db.notes.get(id);
  if (!n) return;
  const t = title.trim();
  await db.notes.update(id, t ? { title: t, autoTitle: false } : { autoTitle: true, title: makeTitle(n.kind, n.topic, n.createdAt) });
}

export async function saveNoteContent(id: string, elements: El[], cam: Camera, contentChanged: boolean) {
  await db.transaction('rw', db.notes, db.docs, async () => {
    if (!(await db.notes.get(id))) return;
    if (contentChanged) {
      await db.docs.put({ noteId: id, elements });
      await db.notes.update(id, { cam, updatedAt: Date.now(), count: elements.length });
    } else {
      await db.notes.update(id, { cam });
    }
  });
}

export async function duplicateNote(id: string) {
  const [n, d] = await Promise.all([db.notes.get(id), db.docs.get(id)]);
  if (!n) return;
  const now = Date.now();
  const copy: NoteMeta = {
    ...n,
    id: uid(),
    title: n.autoTitle ? makeTitle(n.kind, n.topic, now) : n.title + ' (copy)',
    createdAt: now,
    updatedAt: now,
    openedAt: now,
    deletedAt: null,
  };
  await db.transaction('rw', db.notes, db.docs, async () => {
    await db.notes.add(copy);
    await db.docs.add({ noteId: copy.id, elements: structuredClone(d?.elements ?? []) });
  });
  await openNote(copy.id);
}

export async function trashNote(id: string) {
  await db.notes.update(id, { deletedAt: Date.now() });
  if (useUI.getState().currentNoteId === id) await openFallback(id);
  showToast('Note moved to trash', async () => {
    await db.notes.update(id, { deletedAt: null });
    await openNote(id);
  });
}

export async function restoreNote(id: string) {
  await db.notes.update(id, { deletedAt: null });
}

export async function purgeNote(id: string) {
  await db.transaction('rw', db.notes, db.docs, db.tombstones, async () => {
    await db.notes.delete(id);
    await db.docs.delete(id);
    await tomb('notes', id);
    await tomb('docs', id);
  });
}

export async function emptyTrash() {
  const trashed = (await db.notes.toArray()).filter((n) => n.deletedAt);
  for (const n of trashed) await purgeNote(n.id);
}

/** Otwiera ostatnią inną notatkę albo tworzy nową. */
export async function openFallback(exceptId: string) {
  const rest = (await db.notes.toArray()).filter((n) => !n.deletedAt && n.id !== exceptId);
  rest.sort((a, b) => b.openedAt - a.openedAt);
  useUI.setState({ boardCount: -1 }); // nie kasuj właśnie usuniętej notatki
  if (rest[0]) await openNote(rest[0].id);
  else await createNote({ classId: null });
}

// ---------- klasy ----------

export async function addClasses(input: string) {
  const names = input.split(',').map((s) => s.trim()).filter(Boolean);
  const existing = await db.classes.toArray();
  let last: ClassGroup | null = null;
  for (const name of names) {
    if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) continue;
    const used = new Set(existing.map((c) => c.color));
    const color = CLASS_COLORS.find((c) => !used.has(c)) ?? CLASS_COLORS[existing.length % CLASS_COLORS.length];
    last = { id: uid(), name, color, createdAt: Date.now() };
    existing.push(last);
    await db.classes.add(last);
  }
  return last;
}

export async function renameClass(id: string, name: string) {
  if (name.trim()) await db.classes.update(id, { name: name.trim() });
}

export async function setClassColor(id: string, color: string) {
  await db.classes.update(id, { color });
}

export async function deleteClass(id: string) {
  const cls = await db.classes.get(id);
  if (!cls) return;
  const notes = await db.notes.where('classId').equals(id).toArray();
  await db.transaction('rw', db.classes, db.notes, db.tombstones, async () => {
    await db.classes.delete(id);
    await tomb('classes', id);
    for (const n of notes) await db.notes.update(n.id, { classId: null });
  });
  if (useUI.getState().lastClassId === id) useUI.setState({ lastClassId: null });
  showToast(`Class “${cls.name}” deleted – notes moved to Unsorted`, async () => {
    await db.transaction('rw', db.classes, db.notes, async () => {
      await db.classes.add(cls);
      for (const n of notes) await db.notes.update(n.id, { classId: id });
    });
  });
}

export { CLASS_COLORS };

// ---------- start aplikacji ----------

export async function bootstrap() {
  // przeniesienie notatki z etapu 1 (localStorage)
  const old = localStorage.getItem('notatnik:v0:doc');
  if (old) {
    try {
      const data = JSON.parse(old);
      if (Array.isArray(data.doc) && data.doc.length) {
        const now = Date.now();
        const id = uid();
        await db.transaction('rw', db.notes, db.docs, async () => {
          await db.notes.add({
            id, title: 'First note', autoTitle: false, classId: null, topic: '', kind: 'notes',
            createdAt: now, updatedAt: now, openedAt: now, deletedAt: null, count: data.doc.length, cam: data.cam,
          });
          await db.docs.add({ noteId: id, elements: data.doc });
        });
        useUI.setState({ currentNoteId: id });
      }
    } catch {
      /* ignorujemy uszkodzony stary zapis */
    }
    localStorage.removeItem('notatnik:v0:doc');
  }

  const all = await db.notes.toArray();
  const limit = Date.now() - TRASH_DAYS * 864e5;
  for (const n of all) if (n.deletedAt && n.deletedAt < limit) await purgeNote(n.id);

  const cur = useUI.getState().currentNoteId;
  const curNote = cur ? await db.notes.get(cur) : undefined;
  if (curNote && !curNote.deletedAt) {
    useUI.setState({ boardCount: -1 });
    return;
  }
  useUI.setState({ currentNoteId: null });
  await openFallback('');
}

// ---------- toast ----------

let toastTimer = 0;
export function showToast(text: string, undo?: () => void | Promise<void>) {
  clearTimeout(toastTimer);
  useUI.setState({ toast: { text, undo, id: Date.now() } });
  toastTimer = window.setTimeout(() => useUI.setState({ toast: null }), 6000);
}
