/**
 * Das Command-Set (Architektur §2.1).
 *
 * Der Client schickt NIEMALS Zustand („ich habe 500 Gold"), sondern nur Absichten.
 * Diese Liste ist damit faktisch das Regelwerk des Spiels — was hier nicht steht,
 * kann ein Spieler nicht tun.
 *
 * Bemerkenswert kurz, und das ist der Punkt: Säen, Tiere versorgen, Mahlen,
 * Backen sind **ein** Commandpaar (`START` / `COLLECT`). Der Unterschied steckt
 * im Rezept, und Rezepte sind Daten (Konzept-Map, M1).
 */

export type CommandBase = {
  /** Lückenlos aufsteigend pro Spieler. Macht den Sync idempotent (§9). */
  seq: number;
  /** Spielzeit-Tick der Aktion. Wird gegen das Server-Zeitbudget geprüft (§4). */
  tick: number;
};

/**
 * Produktion auf einem Platz beginnen: Eingaben verbrauchen, Uhr starten.
 *
 * `recipe` muss auf der aktuellen AUSBAUSTUFE des Platzes erlaubt sein — welche
 * das sind, sagt das Regelwerk. Ein Feld nimmt Weizen, die Mühle mahlt Futter,
 * und ein Gehege legt erst Eier, wenn Hühner drin sind.
 */
export type StartCommand = CommandBase & { type: 'START'; plot: number; recipe: number };

/** Fertige Ausgabe abholen. Kein Platz im Lager → die Ware bleibt liegen (§7). */
export type CollectCommand = CommandBase & { type: 'COLLECT'; plot: number };

/**
 * Einen Platz eine Stufe weiter ausbauen: Kosten zahlen, dauerhaft mehr können.
 *
 * Ein Command für zwei sehr verschiedene Dinge im Spielgefühl — „Gehege kaufen"
 * und „Hühner kaufen" — und genau das ist der Punkt. Was eine Stufe kostet und
 * freischaltet, steht im Regelwerk; hier steht nur, dass bezahlt wird.
 */
export type BuyCommand = CommandBase & { type: 'BUY'; plot: number };

/** Verkauf an den NPC-Händler — offline gültig, da kein geteilter Zustand (§8). */
export type SellNpcCommand = CommandBase & { type: 'SELL_NPC'; item: number; amount: number };

/**
 * Ware zum Verkauf einstellen. Einseitig, also offline gültig (§8): Der Spieler
 * committet Ware, die er nachweislich hat. Sie verlässt sofort das Lager
 * (Escrow) — damit ist ein Doppelverkauf strukturell ausgeschlossen.
 */
export type ListOrderCommand = CommandBase & {
  type: 'LIST_ORDER';
  item: number;
  amount: number;
  price: number;
};

/** Auftrag zurückziehen. Die Ware geht zurück ins Lager, sofern Platz ist. */
export type CancelOrderCommand = CommandBase & { type: 'CANCEL_ORDER'; orderId: number };

/** Postfach leeren, soweit das Lager es hergibt (§7). */
export type CollectMailCommand = CommandBase & { type: 'COLLECT_MAIL' };

/**
 * Einen Kundenauftrag beliefern: Ware abgeben, Belohnung kassieren.
 *
 * Voll offline-fähig, obwohl Zufall dahintersteckt — der Server hat die
 * Aufträge vorgewürfelt und mit dem Snapshot mitgeschickt (§5). Der Client
 * verbraucht nur, was schon dasteht.
 */
export type FillRequestCommand = CommandBase & { type: 'FILL_REQUEST'; requestId: number };

export type Command =
  | StartCommand
  | CollectCommand
  | BuyCommand
  | SellNpcCommand
  | ListOrderCommand
  | CancelOrderCommand
  | CollectMailCommand
  | FillRequestCommand;

/** Gründe, aus denen die Sim eine Aktion ablehnt. Client und Server nutzen dieselben. */
export type SimErrorCode =
  | 'NO_SUCH_PLOT'
  | 'PLOT_LOCKED'
  | 'PLOT_BUSY'
  | 'PLOT_EMPTY'
  | 'MAX_LEVEL'
  | 'CANT_AFFORD'
  | 'PLAYER_LEVEL_TOO_LOW'
  | 'NOT_DONE'
  | 'RECIPE_NOT_ALLOWED'
  | 'NO_SUCH_ITEM'
  | 'NOT_SELLABLE'
  | 'NOT_TRADABLE'
  | 'SILO_FULL'
  | 'NOT_ENOUGH_ITEMS'
  | 'BAD_AMOUNT'
  | 'TIME_WENT_BACKWARDS'
  | 'UNKNOWN_COMMAND'
  | 'NO_ORDER_SLOTS'
  | 'PRICE_OUT_OF_BAND'
  | 'NO_SUCH_ORDER'
  | 'NOTHING_TO_COLLECT'
  | 'NO_SUCH_REQUEST'
  | 'REQUEST_NOT_ACTIVE';

export class SimError extends Error {
  code: SimErrorCode;
  constructor(code: SimErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'SimError';
    this.code = code;
  }
}
