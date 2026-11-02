/**
 * Postgres: produkcyjnie przez DATABASE_URL (pg), lokalnie bez konfiguracji – PGlite (Postgres w procesie).
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const SCHEMA = `
create table if not exists users (
  id text primary key,
  email text unique not null,
  name text,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  token text primary key,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create sequence if not exists records_rev;

-- wszystkie dane notatnika: klasy, notatki, treść notatek – jako dokumenty jsonb
create table if not exists records (
  user_id text not null references users(id) on delete cascade,
  tbl text not null,
  id text not null,
  data jsonb,
  ts bigint not null,
  deleted boolean not null default false,
  rev bigint not null default nextval('records_rev'),
  primary key (user_id, tbl, id)
);

create index if not exists records_user_rev on records (user_id, rev);
`;

export async function openDb(): Promise<Db> {
  let db: Db;
  const url = process.env.DATABASE_URL;
  if (!url && process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production');
  if (url) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    db = { query: (sql, params) => pool.query(sql, params as unknown[]) as never };
    console.log('[db] postgres');
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = process.env.PGLITE_DIR ?? './.data/pglite';
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    const lite = new PGlite(dir);
    db = { query: (sql, params) => lite.query(sql, params as unknown[]) as never };
    console.log('[db] PGlite (local dev) in', dir);
  }
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.query(stmt);
  }
  return db;
}
