import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { OAuth2Client } from 'google-auth-library';
import { openDb } from './db.ts';

// lokalnie: zmienne z pliku .env (na produkcji ustawia je Coolify)
if (existsSync('.env')) process.loadEnvFile('.env');

const PORT = Number(process.env.PORT ?? 8787);
const PROD = process.env.NODE_ENV === 'production';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const ALLOWED = (process.env.ALLOWED_EMAILS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
/** Tylko lokalnie: logowanie bez Google na ten adres. */
const DEV_LOGIN_EMAIL = PROD ? '' : (process.env.DEV_LOGIN_EMAIL ?? 'dev@localhost');
const COOKIE = 'nm_session';
const SESSION_DAYS = 180;
const SYNC_TABLES = new Set(['classes', 'notes', 'docs', 'images']);
/** odpowiedź synchronizacji dzielona na porcje ~ tej wielkości (obrazki bywają duże) */
const PULL_BYTES = 8 * 1024 * 1024;

const db = await openDb();
const google = new OAuth2Client(GOOGLE_CLIENT_ID);

type User = { id: string; email: string; name: string | null };
type Env = { Variables: { user: User } };

const app = new Hono<Env>();

async function startSession(c: Context, email: string, name: string | null) {
  const id = email.toLowerCase();
  await db.query(
    `insert into users (id, email, name) values ($1, $2, $3)
     on conflict (id) do update set name = excluded.name`,
    [id, email, name],
  );
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await db.query('insert into sessions (token, user_id, expires_at) values ($1, $2, $3)', [token, id, expires]);
  setCookie(c, COOKIE, token, { httpOnly: true, secure: PROD, sameSite: 'Lax', path: '/', expires });
  return { id, email, name };
}

async function currentUser(c: Context): Promise<User | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const { rows } = await db.query<User>(
    `select u.id, u.email, u.name from sessions s join users u on u.id = s.user_id
     where s.token = $1 and s.expires_at > now()`,
    [token],
  );
  return rows[0] ?? null;
}

// ---------- auth ----------

app.get('/api/config', (c) =>
  c.json({ googleClientId: GOOGLE_CLIENT_ID || null, devLogin: !!DEV_LOGIN_EMAIL }),
);

app.get('/api/me', async (c) => c.json({ user: await currentUser(c) }));

app.post('/api/auth/google', async (c) => {
  if (!GOOGLE_CLIENT_ID) return c.json({ error: 'Google login is not configured' }, 400);
  const { credential } = await c.req.json<{ credential: string }>();
  try {
    const ticket = await google.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    if (!p?.email || !p.email_verified) return c.json({ error: 'Email not verified' }, 403);
    // produkcyjnie bez ALLOWED_EMAILS nikt się nie zaloguje – inaczej każdy z kontem Google miałby dostęp
    if ((PROD || ALLOWED.length) && !ALLOWED.includes(p.email.toLowerCase())) {
      return c.json({ error: `${p.email} is not allowed` }, 403);
    }
    return c.json({ user: await startSession(c, p.email, p.name ?? null) });
  } catch {
    return c.json({ error: 'Invalid Google token' }, 401);
  }
});

app.post('/api/auth/dev', async (c) => {
  if (!DEV_LOGIN_EMAIL) return c.json({ error: 'Not available' }, 404);
  return c.json({ user: await startSession(c, DEV_LOGIN_EMAIL, 'Dev') });
});

app.post('/api/auth/logout', async (c) => {
  const token = getCookie(c, COOKIE);
  if (token) await db.query('delete from sessions where token = $1', [token]);
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// ---------- synchronizacja ----------

interface Change {
  tbl: string;
  id: string;
  data: unknown;
  ts: number;
  deleted: boolean;
}

app.use('/api/sync', async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'Not signed in' }, 401);
  c.set('user', user);
  await next();
});

/**
 * Wypycha zmiany klienta (wygrywa nowszy ts) i zwraca wszystko, co zmieniło się od `since`.
 */
app.post('/api/sync', bodyLimit({ maxSize: 50 * 1024 * 1024 }), async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ since: number; changes: Change[] }>();
  for (const ch of body.changes ?? []) {
    if (!SYNC_TABLES.has(ch.tbl) || typeof ch.id !== 'string' || typeof ch.ts !== 'number') continue;
    await db.query(
      `insert into records (user_id, tbl, id, data, ts, deleted) values ($1, $2, $3, $4, $5, $6)
       on conflict (user_id, tbl, id) do update
         set data = excluded.data, ts = excluded.ts, deleted = excluded.deleted, rev = nextval('records_rev')
         where records.ts <= excluded.ts`,
      [user.id, ch.tbl, ch.id, ch.deleted ? null : JSON.stringify(ch.data), ch.ts, ch.deleted],
    );
  }
  const LIMIT = 300;
  const { rows: all } = await db.query<{ tbl: string; id: string; data: unknown; ts: string; deleted: boolean; rev: string; size: number }>(
    `select tbl, id, data, ts, deleted, rev, coalesce(octet_length(data::text), 0) as size from records
     where user_id = $1 and rev > $2 order by rev limit ${LIMIT}`,
    [user.id, body.since ?? 0],
  );
  // przynajmniej jeden rekord, potem do limitu rozmiaru
  let bytes = 0;
  const rows = all.filter((r, i) => (bytes += Number(r.size)) <= PULL_BYTES || i === 0);
  return c.json({
    changes: rows.map((r) => ({ tbl: r.tbl, id: r.id, data: r.data, ts: Number(r.ts), deleted: r.deleted })),
    rev: rows.length ? Number(rows[rows.length - 1].rev) : (body.since ?? 0),
    more: rows.length < all.length || all.length === LIMIT,
  });
});

// ---------- frontend (produkcyjnie) ----------

app.get('/health', (c) => c.text('ok'));
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

if (existsSync('./dist')) {
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('*', serveStatic({ path: './dist/index.html' }));
}


serve({ fetch: app.fetch, port: PORT }, (info) => console.log(`[server] http://localhost:${info.port}`));
