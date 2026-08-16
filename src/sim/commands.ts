/**
 * Das Command-Set (Architektur §2.1).
 *
 * Der Client schickt NIEMALS Zustand („ich habe 500 Gold"), sondern nur Absichten.
 * Diese Liste ist damit faktisch das Regelwerk des Spiels — was hier nicht steht,
 * kann ein Spieler nicht tun.
 */

export type CommandBase = {
  /** Lückenlos aufsteigend pro Spieler. Macht den Sync idempotent (§9). */
  seq: number;
  /** Spielzeit-Tick der Aktion. Wird gegen das Server-Zeitbudget geprüft (§4). */
  tick: number;
};

export type PlantCommand = CommandBase & { type: 'PLANT'; field: number };
export type HarvestCommand = CommandBase & { type: 'HARVEST'; field: number };
/** Verkauf an den NPC-Händler — offline gültig, da kein geteilter Zustand (§8). */
export type SellNpcCommand = CommandBase & {
  type: 'SELL_NPC';
  item: 'wheat' | 'eggs';
  amount: number;
};

/**
 * Ware zum Verkauf einstellen. Einseitig, also offline gültig (§8): Der Spieler
 * committet Ware, die er nachweislich hat. Sie verlässt sofort das Lager
 * (Escrow) — damit ist ein Doppelverkauf strukturell ausgeschlossen.
 */
export type ListOrderCommand = CommandBase & {
  type: 'LIST_ORDER';
  item: 'wheat' | 'eggs';
  amount: number;
  price: number;
};

/** Auftrag zurückziehen. Die Ware geht zurück ins Lager, sofern Platz ist. */
export type CancelOrderCommand = CommandBase & { type: 'CANCEL_ORDER'; orderId: number };

/** Postfach leeren, soweit das Lager es hergibt (§7). */
export type CollectMailCommand = CommandBase & { type: 'COLLECT_MAIL' };

export type Command =
  | PlantCommand
  | HarvestCommand
  | SellNpcCommand
  | ListOrderCommand
  | CancelOrderCommand
  | CollectMailCommand;

/** Gründe, aus denen die Sim eine Aktion ablehnt. Client und Server nutzen dieselben. */
export type SimErrorCode =
  | 'NO_SUCH_FIELD'
  | 'FIELD_OCCUPIED'
  | 'FIELD_EMPTY'
  | 'NOT_RIPE'
  | 'SILO_FULL'
  | 'NOT_ENOUGH_ITEMS'
  | 'BAD_AMOUNT'
  | 'TIME_WENT_BACKWARDS'
  | 'UNKNOWN_COMMAND'
  | 'NO_ORDER_SLOTS'
  | 'PRICE_OUT_OF_BAND'
  | 'NO_SUCH_ORDER'
  | 'NOTHING_TO_COLLECT';

export class SimError extends Error {
  code: SimErrorCode;
  constructor(code: SimErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'SimError';
    this.code = code;
  }
}
