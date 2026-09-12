import { randomUUID } from 'node:crypto';
import type { Eingriff } from './server.ts';
import type { Command } from '../sim/commands.ts';
import type { MailItem } from '../sim/state.ts';
import type { Snapshot } from './server.ts';
import { openDb, transaction, readMeta, writeMeta } from './db.ts';
import type { Db } from './db.ts';

export type AccountRecord = {
  id: string;
  keyHash: string;
  createdAt: number;
  lastSeenMs: number;
  // scrypt-Hash des Wiederherstellungsworts; null, solange keins gesetzt ist.
  recoveryHash?: string | null;
};

// Was ein Spieler dem Betreiber schreibt — mit dem, was man zum Nachstellen braucht.
export type Rueckmeldung = {
  id: number;
  konto: string;
  code: string;
  art: 'fehler' | 'idee' | 'lob' | 'sonstiges';
  text: string;
  version: string;
  huelle: string;
  regelwerk: number;
  geraet: string;
  zeitMs: number;
  erledigt: boolean;
};

// Ein Fehler, den ein Gerät gemeldet hat. Gleiche Fehler (gleicher Schlüssel)
// werden gezählt statt gestapelt.
export type Fehlerbericht = {
  id: number;
  schluessel: string;
  konto: string;
  text: string;
  stapel: string;
  ort: string;
  version: string;
  huelle: string;
  regelwerk: number;
  geraet: string;
  zuerstMs: number;
  zuletztMs: number;
  anzahl: number;
};

export type GameBlob = {
  snapshot: Snapshot;
  appliedLog: Command[];
  logStartSeq?: number;
  pendingDeliveries: MailItem[];
  targetRulesetVersion: number;
  nextRequestId: number;
  // Was noch aussteht, bis der Hof wieder abgleicht — ueberlebt einen Neustart.
  pendingXp?: number;
  pendingAbzuege?: Array<{ item: number; amount: number }>;
  eingriffe?: Eingriff[];
};

// Ein Gerät, das Benachrichtigungen empfangen möchte.
export type PushAbo = {
  // Bei 'web' der Push-Endpunkt des Browsers, bei 'ios' das Geräte-Token.
  endpoint: string;
  konto: string;
  art: 'web' | 'ios';
  p256dh: string;
  auth: string;
  seitMs: number;
  zuletztMs: number;
};

export type BookEntry = {
  id: number;
  sellerId: string;
  orderId: number;
  item: number;
  amount: number;
  price: number;
  listedMs: number;
};

export type Settlement = {
  sellerId: string;
  orderId: number;
  gold: number;
  soldMs: number;
};

export interface Storage {
  listAccounts(): AccountRecord[];

  loadFarm(id: string): GameBlob | null;

  putFarms(entries: ReadonlyArray<{ account: AccountRecord; game: GameBlob }>): void;

  claimFarm(id: string, ownerId: string, untilMs: number): boolean;

  releaseFarm(id: string, ownerId: string): void;

  loadBook(): BookEntry[];
  loadSettlements(): Settlement[];

  putOffers(upserts: readonly BookEntry[], removed: readonly number[]): void;

  claimOffer(offerId: number, buyerId: string, nowMs: number): BookEntry | null;

  takeSettlements(sellerId: string): Settlement[];

  forgetSeller(sellerId: string): void;

  // Push-Abos: je Gerät eines, der Endpunkt ist der Schlüssel.
  listPushAbos(konto?: string): PushAbo[];
  putPushAbo(abo: PushAbo): void;
  dropPushAbo(endpoint: string): void;

  // Ein Hof geht endgültig: Konto, Markt und Push-Abos. Freundschaften
  // räumt das Sozial-Modul auf derselben Datenbank ab.
  deleteAccount(id: string): boolean;

  // Briefkästen für Rückmeldungen und Fehlerberichte.
  putRueckmeldung(r: Omit<Rueckmeldung, 'id' | 'erledigt'>): number;
  listRueckmeldungen(limit: number, nurOffene: boolean): Rueckmeldung[];
  erledigeRueckmeldung(id: number, erledigt: boolean): boolean;
  putFehler(f: Omit<Fehlerbericht, 'id' | 'anzahl' | 'zuerstMs'>): void;
  listFehler(limit: number): Fehlerbericht[];
  dropFehler(id: number | 'alle'): number;

  // Alles weg — jeder Hof, der Markt, die Nachbarschaft, die Briefkästen. Für
  // ein neues Universum vor einem Release. Wer das aufruft, hat vorher gesichert.
  wipe(): void;

  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  close(): void;
}

export const PROCESS_ID = `p-${randomUUID().slice(0, 8)}`;

export class SqliteStorage implements Storage {
  private readonly db: Db;

  constructor(pathOrDb: string | Db) {
    this.db = typeof pathOrDb === 'string' ? openDb(pathOrDb) : pathOrDb;
  }

  get database(): Db {
    return this.db;
  }

  listAccounts(): AccountRecord[] {
    return (
      this.db
        .prepare('select id, key_hash, created_at, last_seen_ms, recovery_hash from accounts')
        .all() as Array<Record<string, string | number | null>>
    ).map((r) => ({
      id: String(r.id),
      keyHash: String(r.key_hash),
      createdAt: Number(r.created_at),
      lastSeenMs: Number(r.last_seen_ms),
      recoveryHash: r.recovery_hash == null ? null : String(r.recovery_hash),
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
        `insert into accounts (id, key_hash, created_at, last_seen_ms, recovery_hash, game)
         values (?, ?, ?, ?, ?, ?)
         on conflict(id) do update set
           key_hash = excluded.key_hash,
           last_seen_ms = excluded.last_seen_ms,
           recovery_hash = excluded.recovery_hash,
           game = excluded.game`,
      );
      for (const { account, game } of entries) {
        put.run(
          account.id,
          account.keyHash,
          account.createdAt,
          account.lastSeenMs,
          account.recoveryHash ?? null,
          JSON.stringify(game),
        );
      }
    });
  }

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

  listPushAbos(konto?: string): PushAbo[] {
    const rows = konto
      ? this.db.prepare('select * from push_abos where konto = ?').all(konto)
      : this.db.prepare('select * from push_abos').all();
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      endpoint: String(r.endpoint),
      konto: String(r.konto),
      art: r.art === 'ios' ? 'ios' : 'web',
      p256dh: String(r.p256dh),
      auth: String(r.auth),
      seitMs: Number(r.seit_ms),
      zuletztMs: Number(r.zuletzt_ms),
    }));
  }

  putPushAbo(abo: PushAbo): void {
    this.db
      .prepare(
        `insert into push_abos (endpoint, konto, art, p256dh, auth, seit_ms, zuletzt_ms)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(endpoint) do update set
           konto = excluded.konto, art = excluded.art, p256dh = excluded.p256dh,
           auth = excluded.auth, zuletzt_ms = excluded.zuletzt_ms`,
      )
      .run(abo.endpoint, abo.konto, abo.art, abo.p256dh, abo.auth, abo.seitMs, abo.zuletztMs);
  }

  dropPushAbo(endpoint: string): void {
    this.db.prepare('delete from push_abos where endpoint = ?').run(endpoint);
  }

  deleteAccount(id: string): boolean {
    let weg = false;
    transaction(this.db, () => {
      const res = this.db.prepare('delete from accounts where id = ?').run(id);
      weg = Number(res.changes ?? 0) > 0;
      this.db.prepare('delete from market_offers where seller = ?').run(id);
      this.db.prepare('delete from market_settlements where seller = ?').run(id);
      this.db.prepare('delete from push_abos where konto = ?').run(id);
      this.db.prepare('delete from rueckmeldungen where konto = ?').run(id);
      this.db.prepare(`update fehler set konto = '' where konto = ?`).run(id);
    });
    return weg;
  }

  putRueckmeldung(r: Omit<Rueckmeldung, 'id' | 'erledigt'>): number {
    const res = this.db
      .prepare(
        `insert into rueckmeldungen (konto, code, art, text, version, huelle, regelwerk, geraet, zeit_ms)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.konto, r.code, r.art, r.text, r.version, r.huelle, r.regelwerk, r.geraet, r.zeitMs);
    return Number(res.lastInsertRowid);
  }

  listRueckmeldungen(limit: number, nurOffene: boolean): Rueckmeldung[] {
    const rows = this.db
      .prepare(
        `select * from rueckmeldungen ${nurOffene ? 'where erledigt = 0' : ''}
         order by zeit_ms desc, id desc limit ?`,
      )
      .all(limit) as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      id: Number(r.id),
      konto: String(r.konto),
      code: String(r.code),
      art: String(r.art) as Rueckmeldung['art'],
      text: String(r.text),
      version: String(r.version),
      huelle: String(r.huelle),
      regelwerk: Number(r.regelwerk),
      geraet: String(r.geraet),
      zeitMs: Number(r.zeit_ms),
      erledigt: Number(r.erledigt) === 1,
    }));
  }

  erledigeRueckmeldung(id: number, erledigt: boolean): boolean {
    const res = this.db
      .prepare('update rueckmeldungen set erledigt = ? where id = ?')
      .run(erledigt ? 1 : 0, id);
    return Number(res.changes ?? 0) > 0;
  }

  putFehler(f: Omit<Fehlerbericht, 'id' | 'anzahl' | 'zuerstMs'>): void {
    this.db
      .prepare(
        `insert into fehler (schluessel, konto, text, stapel, ort, version, huelle, regelwerk, geraet, zuerst_ms, zuletzt_ms, anzahl)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         on conflict(schluessel) do update set
           anzahl = anzahl + 1,
           zuletzt_ms = excluded.zuletzt_ms,
           konto = case when excluded.konto = '' then konto else excluded.konto end,
           version = case when excluded.version = '' then version else excluded.version end,
           huelle = case when excluded.huelle = '' then huelle else excluded.huelle end,
           regelwerk = case when excluded.regelwerk = 0 then regelwerk else excluded.regelwerk end`,
      )
      .run(f.schluessel, f.konto, f.text, f.stapel, f.ort, f.version, f.huelle, f.regelwerk, f.geraet, f.zuletztMs, f.zuletztMs);
  }

  listFehler(limit: number): Fehlerbericht[] {
    const rows = this.db
      .prepare('select * from fehler order by zuletzt_ms desc, id desc limit ?')
      .all(limit) as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      id: Number(r.id),
      schluessel: String(r.schluessel),
      konto: String(r.konto),
      text: String(r.text),
      stapel: String(r.stapel),
      ort: String(r.ort),
      version: String(r.version),
      huelle: String(r.huelle),
      regelwerk: Number(r.regelwerk),
      geraet: String(r.geraet),
      zuerstMs: Number(r.zuerst_ms),
      zuletztMs: Number(r.zuletzt_ms),
      anzahl: Number(r.anzahl),
    }));
  }

  dropFehler(id: number | 'alle'): number {
    const res =
      id === 'alle'
        ? this.db.prepare('delete from fehler').run()
        : this.db.prepare('delete from fehler where id = ?').run(id);
    return Number(res.changes ?? 0);
  }

  wipe(): void {
    transaction(this.db, () => {
      for (const tabelle of ['accounts', 'market_offers', 'market_settlements', 'freunde', 'hilfen', 'push_abos', 'rueckmeldungen', 'fehler', 'meta']) {
        this.db.exec(`delete from ${tabelle}`);
      }
      // Die laufenden Nummern der autoincrement-Tabellen auch zurück.
      this.db.exec('delete from sqlite_sequence');
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

export class MemoryStorage implements Storage {
  private readonly accounts = new Map<string, { account: AccountRecord; game: GameBlob }>();
  private readonly owners = new Map<string, { owner: string; until: number }>();
  private readonly book = new Map<number, BookEntry>();
  private readonly pushAbos = new Map<string, PushAbo>();
  private settlements: Settlement[] = [];
  private readonly meta = new Map<string, string>();

  listAccounts(): AccountRecord[] {
    return [...this.accounts.values()].map((e) => e.account);
  }

  loadFarm(id: string): GameBlob | null {
    const entry = this.accounts.get(id);

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

  listPushAbos(konto?: string): PushAbo[] {
    const alle = [...this.pushAbos.values()];
    return konto ? alle.filter((a) => a.konto === konto) : alle;
  }

  putPushAbo(abo: PushAbo): void {
    this.pushAbos.set(abo.endpoint, abo);
  }

  dropPushAbo(endpoint: string): void {
    this.pushAbos.delete(endpoint);
  }

  deleteAccount(id: string): boolean {
    const weg = this.accounts.delete(id);
    this.owners.delete(id);
    this.forgetSeller(id);
    for (const [ep, abo] of [...this.pushAbos]) if (abo.konto === id) this.pushAbos.delete(ep);
    this.rueckmeldungen = this.rueckmeldungen.filter((r) => r.konto !== id);
    for (const f of this.fehler.values()) if (f.konto === id) f.konto = '';
    return weg;
  }

  private rueckmeldungen: Rueckmeldung[] = [];
  private naechsteRueckmeldung = 1;
  private readonly fehler = new Map<string, Fehlerbericht>();
  private naechsterFehler = 1;

  putRueckmeldung(r: Omit<Rueckmeldung, 'id' | 'erledigt'>): number {
    const id = this.naechsteRueckmeldung++;
    this.rueckmeldungen.push({ ...r, id, erledigt: false });
    return id;
  }

  listRueckmeldungen(limit: number, nurOffene: boolean): Rueckmeldung[] {
    return this.rueckmeldungen
      .filter((r) => !nurOffene || !r.erledigt)
      .sort((a, b) => b.zeitMs - a.zeitMs || b.id - a.id)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  erledigeRueckmeldung(id: number, erledigt: boolean): boolean {
    const r = this.rueckmeldungen.find((x) => x.id === id);
    if (!r) return false;
    r.erledigt = erledigt;
    return true;
  }

  putFehler(f: Omit<Fehlerbericht, 'id' | 'anzahl' | 'zuerstMs'>): void {
    const alt = this.fehler.get(f.schluessel);
    if (alt) {
      alt.anzahl++;
      alt.zuletztMs = f.zuletztMs;
      if (f.konto) alt.konto = f.konto;
      if (f.version) alt.version = f.version;
      if (f.huelle) alt.huelle = f.huelle;
      if (f.regelwerk) alt.regelwerk = f.regelwerk;
      return;
    }
    this.fehler.set(f.schluessel, { ...f, id: this.naechsterFehler++, anzahl: 1, zuerstMs: f.zuletztMs });
  }

  listFehler(limit: number): Fehlerbericht[] {
    return [...this.fehler.values()]
      .sort((a, b) => b.zuletztMs - a.zuletztMs || b.id - a.id)
      .slice(0, limit)
      .map((f) => ({ ...f }));
  }

  dropFehler(id: number | 'alle'): number {
    if (id === 'alle') {
      const n = this.fehler.size;
      this.fehler.clear();
      return n;
    }
    for (const [k, f] of this.fehler) if (f.id === id) { this.fehler.delete(k); return 1; }
    return 0;
  }

  wipe(): void {
    this.accounts.clear();
    this.owners.clear();
    this.book.clear();
    this.pushAbos.clear();
    this.settlements = [];
    this.meta.clear();
    this.rueckmeldungen = [];
    this.fehler.clear();
    this.naechsteRueckmeldung = 1;
    this.naechsterFehler = 1;
  }

  getMeta(key: string): string | null {
    return this.meta.get(key) ?? null;
  }

  setMeta(key: string, value: string): void {
    this.meta.set(key, value);
  }

  close(): void {
  }
}
