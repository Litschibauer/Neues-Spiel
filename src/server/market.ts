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
import type { BookEntry, Settlement, Storage } from './storage.ts';
export type { BookEntry, Settlement } from './storage.ts';
import type { Offer, Order } from '../sim/state.ts';
import type { Server } from './server.ts';

export class Market {
  private readonly store: Storage | null;
  private nextOfferId = 1;
  /**
   * Das Buch im Speicher — als **Auslage**, nicht als Wahrheit.
   *
   * Gelesen wird daraus (Stöbern ist der häufigste Zugriff und soll nichts
   * kosten), entschieden wird im Speicher: `claimOffer` ist dort ein einziger
   * atomarer Griff. Damit hängt die Frage „wer bekommt die Ware" nicht daran,
   * dass genau ein Prozess läuft.
   */
  private readonly book = new Map<number, BookEntry>();
  /** Verkäufer-ID → was ihm beim nächsten Sync zusteht. */
  private readonly settlements = new Map<string, Settlement[]>();
  /** Angebote, die seit dem letzten Schreiben entstanden oder verschwunden sind. */
  private readonly touched = new Set<number>();

  /**
   * `store === null` heißt: nur im Speicher, ohne Dauerhaftigkeit. Für Tests —
   * und dafür, dass ein Markt ohne Schreibrechte nicht beim Start umfällt.
   */
  constructor(store: Storage | null) {
    // `undefined` ist KEIN gültiger Wert, und die Prüfung ist keine Pedanterie:
    // Genau so ist der Markt in einer Messung still in den Nur-Speicher-Betrieb
    // gefallen — ein vertippter Zugriff lieferte `undefined`, `if (store)` war
    // falsch, und niemand hat es gemerkt. In Produktion hieße das: eingestellte
    // Angebote überleben keinen Neustart, und man erfährt es vom Spieler.
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

  /**
   * Gemerkte Änderungen am Buch schreiben. Gibt zurück, wie viele.
   *
   * Abrechnungen sind hier NICHT dabei — die schreibt der Speicher schon beim
   * Kauf, im selben Griff. Ein verlorenes Angebot kostet den Verkäufer eine
   * Neueinstellung; eine verlorene Abrechnung kostet ihn sein Geld.
   */
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

    // SOFORT durchschreiben, nicht sammeln.
    //
    // Seit der Kauf im Speicher entschieden wird (`claimOffer`), ist die
    // Auslage im Arbeitsspeicher nur noch ein Schaufenster — maßgeblich ist,
    // was in der Datenbank steht. Ein Angebot, das erst zwei Sekunden später
    // dort ankommt, wäre für den Käufer sichtbar und trotzdem nicht kaufbar:
    // Er bekäme `OFFER_GONE` auf etwas, das gerade erst eingestellt wurde.
    //
    // Teuer ist das nicht: Geschrieben wird nur, wenn sich wirklich etwas
    // geändert hat, und das passiert beim Einstellen und Zurückziehen — nicht
    // bei jedem Sync.
    this.flush();
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
    // Ohne Speicher (Tests) entscheidet die Auslage selbst.
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

    // Mit Speicher entscheidet DER — in einem Griff, samt Abrechnung. Die
    // Auslage zieht danach nur nach.
    const entry = this.store.claimOffer(offerId, buyerId, nowMs);
    if (!entry) {
      // Auch ein Fehlschlag ist eine Information: Das Angebot ist weg, die
      // Auslage weiß es nur noch nicht.
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

  /** Was diesem Verkäufer zusteht — und nimmt es aus dem Buch heraus. */
  takeSettlements(sellerId: string): Settlement[] {
    const list = this.settlements.get(sellerId);
    if (!list || list.length === 0) return [];
    this.settlements.delete(sellerId);
    this.store?.takeSettlements(sellerId);
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
    this.store?.forgetSeller(sellerId);
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
