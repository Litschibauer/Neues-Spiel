import { getRuleset } from '../sim/rules.ts';
import type { BookEntry, Settlement, Storage } from './storage.ts';
export type { BookEntry, Settlement } from './storage.ts';
import type { Offer, Order } from '../sim/state.ts';
import type { Server } from './server.ts';

export class Market {
  private readonly store: Storage | null;
  private nextOfferId = 1;

  private readonly book = new Map<number, BookEntry>();

  private readonly settlements = new Map<string, Settlement[]>();

  private readonly touched = new Set<number>();

  constructor(store: Storage | null) {
    if (store === undefined) {
      throw new TypeError('Market braucht einen Storage oder ausdrücklich null');
    }
    this.store = store;
    if (store) this.load(store);
  }

  private load(store: Storage): void {
    for (const entry of store.loadBook()) this.book.set(entry.id, entry);
    for (const s of store.loadSettlements()) {
      const list = this.settlements.get(s.sellerId) ?? [];
      list.push(s);
      this.settlements.set(s.sellerId, list);
    }
    this.nextOfferId = Number(store.getMeta('market.nextOfferId') ?? '1');
  }

  flush(): number {
    if (!this.store || this.touched.size === 0) return 0;
    const upserts: BookEntry[] = [];
    const removed: number[] = [];
    for (const id of this.touched) {
      const entry = this.book.get(id);
      if (entry) upserts.push(entry);
      else removed.push(id);
    }
    this.store.putOffers(upserts, removed);
    this.store.setMeta('market.nextOfferId', String(this.nextOfferId));
    const n = this.touched.size;
    this.touched.clear();
    return n;
  }

  get size(): number {
    return this.book.size;
  }

  entries(): BookEntry[] {
    return [...this.book.values()];
  }

  reconcile(sellerId: string, orders: readonly Order[], nowMs: number): boolean {
    const live = new Set(orders.map((o) => o.id));
    let changed = false;

    for (const entry of [...this.book.values()]) {
      if (entry.sellerId === sellerId && !live.has(entry.orderId)) {
        this.book.delete(entry.id);
        this.touched.add(entry.id);
        changed = true;
      }
    }

    const known = new Set<number>();
    for (const entry of this.book.values()) {
      if (entry.sellerId === sellerId) known.add(entry.orderId);
    }

    for (const order of orders) {
      if (known.has(order.id)) continue;
      const id = this.nextOfferId++;
      this.touched.add(id);
      changed = true;
      this.book.set(id, {
        id,
        sellerId,
        orderId: order.id,
        item: order.item,
        amount: order.amount,
        price: order.price,
        listedMs: nowMs,
      });
    }

    this.flush();
    return changed;
  }

  browse(viewerId: string, limit: number): Offer[] {
    const visible = [...this.book.values()].filter((e) => e.sellerId !== viewerId);
    visible.sort((a, b) => a.price - b.price || a.listedMs - b.listedMs || a.id - b.id);
    return visible
      .slice(0, limit)
      .map((e) => ({ id: e.id, item: e.item, amount: e.amount, price: e.price }));
  }

  claim(offerId: number, buyerId: string, nowMs: number): BookEntry | null {
    if (!this.store) {
      const entry = this.book.get(offerId);
      if (!entry || entry.sellerId === buyerId) return null;
      this.book.delete(offerId);
      this.touched.add(offerId);
      const list = this.settlements.get(entry.sellerId) ?? [];
      list.push({
        sellerId: entry.sellerId,
        orderId: entry.orderId,
        gold: entry.amount * entry.price,
        soldMs: nowMs,
      });
      this.settlements.set(entry.sellerId, list);
      return entry;
    }

    const entry = this.store.claimOffer(offerId, buyerId, nowMs);
    if (!entry) {
      if (this.book.delete(offerId)) this.touched.delete(offerId);
      return null;
    }

    this.book.delete(offerId);
    this.touched.delete(offerId);
    const list = this.settlements.get(entry.sellerId) ?? [];
    list.push({
      sellerId: entry.sellerId,
      orderId: entry.orderId,
      gold: entry.amount * entry.price,
      soldMs: nowMs,
    });
    this.settlements.set(entry.sellerId, list);
    return entry;
  }

  takeSettlements(sellerId: string): Settlement[] {
    const list = this.settlements.get(sellerId);
    if (!list || list.length === 0) return [];
    this.settlements.delete(sellerId);
    this.store?.takeSettlements(sellerId);
    return list;
  }

  peekSettlements(sellerId: string): readonly Settlement[] {
    return this.settlements.get(sellerId) ?? [];
  }

  forget(sellerId: string): void {
    for (const entry of [...this.book.values()]) {
      if (entry.sellerId === sellerId) {
        this.book.delete(entry.id);
        this.touched.add(entry.id);
      }
    }
    this.settlements.delete(sellerId);
    this.store?.forgetSeller(sellerId);
  }
}

export function connectMarket(
  market: Market,
  accountId: string,
  game: Server,
  liveGame: (id: string) => Server | null = () => null,
  onSold: (sellerId: string) => void = () => {},
): void {
  game.offerSource = (limit) => market.browse(accountId, limit);
  game.claimOffer = (offerId) => {
    const entry = market.claim(offerId, accountId, Date.now());
    if (!entry) return false;
    const seller = liveGame(entry.sellerId);
    if (seller) settleSales(market, entry.sellerId, seller);
    onSold(entry.sellerId);
    return true;
  };
}

export function settleSales(market: Market, accountId: string, game: Server): boolean {
  const due = market.takeSettlements(accountId);
  if (due.length === 0) return false;
  const currency = getRuleset(game.snapshot.rulesetVersion).currency;
  for (const sale of due) game.applySale(sale.orderId, sale.gold, sale.soldMs, currency);
  return true;
}

export function publishOrders(market: Market, accountId: string, game: Server): boolean {
  return market.reconcile(accountId, game.snapshot.state.orders, Date.now());
}
