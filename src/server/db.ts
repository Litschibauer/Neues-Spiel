import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  db.exec('pragma journal_mode = WAL');
  db.exec('pragma synchronous = NORMAL');

  db.exec('pragma busy_timeout = 5000');
  db.exec('pragma foreign_keys = ON');

  migrate(db);
  return db;
}

const MIGRATIONS: ReadonlyArray<(db: Db) => void> = [
  (db) => {
    db.exec(`
      create table accounts (
        id           text primary key,
        key_hash     text not null unique,
        created_at   integer not null,
        last_seen_ms integer not null,
        game         text not null
      );

      create table market_offers (
        id        integer primary key,
        seller    text not null,
        order_id  integer not null,
        item      integer not null,
        amount    integer not null,
        price     integer not null,
        listed_ms integer not null
      );
      create index market_offers_seller on market_offers (seller);
      create index market_offers_price on market_offers (price, listed_ms, id);

      create table market_settlements (
        id       integer primary key autoincrement,
        seller   text not null,
        order_id integer not null,
        gold     integer not null,
        sold_ms  integer not null
      );
      create index market_settlements_seller on market_settlements (seller);

      create table meta (k text primary key, v text not null);
    `);
  },

  (db) => {
    db.exec(`
      alter table accounts add column owner text;
      alter table accounts add column owner_until integer not null default 0;
    `);
  },

  (db) => {
    db.exec(`
      alter table accounts add column code text;
      alter table accounts add column hofname text;
      create unique index accounts_code on accounts (code) where code is not null;

      create table freunde (
        wer      text not null,
        freund   text not null,
        seit_ms  integer not null,
        primary key (wer, freund)
      );

      create table hilfen (
        helfer text not null,
        hof    text not null,
        tag    integer not null,
        wie    integer not null,
        primary key (helfer, hof, tag)
      );
    `);
  },

  (db) => {
    db.exec(`
      alter table freunde add column stand text not null default 'ok';
    `);
  },

  (db) => {
    db.exec(`
      alter table accounts add column bonus_day integer not null default 0;
      alter table accounts add column bonus_streak integer not null default 0;
    `);
  },
];

function migrate(db: Db): void {
  const current = Number(
    (db.prepare('pragma user_version').get() as { user_version?: number }).user_version ?? 0,
  );
  if (current > MIGRATIONS.length) {
    throw new Error(
      `Die Datenbank ist Version ${current}, dieser Server kennt nur ${MIGRATIONS.length}. ` +
        'Vermutlich läuft hier eine ältere Version als zuletzt — bitte den neueren Stand starten.',
    );
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('begin');
    try {
      MIGRATIONS[v]!(db);
      db.exec(`pragma user_version = ${v + 1}`);
      db.exec('commit');
    } catch (err) {
      db.exec('rollback');
      throw err;
    }
  }
}

export function transaction<T>(db: Db, body: () => T): T {
  db.exec('begin immediate');
  try {
    const out = body();
    db.exec('commit');
    return out;
  } catch (err) {
    db.exec('rollback');
    throw err;
  }
}

export function readMeta(db: Db, key: string): string | null {
  const row = db.prepare('select v from meta where k = ?').get(key) as { v?: string } | undefined;
  return row?.v ?? null;
}

export function writeMeta(db: Db, key: string, value: string): void {
  db.prepare('insert into meta (k, v) values (?, ?) on conflict(k) do update set v = excluded.v').run(
    key,
    value,
  );
}
