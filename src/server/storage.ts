/**
 * Die Speicherschicht — und die Naht, an der sie ausgetauscht wird.
 *
 * ── Warum das eine eigene Datei ist ─────────────────────────────────────────
 *
 * Nicht, weil SQLite zu klein wäre. Gemessen (`npm run bench:scale`) trägt es
 * 4000 Höfe bei ~7.200 Syncs/s und 98 MB Arbeitsspeicher, und die Validierung
 * eines Offline-Rückkehrers mit 5000 Aktionen kostet 4,6 ms. Der Speicher ist
 * heute der Engpass nicht.
 *
 * Sondern weil man das **später nicht mehr billig ändern kann**, wenn es nie
 * eine Grenze gab. Diese Datei ist die Grenze: Der Rest des Servers redet
 * ausschließlich hierüber mit der Platte. Eine andere Datenbank ist damit eine
 * neue Klasse, die `Storage` erfüllt — kein Umbau am Spiel.
 *
 * Dass die Grenze echt ist und nicht nur behauptet, sichert
 * `test/storage-contract.test.ts`: Dieselbe Testreihe läuft gegen JEDE
 * Implementierung. Wer eine neue schreibt, macht diese Tests grün — dieselbe
 * Disziplin wie die Golden Vectors für den Sim-Kern.
 *
 * ── Was diese Schnittstelle NICHT löst ──────────────────────────────────────
 *
 * Sie macht den Server **nicht** mehrprozessfähig, und das ist wichtig zu
 * wissen, weil es die häufigste Fehlannahme ist. Ein Hof lebt im Speicher
 * genau eines Prozesses; zwei Prozesse hätten zwei Kopien und damit einen Fork
 * (R3). Eine andere Datenbank ändert daran nichts.
 *
 * Was fehlt, steht in `docs/skalierung.md` — und `claimFarm` unten ist der
 * erste Baustein davon.
 */

import { randomUUID } from 'node:crypto';
import type { Command } from '../sim/commands.ts';
import type { MailItem } from '../sim/state.ts';
import type { Snapshot } from './server.ts';
import { openDb, transaction, readMeta, writeMeta } from './db.ts';
import type { Db } from './db.ts';

export type AccountRecord = {
  id: string;
  /**
   * Nur der Hash liegt auf der Platte.
   *
   * Ein Backup, eine versehentlich geteilte Datei, ein neugieriger Blick —
   * nichts davon soll fremde Höfe aufmachen können.
   */
  keyHash: string;
  createdAt: number;
  lastSeenMs: number;
};

/** Der Spielstand, wie ihn der Speicher sieht: ein undurchsichtiger Block. */
export type GameBlob = {
  snapshot: Snapshot;
  appliedLog: Command[];
  logStartSeq?: number;
  pendingDeliveries: MailItem[];
  targetRulesetVersion: number;
  nextRequestId: number;
};

/** Ein Angebot, wie es im Buch steht — mit allem, was der Sim-Kern nicht sieht. */
export type BookEntry = {
  id: number;
  sellerId: string;
  /** Die Auftragsnummer beim Verkäufer — darüber wird abgerechnet. */
  orderId: number;
  item: number;
  amount: number;
  /** Pro Stück. */
  price: number;
  listedMs: number;
};

/** Was einem Verkäufer zusteht, der beim Verkauf nicht da war. */
export type Settlement = {
  sellerId: string;
  orderId: number;
  gold: number;
  soldMs: number;
};

/**
 * Der Vertrag.
 *
 * Bewusst **synchron**, weil der Server es ist: Ein Sync rechnet einen ganzen
 * Command-Log durch, ohne dazwischen die Kontrolle abzugeben, und genau das
 * macht ihn frei von Verschränkungsfehlern. Eine Datenbank über Netz
 * erzwänge `async` bis hinunter in `Server.sync` — machbar, aber ein anderer
 * Umbau, und er steht in `docs/skalierung.md` beschrieben statt hier
 * vorweggenommen.
 *
 * Jede Methode ist so geschnitten, dass eine echte Datenbank sie in **einer**
 * Anweisung erfüllen kann. `claimOffer` etwa ist nicht „lies, prüfe, lösche",
 * sondern ein einziger atomarer Griff — sonst wäre der Vertrag nur auf einem
 * einfädigen Prozess einhaltbar, und man hätte sich die Grenze gespart.
 */
export interface Storage {
  // ── Höfe ───────────────────────────────────────────────────────────
  /** Alle Kennungen, ohne Spielstände. Wird einmal beim Start gelesen. */
  listAccounts(): AccountRecord[];
  /** Ein Spielstand. `null`, wenn es ihn nicht gibt. */
  loadFarm(id: string): GameBlob | null;
  /**
   * Mehrere Höfe auf einmal schreiben — **in einer Transaktion**.
   *
   * Das ist der Grund, warum diese Methode eine Liste nimmt und nicht einen
   * einzelnen Hof: Zweitausend geänderte Spielstände sollen einen
   * Schreibvorgang kosten, nicht zweitausend.
   */
  putFarms(entries: ReadonlyArray<{ account: AccountRecord; game: GameBlob }>): void;

  // ── Besitz (Vorbereitung auf mehrere Serverprozesse) ───────────────
  /**
   * Diesen Hof für `ownerId` beanspruchen, bis `untilMs`.
   *
   * `true` heißt: Er gehört jetzt uns. `false` heißt: Ein anderer Prozess hat
   * ihn und seine Frist läuft noch — dann darf dieser Prozess ihn NICHT laden,
   * sonst gäbe es zwei Kopien desselben Hofes und damit einen Fork (R3).
   *
   * Solange nur ein Prozess läuft, gibt das immer `true`. Der Aufruf ist
   * trotzdem schon da: Ihn nachträglich einzuziehen hieße, jeden Ladepfad
   * anzufassen — und man vergisst genau einen.
   */
  claimFarm(id: string, ownerId: string, untilMs: number): boolean;
  /** Besitz aufgeben, damit ein anderer Prozess sofort übernehmen kann. */
  releaseFarm(id: string, ownerId: string): void;

  // ── Markt ──────────────────────────────────────────────────────────
  loadBook(): BookEntry[];
  loadSettlements(): Settlement[];
  /** Angebote schreiben und entfernte löschen — in einer Transaktion. */
  putOffers(upserts: readonly BookEntry[], removed: readonly number[]): void;
  /**
   * Ein Angebot beanspruchen: **atomar** entfernen und die Abrechnung
   * hinterlegen.
   *
   * Der Moment, in dem der Markt entscheidet, wer die Ware bekommt. Deshalb
   * genau eine Anweisung und nicht drei: Zwischen „ist es noch da" und „es ist
   * jetzt meins" darf keine Lücke liegen, sonst hat man das Rennen nur
   * verschoben.
   *
   * `null` heißt: zu spät, jemand anders war schneller.
   */
  claimOffer(offerId: number, buyerId: string, nowMs: number): BookEntry | null;
  /** Abrechnungen eines Verkäufers entnehmen — gelesen UND gelöscht. */
  takeSettlements(sellerId: string): Settlement[];
  /** Alles zu einem Hof löschen — beim Zurücksetzen im Feldtest. */
  forgetSeller(sellerId: string): void;

  // ── Kleinkram ──────────────────────────────────────────────────────
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  close(): void;
}

/** Kennung DIESES Serverprozesses. Für den Besitz von Höfen. */
export const PROCESS_ID = `p-${randomUUID().slice(0, 8)}`;

// ── SQLite ────────────────────────────────────────────────────────────────

export class SqliteStorage implements Storage {
  private readonly db: Db;

  constructor(pathOrDb: string | Db) {
    this.db = typeof pathOrDb === 'string' ? openDb(pathOrDb) : pathOrDb;
  }

  /** Für den Umzug alter Einzeldateien — die Datenbank liegt darunter offen. */
  get database(): Db {
    return this.db;
  }

  listAccounts(): AccountRecord[] {
    return (
      this.db
        .prepare('select id, key_hash, created_at, last_seen_ms from accounts')
        .all() as Array<Record<string, string | number>>
    ).map((r) => ({
      id: String(r.id),
      keyHash: String(r.key_hash),
      createdAt: Number(r.created_at),
      lastSeenMs: Number(r.last_seen_ms),
    }));
  }

  loadFarm(id: string): GameBlob | null {
    const row = this.db.prepare('select game from accounts where id = ?').get(id) as
      | { game?: string }
      | undefined;
    return row?.game ? (JSON.parse(row.game) as GameBlob) : null;
  }

  putFarms(entries: ReadonlyArray<{ account: AccountRecord; game: GameBlob }>): void {
    if (entries.length === 0) return;
    transaction(this.db, () => {
      const put = this.db.prepare(
        `insert into accounts (id, key_hash, created_at, last_seen_ms, game)
         values (?, ?, ?, ?, ?)
         on conflict(id) do update set
           key_hash = excluded.key_hash,
           last_seen_ms = excluded.last_seen_ms,
           game = excluded.game`,
      );
      for (const { account, game } of entries) {
        put.run(
          account.id,
          account.keyHash,
          account.createdAt,
          account.lastSeenMs,
          JSON.stringify(game),
        );
      }
    });
  }

  /**
   * Eine einzige Anweisung, und darauf kommt es an.
   *
   * Der Besitz geht über, wenn niemand ihn hat, die Frist des anderen
   * abgelaufen ist, oder wir es ohnehin schon sind. Als `update … where` ist
   * das atomar — auch dann noch, wenn hier eines Tages eine Datenbank über
   * Netz steht und mehrere Prozesse gleichzeitig fragen.
   */
  claimFarm(id: string, ownerId: string, untilMs: number): boolean {
    const now = Date.now();
    const changed = this.db
      .prepare(
        `update accounts set owner = ?, owner_until = ?
         where id = ? and (owner is null or owner = ? or owner_until < ?)`,
      )
      .run(ownerId, untilMs, id, ownerId, now);
    return Number(changed.changes) > 0;
  }

  releaseFarm(id: string, ownerId: string): void {
    this.db
      .prepare('update accounts set owner = null, owner_until = 0 where id = ? and owner = ?')
      .run(id, ownerId);
  }

  loadBook(): BookEntry[] {
    return (
      this.db
        .prepare('select id, seller, order_id, item, amount, price, listed_ms from market_offers')
        .all() as Array<Record<string, string | number>>
    ).map((r) => ({
      id: Number(r.id),
      sellerId: String(r.seller),
      orderId: Number(r.order_id),
      item: Number(r.item),
      amount: Number(r.amount),
      price: Number(r.price),
      listedMs: Number(r.listed_ms),
    }));
  }

  loadSettlements(): Settlement[] {
    return (
      this.db
        .prepare('select seller, order_id, gold, sold_ms from market_settlements')
        .all() as Array<Record<string, string | number>>
    ).map((r) => ({
      sellerId: String(r.seller),
      orderId: Number(r.order_id),
      gold: Number(r.gold),
      soldMs: Number(r.sold_ms),
    }));
  }

  putOffers(upserts: readonly BookEntry[], removed: readonly number[]): void {
    if (upserts.length === 0 && removed.length === 0) return;
    transaction(this.db, () => {
      const del = this.db.prepare('delete from market_offers where id = ?');
      for (const id of removed) del.run(id);
      const put = this.db.prepare(
        `insert into market_offers (id, seller, order_id, item, amount, price, listed_ms)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set amount = excluded.amount, price = excluded.price`,
      );
      for (const e of upserts) {
        put.run(e.id, e.sellerId, e.orderId, e.item, e.amount, e.price, e.listedMs);
      }
    });
  }

  claimOffer(offerId: number, buyerId: string, nowMs: number): BookEntry | null {
    return transaction(this.db, () => {
      const row = this.db
        .prepare('delete from market_offers where id = ? and seller <> ? returning *')
        .get(offerId, buyerId) as Record<string, string | number> | undefined;
      if (!row) return null;

      const entry: BookEntry = {
        id: Number(row.id),
        sellerId: String(row.seller),
        orderId: Number(row.order_id),
        item: Number(row.item),
        amount: Number(row.amount),
        price: Number(row.price),
        listedMs: Number(row.listed_ms),
      };
      // Im selben Griff hinterlegt: Ein Verkauf, bei dem die Abrechnung
      // verlorenginge, hieße, der Käufer hat bezahlt und der Verkäufer
      // bekommt nichts.
      this.db
        .prepare('insert into market_settlements (seller, order_id, gold, sold_ms) values (?, ?, ?, ?)')
        .run(entry.sellerId, entry.orderId, entry.amount * entry.price, nowMs);
      return entry;
    });
  }

  takeSettlements(sellerId: string): Settlement[] {
    return transaction(this.db, () => {
      const rows = this.db
        .prepare('delete from market_settlements where seller = ? returning order_id, gold, sold_ms')
        .all(sellerId) as Array<Record<string, number>>;
      return rows.map((r) => ({
        sellerId,
        orderId: Number(r.order_id),
        gold: Number(r.gold),
        soldMs: Number(r.sold_ms),
      }));
    });
  }

  forgetSeller(sellerId: string): void {
    transaction(this.db, () => {
      this.db.prepare('delete from market_offers where seller = ?').run(sellerId);
      this.db.prepare('delete from market_settlements where seller = ?').run(sellerId);
    });
  }

  getMeta(key: string): string | null {
    return readMeta(this.db, key);
  }

  setMeta(key: string, value: string): void {
    writeMeta(this.db, key, value);
  }

  close(): void {
    this.db.close();
  }
}

// ── Nur im Speicher ───────────────────────────────────────────────────────

/**
 * Ohne Platte. Für Tests — und als **zweite Implementierung**, ohne die der
 * Vertrag oben eine Behauptung wäre.
 *
 * Genau dafür ist sie da: Eine Schnittstelle mit nur einer Implementierung ist
 * meistens nur die Form dieser einen Implementierung. Erst die zweite zeigt,
 * ob wirklich nichts durchgesickert ist.
 */
export class MemoryStorage implements Storage {
  private readonly accounts = new Map<string, { account: AccountRecord; game: GameBlob }>();
  private readonly owners = new Map<string, { owner: string; until: number }>();
  private readonly book = new Map<number, BookEntry>();
  private settlements: Settlement[] = [];
  private readonly meta = new Map<string, string>();

  listAccounts(): AccountRecord[] {
    return [...this.accounts.values()].map((e) => e.account);
  }

  loadFarm(id: string): GameBlob | null {
    const entry = this.accounts.get(id);
    // Tief kopieren: Sonst reichte der Speicher denselben Gegenstand heraus,
    // den er hält — und ein Aufrufer, der ihn verändert, hätte unbemerkt in
    // die „Platte" geschrieben. Eine echte Datenbank kann das nicht.
    return entry ? (JSON.parse(JSON.stringify(entry.game)) as GameBlob) : null;
  }

  putFarms(entries: ReadonlyArray<{ account: AccountRecord; game: GameBlob }>): void {
    for (const { account, game } of entries) {
      this.accounts.set(account.id, {
        account: { ...account },
        game: JSON.parse(JSON.stringify(game)) as GameBlob,
      });
    }
  }

  claimFarm(id: string, ownerId: string, untilMs: number): boolean {
    const held = this.owners.get(id);
    if (held && held.owner !== ownerId && held.until >= Date.now()) return false;
    this.owners.set(id, { owner: ownerId, until: untilMs });
    return true;
  }

  releaseFarm(id: string, ownerId: string): void {
    if (this.owners.get(id)?.owner === ownerId) this.owners.delete(id);
  }

  loadBook(): BookEntry[] {
    return [...this.book.values()].map((e) => ({ ...e }));
  }

  loadSettlements(): Settlement[] {
    return this.settlements.map((s) => ({ ...s }));
  }

  putOffers(upserts: readonly BookEntry[], removed: readonly number[]): void {
    for (const id of removed) this.book.delete(id);
    for (const e of upserts) this.book.set(e.id, { ...e });
  }

  claimOffer(offerId: number, buyerId: string, nowMs: number): BookEntry | null {
    const entry = this.book.get(offerId);
    if (!entry || entry.sellerId === buyerId) return null;
    this.book.delete(offerId);
    this.settlements.push({
      sellerId: entry.sellerId,
      orderId: entry.orderId,
      gold: entry.amount * entry.price,
      soldMs: nowMs,
    });
    return { ...entry };
  }

  takeSettlements(sellerId: string): Settlement[] {
    const mine = this.settlements.filter((s) => s.sellerId === sellerId);
    this.settlements = this.settlements.filter((s) => s.sellerId !== sellerId);
    return mine;
  }

  forgetSeller(sellerId: string): void {
    for (const [id, e] of [...this.book]) if (e.sellerId === sellerId) this.book.delete(id);
    this.settlements = this.settlements.filter((s) => s.sellerId !== sellerId);
  }

  getMeta(key: string): string | null {
    return this.meta.get(key) ?? null;
  }

  setMeta(key: string, value: string): void {
    this.meta.set(key, value);
  }

  close(): void {
    /* nichts zu schließen */
  }
}
