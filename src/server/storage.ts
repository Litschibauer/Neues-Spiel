import { randomUUID } from 'node:crypto';
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
};

export type GameBlob = {
  snapshot: Snapshot;
  appliedLog: Command[];
  logStartSeq?: number;
  pendingDeliveries: MailItem[];
  targetRulesetVersion: number;
  nextRequestId: number;
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

  getMeta(key: string): string | null {
    return this.meta.get(key) ?? null;
  }

  setMeta(key: string, value: string): void {
    this.meta.set(key, value);
  }

  close(): void {
  }
}
