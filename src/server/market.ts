import { getRuleset } from '../sim/rules.ts';
import type { BookEntry, Settlement, Storage } from './storage.ts';
export type { BookEntry, Settlement } from './storage.ts';
import type { Offer, Order } from '../sim/state.ts';
import type { Server } from './server.ts';

export const ZEITUNG_HOEFE = 6;

function mische(text: string, salz: number): number {
  let h = 2166136261 ^ salz;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1_000_003;
}

export function hofNummer(sellerId: string): number {
  return mische(sellerId, 0) % 4096;
}

export class Market {
  private readonly store: Storage | null;
  private nextOfferId = 1;

  private readonly book = new Map<number, BookEntry>();

  private readonly settlements = new Map<string, Settlement[]>();

  private readonly touched = new Set<number>();

  private readonly ausgaben = new Map<string, string[]>();

  private readonly nonce = new Map<string, number>();

  private readonly runde = new Map<string, number>();

  private rundeNr = 1;

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
    const offen = orders.filter((o) => o.verkauft <= 0);
    const live = new Set(offen.map((o) => o.id));
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

    for (const order of offen) {
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

  neueAusgabe(viewerId: string): void {
    this.ausgaben.delete(viewerId);
    this.nonce.set(viewerId, (this.nonce.get(viewerId) ?? 0) + 1);
  }

  private mischen(liste: string[], saat: number): string[] {
    const out = [...liste];
    let z = saat >>> 0;
    for (let i = out.length - 1; i > 0; i--) {
      z = (Math.imul(z, 1103515245) + 12345) >>> 0;
      const j = z % (i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  private waehleHoefe(viewerId: string, verfuegbar: string[]): string[] {
    const wieviele = Math.min(ZEITUNG_HOEFE, verfuegbar.length);
    const alt = this.ausgaben.get(viewerId);
    if (alt) {
      const noch = alt.filter((id) => verfuegbar.includes(id));
      if (noch.length >= wieviele) return noch;
    }

    const saat = mische(viewerId, this.nonce.get(viewerId) ?? 0);
    let topf = this.mischen(
      verfuegbar.filter((id) => (this.runde.get(id) ?? 0) < this.rundeNr),
      saat,
    );

    if (topf.length < wieviele) {
      this.rundeNr++;
      const drin = new Set(topf);
      topf = topf.concat(this.mischen(verfuegbar.filter((id) => !drin.has(id)), saat + 1));
    }

    const gewaehlt = topf.slice(0, wieviele);
    for (const id of gewaehlt) this.runde.set(id, this.rundeNr);
    this.ausgaben.set(viewerId, gewaehlt);
    return gewaehlt;
  }

  browse(viewerId: string, limit: number): Offer[] {
    const hoefe = new Map<string, BookEntry[]>();
    for (const e of this.book.values()) {
      if (e.sellerId === viewerId) continue;
      const list = hoefe.get(e.sellerId) ?? [];
      list.push(e);
      hoefe.set(e.sellerId, list);
    }

    const gewaehlt = this.waehleHoefe(viewerId, [...hoefe.keys()]);
    const ausgabe = this.nonce.get(viewerId) ?? 0;

    const shelf: Offer[] = [];
    const vergeben = new Set<number>();
    for (const sellerId of gewaehlt) {
      const eintraege = hoefe.get(sellerId);
      if (!eintraege || shelf.length >= limit) continue;
      eintraege.sort((a, b) => a.listedMs - b.listedMs || a.id - b.id);
      const platz = limit - shelf.length;
      let seller = hofNummer(sellerId);
      while (vergeben.has(seller)) seller = (seller + 1) % 4096;
      vergeben.add(seller);
      const aushang = eintraege[mische(sellerId, ausgabe) % eintraege.length]!;
      for (const e of eintraege.slice(0, platz)) {
        shelf.push({
          id: e.id,
          item: e.item,
          amount: e.amount,
          price: e.price,
          seller,
          headline: e.id === aushang.id,
        });
      }
      if (!shelf.some((o) => o.seller === seller && o.headline)) {
        const ersatz = shelf.findIndex((o) => o.seller === seller);
        if (ersatz >= 0) shelf[ersatz] = { ...shelf[ersatz]!, headline: true };
      }
    }
    return shelf;
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
    this.runde.delete(sellerId);
    this.ausgaben.delete(sellerId);
    this.nonce.delete(sellerId);
    for (const [wer, hoefe] of this.ausgaben) {
      if (hoefe.includes(sellerId)) this.ausgaben.delete(wer);
    }
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
