export type CommandBase = {
  seq: number;
  tick: number;
};

export type StartCommand = CommandBase & {
  type: 'START';
  plot: number;
  recipe: number;
  slot?: number;
};

export type CollectCommand = CommandBase & { type: 'COLLECT'; plot: number; slot?: number };

export type BuyCommand = CommandBase & { type: 'BUY'; plot: number };

export type SellNpcCommand = CommandBase & { type: 'SELL_NPC'; item: number; amount: number };

export type BuyNpcCommand = CommandBase & { type: 'BUY_NPC'; item: number; amount: number };

export type ListOrderCommand = CommandBase & {
  type: 'LIST_ORDER';
  item: number;
  amount: number;
  price: number;
};

export type CancelOrderCommand = CommandBase & { type: 'CANCEL_ORDER'; orderId: number };

export type BuyOfferCommand = CommandBase & { type: 'BUY_OFFER'; offerId: number };

export type CollectMailCommand = CommandBase & { type: 'COLLECT_MAIL' };

export type FillRequestCommand = CommandBase & { type: 'FILL_REQUEST'; requestId: number };

export type SkipRequestCommand = CommandBase & { type: 'SKIP_REQUEST'; requestId: number };

export type LoadTruckCommand = CommandBase & {
  type: 'LOAD_TRUCK';
  stack: number;
  amount: number;
};

export type SendTruckCommand = CommandBase & { type: 'SEND_TRUCK' };

export type SendSlipCommand = CommandBase & { type: 'SEND_SLIP'; slot: number };

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
  | SkipRequestCommand
  | LoadTruckCommand
  | SendTruckCommand
  | SendSlipCommand;

export type SimErrorCode =
  | 'NO_SUCH_PLOT'
  | 'TRUCK_DISABLED'
  | 'NO_SUCH_SLIP'
  | 'USE_THE_BOARD'
  | 'NPC_DISABLED'
  | 'ONLY_WHEN_EMPTY'
  | 'TRUCK_AWAY'
  | 'NO_WAYBILL'
  | 'NO_SUCH_STACK'
  | 'TRUCK_NOT_FULL'
  | 'TOO_MUCH'
  | 'NO_SUCH_SLOT'
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
  | 'OFFER_GONE'
  | 'NOTHING_TO_COLLECT'
  | 'NO_SUCH_REQUEST'
  | 'REQUEST_NOT_ACTIVE'
  | 'SKIP_ON_COOLDOWN'
  | 'SKIP_DISABLED';

export class SimError extends Error {
  code: SimErrorCode;
  constructor(code: SimErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'SimError';
    this.code = code;
  }
}
