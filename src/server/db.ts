/**
 * Der Speicher — eine SQLite-Datei statt vieler JSON-Dateien.
 *
 * ── Warum gewechselt wurde ──────────────────────────────────────────────────
 *
 * Eine Datei je Hof war für einen Feldtest genau richtig: lesbar, kopierbar,
 * ohne jede Installation. Sie skaliert nur nicht, und zwar aus einem Grund, den
 * man erst beim Messen sieht — **jeder Sync schreibt die ganze Datei neu**.
 *
 * Gemessen an einem Spieler über eine lange Sitzung:
 *
 *   | Stand                        | Datei   | geschrieben gesamt |
 *   | ---------------------------- | ------- | ------------------ |
 *   | ungedeckelter Command-Log    | 352 kB  | 344 MB             |
 *   | Log auf ein Fenster begrenzt |  14 kB  |  27 MB             |
 *
 * Der erste Fall ist quadratisch und damit von vornherein aussichtslos. Aber
 * auch der zweite bleibt teuer: Bei zweitausend gleichzeitigen Spielern sind
 * das rund zweitausend einzelne Dateischreibvorgänge in wenigen Sekunden —
 * viele kleine Dateien sind für ein Dateisystem die unangenehmste Last.
 *
 * ── Was SQLite daran ändert ─────────────────────────────────────────────────
 *
 * Nicht „es ist eine Datenbank", sondern genau zwei Dinge:
 *
 *  1. **WAL.** Änderungen werden sequentiell angehängt statt an Ort und Stelle
 *     überschrieben. Aus wahllosem Springen über die Platte wird ein Strom.
 *  2. **Eine Transaktion für viele Höfe.** Zweitausend geänderte Spielstände
 *     kosten einen Schreibvorgang, nicht zweitausend.
 *
 * ── Warum nicht Postgres ────────────────────────────────────────────────────
 *
 * Weil dieses Spiel auf **einem** Server laufen soll — kein Loadbalancer, keine
 * Regionen. Genau dafür ist SQLite gebaut, und es kostet keinen zweiten Dienst,
 * keinen zweiten Prozess und keine Abhängigkeit: `node:sqlite` liegt seit Node
 * 22 bei. Ein Backup ist weiterhin eine Datei.
 *
 * Die Grenze, klar gesagt: Ein einzelner Prozess schreibt. Sobald zwei
 * Serverprozesse denselben Hof anfassen sollen, trägt das nicht mehr — dann
 * wird aus dieser Datei ein Dienst. Bis dahin ist es die einfachere Lösung, und
 * einfacher heißt hier auch: weniger, was nachts kaputtgehen kann.
 *
 * ── Warum der Spielstand als JSON in einer Spalte liegt ─────────────────────
 *
 * Weil nie hineingefragt wird. Ein Hof wird immer ganz geladen und ganz
 * geschrieben; ihn in Tabellen zu zerlegen brächte keine einzige Abfrage und
 * kostete bei jedem Regelwerk-Umbau eine Schemamigration. Was abgefragt WIRD —
 * Schlüssel-Hash, letzter Zugriff — steht als eigene Spalte daneben.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

/**
 * Datenbank öffnen und einrichten.
 *
 * Die beiden `pragma`-Zeilen sind der eigentliche Inhalt dieser Funktion:
 *
 *  - **`journal_mode = WAL`** erlaubt Lesen während geschrieben wird und macht
 *    aus verstreuten Schreibzugriffen einen sequentiellen Anhang.
 *  - **`synchronous = NORMAL`** verzichtet auf ein `fsync` je Transaktion.
 *
 * Der Preis von NORMAL, ehrlich benannt: Bei einem **Stromausfall** können die
 * letzten Sekundenbruchteile fehlen. Bei einem Absturz des Prozesses oder einem
 * `kill` dagegen nicht — das WAL ist geschrieben. Für ein Bauernhofspiel auf
 * einem Mini-Server ist das der richtige Tausch; für Buchhaltung wäre es der
 * falsche.
 */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  db.exec('pragma journal_mode = WAL');
  db.exec('pragma synchronous = NORMAL');
  // Ein hängender Schreibzugriff soll nicht sofort aufgeben. Betrifft nur
  // Fremdzugriffe (etwa ein `sqlite3` auf derselben Datei) — der Server selbst
  // ist einfädig.
  db.exec('pragma busy_timeout = 5000');
  db.exec('pragma foreign_keys = ON');

  migrate(db);
  return db;
}

/**
 * Schema-Migrationen, streng der Reihe nach.
 *
 * Dieselbe Disziplin wie beim Regelwerk (R2): nur vorwärts, jeder Schritt
 * einzeln, und die erreichte Version steht in der Datei. Ein Server, der eine
 * neuere Datei vorfindet, als er kennt, startet lieber nicht — sonst schriebe
 * eine alte Version in ein Schema, das sie nicht versteht.
 */
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
  /**
   * Besitz eines Hofes.
   *
   * Noch ohne Wirkung, solange nur ein Prozess läuft — aber die Spalte muss da
   * sein, bevor ein zweiter startet. Sonst wäre der Moment, in dem man sie
   * braucht, genau der Moment, in dem man sie nicht mehr in Ruhe einführen
   * kann.
   */
  (db) => {
    db.exec(`
      alter table accounts add column owner text;
      alter table accounts add column owner_until integer not null default 0;
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

/** Mehrere Schreibvorgänge zu einem zusammenfassen. Der ganze Sinn der Übung. */
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
