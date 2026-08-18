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
 * Kauf beim NPC-Händler — die Gegenrichtung, und ebenso offline gültig.
 *
 * Es gibt ihn, seit Saatgut verbraucht wird: Wer seinen letzten Weizen
 * verkauft, säen kann er dann nicht mehr, und ohne Händler wäre der Hof
 * endgültig tot. Genau der Sackgassen-Zustand, den §6 verbietet.
 *
 * Der Händler verlangt mehr, als er zahlt — sonst wäre er eine Geldpresse.
 * `validateRuleset` erzwingt das, damit es kein Balancing-Versehen werden kann.
 */
export type BuyNpcCommand = CommandBase & { type: 'BUY_NPC'; item: number; amount: number };

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

/**
 * Ein fremdes Angebot kaufen (M5) — **das einzige Command, das Netz braucht.**
 *
 * Alles andere in dieser Liste ist einseitig: Der Spieler greift nur auf seinen
 * eigenen Hof zu, und der Server kann es hinterher nachrechnen. Ein Kauf nicht.
 * Zwei Leute können dasselbe Angebot wollen, und wer es bekommt, entscheidet
 * sich nicht auf einem Gerät (§8).
 *
 * Deshalb steht es hier trotzdem und nicht in einer eigenen Schnittstelle: Die
 * Bedingungen — Ware, Menge, Preis — liegen als Angebot im Zustand, also kann
 * der Kern den Kauf ganz normal nachrechnen. Was er nicht wissen kann, ist, ob
 * das Angebot noch da ist. Das prüft der Server beim Sync und schneidet den
 * Batch ab, wenn es weg ist (`OFFER_GONE`) — dieselbe Präfix-Mechanik wie bei
 * jedem anderen abgelehnten Command.
 *
 * Für den Spieler heißt das: Der Kaufknopf ist ohne Verbindung ausgegraut, und
 * der Client synct sofort danach, damit das Zeitfenster eine Rundreise bleibt.
 */
export type BuyOfferCommand = CommandBase & { type: 'BUY_OFFER'; offerId: number };

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

/**
 * Einen Kundenauftrag wegschicken, ohne ihn zu erfüllen.
 *
 * Offline gültig, obwohl Aufträge aus dem Zufall kommen: Der Ersatz steht
 * schon im Vorrat (§5). Übersprungen wird nur nach vorn gerückt, nicht neu
 * gewürfelt — der Client bräuchte sonst einen Würfel, und genau den soll er
 * nicht haben.
 *
 * Bezahlt wird mit Wartezeit statt mit Geld: `requestSkipCooldownTicks`. Eine
 * Gebühr träfe den Falschen — wer wenig hat, säße seinen schlechten Auftrag ab,
 * wer viel hat, kaufte sich die perfekte Auslage.
 */
export type SkipRequestCommand = CommandBase & { type: 'SKIP_REQUEST'; requestId: number };

export type Command =
  | StartCommand
  | CollectCommand
  | BuyCommand
  | SellNpcCommand
  | BuyNpcCommand
  | ListOrderCommand
  | CancelOrderCommand
  | BuyOfferCommand
  | CollectMailCommand
  | FillRequestCommand
  | SkipRequestCommand;

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
  /** Der Händler führt das nicht. */
  | 'NOT_BUYABLE'
  | 'NOT_TRADABLE'
  | 'SILO_FULL'
  | 'NOT_ENOUGH_ITEMS'
  | 'BAD_AMOUNT'
  | 'TIME_WENT_BACKWARDS'
  | 'UNKNOWN_COMMAND'
  | 'NO_ORDER_SLOTS'
  | 'PRICE_OUT_OF_BAND'
  | 'NO_SUCH_ORDER'
  | 'NO_SUCH_OFFER'
  /**
   * Jemand anders war schneller (M5). Kein Regelverstoß, sondern die geteilte
   * Welt — der Server vergibt diesen Code, nie der Kern.
   */
  | 'OFFER_GONE'
  | 'NOTHING_TO_COLLECT'
  | 'NO_SUCH_REQUEST'
  | 'REQUEST_NOT_ACTIVE'
  /** Der letzte übersprungene Auftrag ist noch zu frisch. */
  | 'SKIP_ON_COOLDOWN'
  /** Das Regelwerk erlaubt Überspringen gar nicht. */
  | 'SKIP_DISABLED';

export class SimError extends Error {
  code: SimErrorCode;
  constructor(code: SimErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'SimError';
    this.code = code;
  }
}
