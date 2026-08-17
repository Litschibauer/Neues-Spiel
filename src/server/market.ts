/**
 * Das Orderbuch (M5) — die erste Stelle, an der zwei Höfe einander begegnen.
 *
 * Bis hierhin war jeder Hof eine Insel: Alles, was ein Spieler tat, ließ sich
 * allein aus seinem eigenen Zustand nachrechnen. Genau deshalb funktionierte
 * das Spiel offline. Ein Markt bricht damit — und zwar unvermeidlich, denn zwei
 * Leute können dieselbe Kiste Eier wollen, und wer sie bekommt, entscheidet
 * sich nicht auf einem Handy (§8).
 *
 * ── Wo die Grenze verläuft ──────────────────────────────────────────────────
 *
 * Die Regel aus §6 ist hart: Was die geteilte Welt braucht, ist online-only und
 * wird ausgegraut. Beim Handel läuft die Grenze mitten hindurch, und sie liegt
 * nicht dort, wo man sie zuerst vermutet:
 *
 *  - **Einstellen ist einseitig** und damit offline gültig. Der Spieler
 *    committet Ware, die er nachweislich hat; sie verlässt sofort sein Lager.
 *    Niemand sonst ist daran beteiligt.
 *  - **Zurückziehen ist einseitig** — solange niemand gekauft hat. Hat jemand,
 *    gewinnt der Kauf: Er war zuerst da, in echter Zeit, mit einem Käufer, der
 *    bezahlt hat.
 *  - **Kaufen braucht Netz.** Nicht aus Bequemlichkeit, sondern weil es sonst
 *    keine Antwort auf „beide gleichzeitig" gäbe, die nicht Ware verdoppelt.
 *
 * ── Die Auslage statt des Katalogs ──────────────────────────────────────────
 *
 * Der Server legt jedem Hof eine Handvoll fremder Angebote in den Snapshot
 * (`state.offers`, gedeckelt durch `offerSlots`). Der Sim-Kern kann einen Kauf
 * damit ganz normal nachrechnen — Ware, Menge, Preis stehen ja da. Was er nicht
 * wissen kann, ist, ob das Angebot noch existiert; das entscheidet allein
 * dieses Modul, beim Sync, per `claim`.
 *
 * Verliert man das Rennen, ist der Kauf kein Regelverstoß, sondern Pech: Der
 * Server schneidet den Batch an dieser Stelle ab (`OFFER_GONE`), alles davor
 * bleibt bestehen. Dieselbe Präfix-Mechanik wie überall (§9).
 *
 * ── Speicherform ────────────────────────────────────────────────────────────
 *
 * Das Buch liegt im Speicher — es ist der heiße Pfad, und ein Kauf muss ohne
 * jede Wartezeit entschieden werden. Geschrieben wird in dieselbe
 * SQLite-Datei wie die Höfe (siehe `db.ts`), und zwar **gesammelt**: Vorher
 * wurde bei jedem einzelnen Sync das gesamte Buch neu auf die Platte gelegt,
 * was bei tausend Spielern tausendmal pro Sekunde dieselbe Datei bedeutet
 * hätte.
 *
 * Was NICHT warten darf, sind Abrechnungen: Ein Verkauf, der bei einem Absturz
 * verschwindet, bedeutet, dass der Käufer bezahlt hat und der Verkäufer nichts
 * bekommt. Der wird deshalb sofort geschrieben.
 */

import { getRuleset } from '../sim/rules.ts';
import { readMeta, transaction, writeMeta } from './db.ts';
import type { Db } from './db.ts';
import type { Offer, Order } from '../sim/state.ts';
import type { Server } from './server.ts';

/** Ein Angebot, wie es im Buch steht — mit allem, was der Sim-Kern nicht sieht. */
export type BookEntry = {
  /** Marktweit eindeutig. Nicht die Auftragsnummer des Verkäufers. */
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

/**
 * Was einem Verkäufer zusteht, der gerade nicht da war.
 *
 * Zwei Teile, und beide müssen sein: Der Auftrag muss aus seinem Zustand
 * verschwinden (die Ware ist weg), und das Geld muss ankommen. Beides passiert
 * bei seinem nächsten Sync — bis dahin liegt es hier.
 */
export type Settlement = {
  orderId: number;
  /** Erlös in Münzen, bereits ausgerechnet. */
  gold: number;
  soldMs: number;
};

export class Market {
  private readonly db: Db | null;
  private nextOfferId = 1;
  /** Nach Angebots-ID. Eine Map, weil `claim` der heiße Pfad ist. */
  private readonly book = new Map<number, BookEntry>();
  /** Verkäufer-ID → was ihm beim nächsten Sync zusteht. */
  private readonly settlements = new Map<string, Settlement[]>();
  /** Angebote, die seit dem letzten Schreiben entstanden oder verschwunden sind. */
  private readonly touched = new Set<number>();

  /**
   * `db === null` heißt: nur im Speicher. Für Tests — und dafür, dass ein
   * Markt ohne Schreibrechte nicht gleich beim Start umfällt.
   */
  constructor(db: Db | null) {
    this.db = db;
    if (db) this.load(db);
  }

  private load(db: Db): void {
    for (const row of db
      .prepare('select id, seller, order_id, item, amount, price, listed_ms from market_offers')
      .all() as Array<Record<string, number | string>>) {
      const entry: BookEntry = {
        id: Number(row.id),
        sellerId: String(row.seller),
        orderId: Number(row.order_id),
        item: Number(row.item),
        amount: Number(row.amount),
        price: Number(row.price),
        listedMs: Number(row.listed_ms),
      };
      this.book.set(entry.id, entry);
    }

    for (const row of db
      .prepare('select seller, order_id, gold, sold_ms from market_settlements')
      .all() as Array<Record<string, number | string>>) {
      const seller = String(row.seller);
      const list = this.settlements.get(seller) ?? [];
      list.push({ orderId: Number(row.order_id), gold: Number(row.gold), soldMs: Number(row.sold_ms) });
      this.settlements.set(seller, list);
    }

    this.nextOfferId = Number(readMeta(db, 'market.nextOfferId') ?? '1');
  }

  /**
   * Gemerkte Änderungen am Buch schreiben. Gibt zurück, wie viele.
   *
   * Abrechnungen sind hier NICHT dabei — die gehen sofort raus (siehe `claim`).
   * Ein verlorenes Angebot kostet den Verkäufer eine Neueinstellung; eine
   * verlorene Abrechnung kostet ihn sein Geld.
   */
  flush(): number {
    if (!this.db || this.touched.size === 0) return 0;
    const ids = [...this.touched];
    const db = this.db;
    transaction(db, () => {
      const del = db.prepare('delete from market_offers where id = ?');
      const put = db.prepare(
        `insert into market_offers (id, seller, order_id, item, amount, price, listed_ms)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set amount = excluded.amount, price = excluded.price`,
      );
      for (const id of ids) {
        const entry = this.book.get(id);
        if (!entry) del.run(id);
        else {
          put.run(
            entry.id,
            entry.sellerId,
            entry.orderId,
            entry.item,
            entry.amount,
            entry.price,
            entry.listedMs,
          );
        }
      }
      writeMeta(db, 'market.nextOfferId', String(this.nextOfferId));
    });
    this.touched.clear();
    return ids.length;
  }

  get size(): number {
    return this.book.size;
  }

  entries(): BookEntry[] {
    return [...this.book.values()];
  }

  /**
   * Das Buch mit den Aufträgen eines Hofes abgleichen.
   *
   * Aufgerufen nach jedem Sync dieses Hofes, mit dem, was danach wirklich in
   * seinem Escrow liegt. Zwei Richtungen:
   *
   *  - Was neu im Escrow ist, kommt ins Buch — auch wenn es offline eingestellt
   *    wurde. Genau das macht „Einstellen geht offline" zu mehr als einer
   *    Behauptung.
   *  - Was aus dem Escrow verschwunden ist (zurückgezogen oder verfallen), muss
   *    aus dem Buch. Sonst könnte jemand etwas kaufen, das es nicht mehr gibt.
   *
   * Der Abgleich statt zweier Einzelaufrufe ist Absicht: Er hat kein Gedächtnis
   * und kann deshalb nicht aus dem Tritt geraten. Was im Escrow liegt, ist die
   * Wahrheit; das Buch folgt.
   */
  reconcile(sellerId: string, orders: readonly Order[], nowMs: number): void {
    const live = new Set(orders.map((o) => o.id));

    for (const entry of [...this.book.values()]) {
      if (entry.sellerId === sellerId && !live.has(entry.orderId)) {
        this.book.delete(entry.id);
        this.touched.add(entry.id);
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
  }

  /**
   * Die Auslage für einen bestimmten Hof.
   *
   * Eigene Angebote bleiben draußen. Das ist keine Kosmetik: Damit muss der
   * Sim-Kern nie prüfen, ob jemand von sich selbst kauft — und kennt weiterhin
   * keine Spieler, sondern nur Zahlen.
   *
   * Sortiert nach Stückpreis, günstigstes zuerst; bei Gleichstand nach Alter.
   * Eine feste Reihenfolge ist wichtiger, als sie scheint: Ohne sie hinge der
   * Snapshot an der Einfügereihenfolge einer Map.
   */
  browse(viewerId: string, limit: number): Offer[] {
    const visible = [...this.book.values()].filter((e) => e.sellerId !== viewerId);
    visible.sort((a, b) => a.price - b.price || a.listedMs - b.listedMs || a.id - b.id);
    return visible
      .slice(0, limit)
      .map((e) => ({ id: e.id, item: e.item, amount: e.amount, price: e.price }));
  }

  /**
   * Ein Angebot für sich beanspruchen — der Moment, in dem der Markt entscheidet.
   *
   * Genau hier wird aus „zwei wollen dasselbe" ein Gewinner. Der Aufruf ist
   * bewusst winzig und synchron: Zwischen Prüfen und Entfernen darf nichts
   * liegen, sonst hätte man das Rennen nur verschoben. Node ist einfädig, also
   * genügt das — bei mehreren Prozessen müsste die Serialisierung woanders
   * hin, und das steht in der Roadmap.
   *
   * `null` heißt: zu spät.
   */
  claim(offerId: number, buyerId: string, nowMs: number): BookEntry | null {
    const entry = this.book.get(offerId);
    if (!entry) return null;
    // Auch das noch prüfen: Ein Hof, der sein eigenes Angebot kauft, würde sich
    // selbst Gold überweisen und die Ware zurückbekommen — eine Geldpresse.
    if (entry.sellerId === buyerId) return null;

    this.book.delete(offerId);
    this.touched.add(offerId);

    const settlement: Settlement = {
      orderId: entry.orderId,
      gold: entry.amount * entry.price,
      soldMs: nowMs,
    };
    const list = this.settlements.get(entry.sellerId) ?? [];
    list.push(settlement);
    this.settlements.set(entry.sellerId, list);

    // SOFORT schreiben, nicht sammeln. Ein Verkauf, der bei einem Absturz
    // verschwindet, heißt: Der Käufer hat bezahlt, der Verkäufer bekommt
    // nichts. Das ist der eine Fall im Markt, der keine Verzögerung verträgt.
    if (this.db) {
      const db = this.db;
      transaction(db, () => {
        db.prepare('delete from market_offers where id = ?').run(offerId);
        db.prepare(
          'insert into market_settlements (seller, order_id, gold, sold_ms) values (?, ?, ?, ?)',
        ).run(entry.sellerId, settlement.orderId, settlement.gold, settlement.soldMs);
      });
      this.touched.delete(offerId);
    }
    return entry;
  }

  /** Was diesem Verkäufer zusteht — und nimmt es aus dem Buch heraus. */
  takeSettlements(sellerId: string): Settlement[] {
    const list = this.settlements.get(sellerId);
    if (!list || list.length === 0) return [];
    this.settlements.delete(sellerId);
    if (this.db) {
      this.db.prepare('delete from market_settlements where seller = ?').run(sellerId);
    }
    return list;
  }

  /** Nur zum Nachsehen, ohne zu entnehmen. */
  peekSettlements(sellerId: string): readonly Settlement[] {
    return this.settlements.get(sellerId) ?? [];
  }

  /** Alles zu einem Hof löschen — beim Zurücksetzen im Feldtest. */
  forget(sellerId: string): void {
    for (const entry of [...this.book.values()]) {
      if (entry.sellerId === sellerId) {
        this.book.delete(entry.id);
        this.touched.add(entry.id);
      }
    }
    this.settlements.delete(sellerId);
    if (this.db) {
      this.db.prepare('delete from market_settlements where seller = ?').run(sellerId);
    }
  }
}

/**
 * Markt und Spielstand verdrahten.
 *
 * Der `Server` kennt bewusst keine Accounts — er rechnet einen Spielstand nach,
 * mehr nicht. Diese drei Funktionen sind die ganze Naht dazwischen, und sie
 * stehen hier statt in der HTTP-Schicht, damit die Tests genau das prüfen, was
 * im Betrieb läuft, und nicht eine Kopie davon.
 *
 * `liveGame` liefert den Spielstand eines anderen Hofes, falls er gerade
 * geladen ist. Ist er es nicht, bleibt die Abrechnung im Markt liegen und wird
 * bei seinem nächsten Zugriff eingelöst — das ist der Normalfall, denn der
 * Verkäufer schläft üblicherweise.
 */
export function connectMarket(
  market: Market,
  accountId: string,
  game: Server,
  liveGame: (id: string) => Server | null = () => null,
): void {
  game.offerSource = (limit) => market.browse(accountId, limit);
  game.claimOffer = (offerId) => {
    const entry = market.claim(offerId, accountId, Date.now());
    if (!entry) return false;
    const seller = liveGame(entry.sellerId);
    if (seller) settleSales(market, entry.sellerId, seller);
    return true;
  };
}

/**
 * Offene Verkäufe eines Hofes in seinen Spielstand einlösen.
 *
 * Vor jedem Blick auf den eigenen Hof aufzurufen — vor dem Zustand wie vor dem
 * Sync. Vor dem Sync ist es sogar zwingend: Ein Verkauf, der während der
 * Abwesenheit stattfand, muss VOR der Re-Simulation stehen, sonst holt ein
 * offline zurückgezogener Auftrag dieselbe Ware ein zweites Mal ins Lager.
 */
export function settleSales(market: Market, accountId: string, game: Server): boolean {
  const due = market.takeSettlements(accountId);
  if (due.length === 0) return false;
  const currency = getRuleset(game.snapshot.rulesetVersion).currency;
  for (const sale of due) game.applySale(sale.orderId, sale.gold, sale.soldMs, currency);
  return true;
}

/** Nach jedem Sync: Was im Escrow liegt, ist die Wahrheit — das Buch zieht nach. */
export function publishOrders(market: Market, accountId: string, game: Server): void {
  market.reconcile(accountId, game.snapshot.state.orders, Date.now());
}
