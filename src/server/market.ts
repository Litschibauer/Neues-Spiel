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
 * ── Warum keine Datenbank ───────────────────────────────────────────────────
 *
 * Weil der ganze Markt in den Speicher passt, solange es ein paar hundert Höfe
 * sind, und weil eine Datei atomar zu schreiben ist. Ab Zehntausenden gehört
 * hier etwas anderes hin — dann aber zusammen mit den Accounts, nicht einzeln.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { getRuleset } from '../sim/rules.ts';
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

type MarketFile = {
  version: 1;
  nextOfferId: number;
  book: BookEntry[];
  settlements: Record<string, Settlement[]>;
};

export class Market {
  private readonly path: string | null;
  private nextOfferId = 1;
  /** Nach Angebots-ID. Eine Map, weil `claim` der heiße Pfad ist. */
  private readonly book = new Map<number, BookEntry>();
  /** Verkäufer-ID → was ihm beim nächsten Sync zusteht. */
  private readonly settlements = new Map<string, Settlement[]>();

  /**
   * `path === null` heißt: nur im Speicher. Für Tests — und dafür, dass der
   * Markt in einem Prozess ohne Schreibrechte nicht gleich beim Start umfällt.
   */
  constructor(path: string | null) {
    this.path = path;
    if (path && existsSync(path)) this.load(path);
  }

  private load(path: string): void {
    try {
      const file = JSON.parse(readFileSync(path, 'utf8')) as MarketFile;
      if (file.version !== 1) return;
      this.nextOfferId = file.nextOfferId;
      for (const entry of file.book) this.book.set(entry.id, entry);
      for (const [id, list] of Object.entries(file.settlements ?? {})) {
        this.settlements.set(id, list);
      }
    } catch {
      // Ein unlesbares Buch darf den Server nicht am Start hindern. Es kostet
      // die offenen Angebote — die Ware selbst liegt weiter im Escrow der
      // Verkäufer und kommt beim nächsten Sync zurück ins Buch.
      console.error(`Markt-Datei unlesbar, starte mit leerem Buch: ${path}`);
    }
  }

  save(): void {
    if (!this.path) return;
    const data: MarketFile = {
      version: 1,
      nextOfferId: this.nextOfferId,
      book: [...this.book.values()],
      settlements: Object.fromEntries(this.settlements),
    };
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.path);
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
      if (entry.sellerId === sellerId && !live.has(entry.orderId)) this.book.delete(entry.id);
    }

    const known = new Set<number>();
    for (const entry of this.book.values()) {
      if (entry.sellerId === sellerId) known.add(entry.orderId);
    }

    for (const order of orders) {
      if (known.has(order.id)) continue;
      const id = this.nextOfferId++;
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
    const list = this.settlements.get(entry.sellerId) ?? [];
    list.push({ orderId: entry.orderId, gold: entry.amount * entry.price, soldMs: nowMs });
    this.settlements.set(entry.sellerId, list);
    return entry;
  }

  /** Was diesem Verkäufer zusteht — und nimmt es aus dem Buch heraus. */
  takeSettlements(sellerId: string): Settlement[] {
    const list = this.settlements.get(sellerId);
    if (!list || list.length === 0) return [];
    this.settlements.delete(sellerId);
    return list;
  }

  /** Nur zum Nachsehen, ohne zu entnehmen. */
  peekSettlements(sellerId: string): readonly Settlement[] {
    return this.settlements.get(sellerId) ?? [];
  }

  /** Alles zu einem Hof löschen — beim Zurücksetzen im Feldtest. */
  forget(sellerId: string): void {
    for (const entry of [...this.book.values()]) {
      if (entry.sellerId === sellerId) this.book.delete(entry.id);
    }
    this.settlements.delete(sellerId);
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
