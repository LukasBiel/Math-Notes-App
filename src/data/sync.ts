/**
 * Synchronizacja local-first: wszystko zapisuje się najpierw w IndexedDB, a w tle
 * wymienia z serwerem (POST /api/sync). Przy konflikcie wygrywa nowsza zmiana (_ts).
 */
import { db, type SyncTable } from './db';
import { openFallback } from './notes';
import { useUI, type SyncUser } from '../ui/store';

const TABLES: SyncTable[] = ['classes', 'notes', 'docs', 'images'];
/** Pola tylko dla tego komputera – ich zmiana nie wymaga synchronizacji. */
const LOCAL_ONLY = new Set(['cam', 'openedAt']);
const PULL_EVERY = 30_000;

type Row = Record<string, unknown> & { _dirty?: number; _ts?: number; _remote?: number };
interface Change {
  tbl: SyncTable;
  id: string;
  data: Row | null;
  ts: number;
  deleted: boolean;
}

const keyOf = (tbl: SyncTable, row: Row) => String(tbl === 'docs' ? row.noteId : row.id);

// ---------- znaczniki zmian ----------
// Zapis z `_remote: 1` pochodzi z serwera (lub z samej synchronizacji) – nie oznaczamy go jako zmiany.

for (const name of TABLES) {
  const t = db.table<Row>(name);
  t.hook('creating', (_pk, obj) => {
    if (obj._remote) {
      delete obj._remote;
      return;
    }
    obj._dirty = 1;
    obj._ts = Date.now();
    scheduleSync();
  });
  t.hook('updating', (mods) => {
    const m = mods as Row;
    if ('_remote' in m) return { _remote: undefined };
    if (Object.keys(m).every((k) => LOCAL_ONLY.has(k))) return;
    scheduleSync();
    return { _dirty: 1, _ts: Date.now() };
  });
}

// ---------- API ----------

class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error || res.statusText, res.status);
  return json as T;
}

const kvGet = async <T>(key: string) => (await db.kv.get(key))?.value as T | undefined;
const kvSet = (key: string, value: unknown) => db.kv.put({ key, value });

function setSync(state: 'off' | 'syncing' | 'ok' | 'offline' | 'error', error?: string) {
  useUI.setState({ sync: { state, at: state === 'ok' ? Date.now() : useUI.getState().sync.at, error } });
}

// ---------- synchronizacja ----------

let timer = 0;
let running = false;
let again = false;

export function scheduleSync(delay = 1500) {
  if (!useUI.getState().user) return;
  clearTimeout(timer);
  timer = window.setTimeout(() => void syncNow(), delay);
}

export async function syncNow() {
  if (!useUI.getState().user) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  clearTimeout(timer);
  setSync('syncing');
  try {
    let since = (await kvGet<number>('lastRev')) ?? 0;

    // pierwsze połączenie tego komputera: wyślij wszystko, co już jest lokalnie
    if (!(await kvGet<boolean>('initialPushDone'))) {
      for (const tbl of TABLES) {
        await db.table<Row>(tbl).toCollection().modify((r) => {
          r._dirty = 1;
          r._ts = r._ts ?? Date.now();
          r._remote = 1;
        });
      }
      await kvSet('initialPushDone', true);
    }

    const changes: Change[] = [];
    const pushed: [SyncTable, string, number][] = [];
    for (const tbl of TABLES) {
      const rows = await db.table<Row>(tbl).where('_dirty').equals(1).toArray();
      for (const row of rows) {
        const { _dirty, _ts, ...data } = row;
        const id = keyOf(tbl, row);
        const ts = _ts ?? Date.now();
        changes.push({ tbl, id, data, ts, deleted: false });
        pushed.push([tbl, id, ts]);
      }
    }
    const tombs = await db.tombstones.toArray();
    for (const t of tombs) changes.push({ tbl: t.tbl, id: t.id, data: null, ts: t.ts, deleted: true });

    let first = true;
    let more = true;
    let reload = false;
    while (more) {
      const res = await api<{ changes: Change[]; rev: number; more: boolean }>('/api/sync', {
        since,
        changes: first ? changes : [],
      });
      first = false;
      if (await applyRemote(res.changes)) reload = true;
      since = res.rev;
      more = res.more;
      await kvSet('lastRev', since);
    }

    // potwierdzenie: wysłane wiersze nie są już „brudne” (chyba że w międzyczasie znowu się zmieniły)
    await db.transaction('rw', [db.classes, db.notes, db.docs, db.images, db.tombstones], async () => {
      for (const [tbl, id, ts] of pushed) {
        const row = await db.table<Row>(tbl).get(id);
        if (row && row._dirty && row._ts === ts) await db.table<Row>(tbl).update(id, { _dirty: 0, _remote: 1 });
      }
      for (const t of tombs) {
        const cur = await db.tombstones.get(t.key);
        if (cur && cur.ts === t.ts) await db.tombstones.delete(t.key);
      }
    });

    if (reload) await reloadCurrentNote();
    setSync('ok');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      useUI.setState({ user: null });
      setSync('off');
    } else if (e instanceof ApiError) {
      setSync('error', e.message);
    } else {
      setSync('offline');
    }
  } finally {
    running = false;
    if (again) {
      again = false;
      scheduleSync(300);
    }
  }
}

/** Zapisuje zmiany z serwera. Zwraca true, jeśli zmieniła się aktualnie otwarta notatka. */
async function applyRemote(changes: Change[]) {
  if (!changes.length) return false;
  const current = useUI.getState().currentNoteId;
  let touchesCurrent = false;
  await db.transaction('rw', [db.classes, db.notes, db.docs, db.images], async () => {
    for (const ch of changes) {
      const t = db.table<Row>(ch.tbl);
      const local = await t.get(ch.id);
      if (local && local._ts === ch.ts) continue; // to nasza własna zmiana
      if (local && local._dirty && (local._ts ?? 0) > ch.ts) continue; // lokalna jest nowsza
      if (ch.deleted) {
        if (local) await t.delete(ch.id);
      } else {
        const data: Row = { ...ch.data };
        if (ch.tbl === 'notes' && local) {
          data.cam = local.cam;
          data.openedAt = Math.max(Number(local.openedAt) || 0, Number(data.openedAt) || 0);
        }
        await t.put({ ...data, _dirty: 0, _ts: ch.ts, _remote: 1 });
      }
      if (ch.id === current && (ch.tbl === 'docs' || ch.deleted)) touchesCurrent = true;
      if (ch.tbl === 'images') touchesCurrent = true; // obrazek z innego komputera – przerysuj
    }
  });
  return touchesCurrent;
}

async function reloadCurrentNote() {
  const id = useUI.getState().currentNoteId;
  const note = id ? await db.notes.get(id) : undefined;
  if (!note || note.deletedAt) {
    await openFallback(id ?? '');
  } else {
    useUI.setState((s) => ({ boardReload: s.boardReload + 1 }));
  }
}

// ---------- logowanie ----------

export interface ServerConfig {
  googleClientId: string | null;
  devLogin: boolean;
}

let configPromise: Promise<ServerConfig | null> | null = null;
export function getConfig() {
  return (configPromise ??= api<ServerConfig>('/api/config').catch(() => null));
}

async function signedIn(user: SyncUser) {
  useUI.setState({ user });
  await syncNow();
}

export async function signInWithGoogle(credential: string) {
  const { user } = await api<{ user: SyncUser }>('/api/auth/google', { credential });
  await signedIn(user);
}

export async function signInDev() {
  const { user } = await api<{ user: SyncUser }>('/api/auth/dev', {});
  await signedIn(user);
}

export async function signOut() {
  await syncNow();
  await api('/api/auth/logout', {}).catch(() => {});
  useUI.setState({ user: null });
  setSync('off');
  await db.kv.bulkDelete(['lastRev', 'initialPushDone']);
}

export async function initSync() {
  try {
    const { user } = await api<{ user: SyncUser | null }>('/api/me');
    useUI.setState({ user });
  } catch {
    // brak sieci – zostajemy przy zapamiętanym użytkowniku, spróbujemy później
  }
  if (useUI.getState().user) void syncNow();
  else setSync('off');
  // syncNow() samo nic nie robi, gdy nikt nie jest zalogowany
  window.setInterval(() => void syncNow(), PULL_EVERY);
  window.addEventListener('focus', () => void syncNow());
  window.addEventListener('online', () => void syncNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void syncNow();
  });
}
