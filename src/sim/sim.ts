import type { Ruleset } from './rules.ts';
import {
  derivedTables,
  isTradable,
  levelOf,
  levelRecipes,
  listingFee,
  blockiert,
  nextLevel,
  itemUnlockLevel,
  offerLimits,
  sizeOf,
  recipeUnlocked,
  slotsAt,
} from './rules.ts';
import type { Request, State } from './state.ts';
import {
  EMPTY_PLOT,
  capacityOf,
  emptySlots,
  addItem,
  addItems,
  cloneState,
  count,
  replaceAt,
  spaceLeft,
  storedIn,
} from './state.ts';
import { advancePassives } from './produce.ts';

export const MAX_PENDING_BOXES = 20;

export function truckAway(rules: Ruleset): number {
  return rules.truckAwayTicks ?? 0;
}

function leereLadung(waybill: Request | undefined): number[] {
  const out: number[] = [];
  if (!waybill) return out;
  for (let i = 0; i < waybill.wants.length; i++) out.push(0);
  return out;
}

function geladenZurueck(s: State, waybill: Request): Array<[number, number]> {
  return waybill.wants.flatMap((w, i): Array<[number, number]> => {
    const menge = s.truck.loaded[i] ?? 0;
    return menge > 0 ? [[w.item, menge]] : [];
  });
}

function ladungVon(s: State, waybill: Request): number[] {
  const out: number[] = [];
  for (let i = 0; i < waybill.wants.length; i++) out.push(s.truck.loaded[i] ?? 0);
  return out;
}
import type { Command } from './commands.ts';
import { SimError } from './commands.ts';

export function advanceTo(state: State, toTick: number, rules: Ruleset): State {
  const elapsed = toTick - state.tick;
  if (elapsed < 0) throw new SimError('TIME_WENT_BACKWARDS');
  if (elapsed === 0 && state.orders.length === 0) return state;

  const next = cloneState(state);

  if (elapsed > 0) {
    next.tick = toTick;

    if (rules.passives.length > 0) {
      const { passiveIntervals, passiveOutputs } = derivedTables(rules);
      const space = spaceLeft(state, rules);
      const result = advancePassives(elapsed, state.passives, space, passiveIntervals);

      const gains: [number, number][] = [];
      for (let i = 0; i < result.produced.length; i++) {
        if (result.produced[i]! > 0) gains.push([passiveOutputs[i]!, result.produced[i]!]);
      }
      if (gains.length > 0) next.items = addItems(state.items, gains);
      next.passives = result.progress;
    }
  }

  expireOrders(next, rules);
  return next;
}

function expireOrders(s: State, rules: Ruleset): void {
  if (rules.orderTtlTicks <= 0) return;
  if (s.orders.length === 0) return;

  const survivors: typeof s.orders = [];
  let mail = s.mail;
  for (const order of s.orders) {
    const expired = order.verkauft <= 0 && s.tick - order.listedAt >= rules.orderTtlTicks;
    if (expired && mail.length < rules.mailCapacity) {
      mail = mail.concat({ item: order.item, amount: order.amount, arrivedAt: s.tick });
    } else {
      survivors.push(order);
    }
  }
  if (survivors.length !== s.orders.length) {
    s.orders = survivors;
    s.mail = mail;
  }
}

export function simulate(state: State, cmd: Command, rules: Ruleset): State {
  const s = advanceTo(state, cmd.tick, rules);

  switch (cmd.type) {
    case 'START': {
      const def = rules.plots[cmd.plot];
      const plot = s.plots[cmd.plot];
      if (!def || !plot) throw new SimError('NO_SUCH_PLOT');
      if (plot.level <= 0) throw new SimError('PLOT_LOCKED');

      if (rules.grid && plot.gx < 0) throw new SimError('NOT_PLACED');
      if (!levelRecipes(rules, cmd.plot, plot.level).includes(cmd.recipe)) {
        throw new SimError('RECIPE_NOT_ALLOWED');
      }

      const slotIndex = cmd.slot ?? 0;
      const slot = plot.slots[slotIndex];
      if (!slot) throw new SimError('NO_SUCH_SLOT');
      if (slot.recipe !== EMPTY_PLOT) throw new SimError('PLOT_BUSY');

      if (rules.animalsMustBeBought && def.animal) {
        const geboren = plot.tiere[slotIndex];
        if (geboren === undefined) throw new SimError('NO_ANIMAL');
        if (s.tick - geboren < def.animal.growTicks) throw new SimError('ANIMAL_TOO_YOUNG');
      }

      if (!recipeUnlocked(rules, cmd.recipe, levelOf(rules, s.xp))) {
        throw new SimError('PLAYER_LEVEL_TOO_LOW');
      }

      const recipe = rules.recipes[cmd.recipe];
      if (!recipe) throw new SimError('RECIPE_NOT_ALLOWED');
      for (const input of recipe.inputs) {
        if (count(s, input.item) < input.amount) throw new SimError('NOT_ENOUGH_ITEMS');
      }

      const next = cloneState(s);
      if (recipe.inputs.length > 0) {
        const spend: [number, number][] = recipe.inputs.map((i) => [i.item, -i.amount]);
        next.items = addItems(s.items, spend);
      }
      next.plots = replaceAt(s.plots, cmd.plot, {
        ...plot,
        slots: replaceAt(plot.slots, slotIndex, { recipe: cmd.recipe, startedAt: s.tick }),
      });
      return next;
    }

    case 'BUY_ANIMAL': {
      const def = rules.plots[cmd.plot];
      const plot = s.plots[cmd.plot];
      if (!def || !plot) throw new SimError('NO_SUCH_PLOT');
      if (!rules.animalsMustBeBought || !def.animal) throw new SimError('NOT_AN_ANIMAL_PLOT');
      if (plot.level <= 0) throw new SimError('PLOT_LOCKED');
      if (rules.grid && plot.gx < 0) throw new SimError('NOT_PLACED');
      if (plot.tiere.length >= slotsAt(rules, cmd.plot, plot.level)) {
        throw new SimError('NO_ANIMAL_SPACE');
      }
      if (count(s, rules.currency) < def.animal.cost) throw new SimError('CANT_AFFORD');

      const next = cloneState(s);
      next.items = addItem(s.items, rules.currency, -def.animal.cost);
      next.plots = replaceAt(s.plots, cmd.plot, {
        ...plot,
        tiere: plot.tiere.concat(s.tick),
      });
      return next;
    }

    case 'BUY': {
      const def = rules.plots[cmd.plot];
      const plot = s.plots[cmd.plot];
      if (!def || !plot) throw new SimError('NO_SUCH_PLOT');

      const level = nextLevel(rules, cmd.plot, plot.level);
      const capacity = level ? slotsAt(rules, cmd.plot, plot.level + 1) : 0;
      const running = plot.slots.filter((x) => x.recipe !== EMPTY_PLOT);
      const keepsRunning =
        level !== null &&
        capacity >= plot.slots.length &&
        running.every((x) => level.recipes.includes(x.recipe));
      if (running.length > 0 && !keepsRunning) throw new SimError('PLOT_BUSY');
      if (!level) throw new SimError('MAX_LEVEL');

      if (levelOf(rules, s.xp) < (level.minPlayerLevel ?? 1)) {
        throw new SimError('PLAYER_LEVEL_TOO_LOW');
      }
      for (const price of level.cost) {
        if (count(s, price.item) < price.amount) throw new SimError('CANT_AFFORD');
      }

      const next = cloneState(s);
      if (level.cost.length > 0) {
        next.items = addItems(
          s.items,
          level.cost.map((c): [number, number] => [c.item, -c.amount]),
        );
      }
      next.plots = replaceAt(s.plots, cmd.plot, {
        ...plot,
        level: plot.level + 1,
        slots:
          running.length > 0
            ? [...plot.slots, ...emptySlots(capacity - plot.slots.length)]
            : emptySlots(capacity),
      });
      return next;
    }

    case 'COLLECT': {
      const plot = s.plots[cmd.plot];
      if (!plot) throw new SimError('NO_SUCH_PLOT');

      const slotIndex = cmd.slot ?? 0;
      const slot = plot.slots[slotIndex];
      if (!slot) throw new SimError('NO_SUCH_SLOT');
      if (slot.recipe === EMPTY_PLOT) throw new SimError('PLOT_EMPTY');

      const recipe = rules.recipes[slot.recipe];
      if (!recipe) throw new SimError('RECIPE_NOT_ALLOWED');
      if (s.tick - slot.startedAt < recipe.durationTicks) throw new SimError('NOT_DONE');

      const output = rules.items[recipe.output.item];
      if (output?.storable && spaceLeft(s, rules) < recipe.output.amount) {
        throw new SimError('SILO_FULL');
      }

      const next = cloneState(s);
      next.plots = replaceAt(s.plots, cmd.plot, {
        ...plot,
        slots: replaceAt(plot.slots, slotIndex, { recipe: EMPTY_PLOT, startedAt: 0 }),
      });
      next.items = addItem(s.items, recipe.output.item, recipe.output.amount);

      next.xp = s.xp + recipe.xp;
      return next;
    }

    case 'SELL_NPC': {
      if (rules.sellNpcDisabled) throw new SimError('NPC_DISABLED');
      if (!Number.isInteger(cmd.amount) || cmd.amount <= 0) throw new SimError('BAD_AMOUNT');
      const def = rules.items[cmd.item];
      if (!def) throw new SimError('NO_SUCH_ITEM');
      if (def.npcPrice <= 0) throw new SimError('NOT_SELLABLE');
      if (count(s, cmd.item) < cmd.amount) throw new SimError('NOT_ENOUGH_ITEMS');

      const next = cloneState(s);
      next.items = addItems(s.items, [
        [cmd.item, -cmd.amount],
        [rules.currency, cmd.amount * def.npcPrice],
      ]);
      return next;
    }

    case 'BUY_NPC': {
      if (rules.emergencyBuyOnly) {
        if (cmd.amount !== 1) throw new SimError('BAD_AMOUNT');
        if (count(s, cmd.item) > 0) throw new SimError('ONLY_WHEN_EMPTY');
      }
      if (!Number.isInteger(cmd.amount) || cmd.amount <= 0) throw new SimError('BAD_AMOUNT');
      const def = rules.items[cmd.item];
      if (!def) throw new SimError('NO_SUCH_ITEM');
      if (def.npcBuyPrice <= 0) throw new SimError('NOT_BUYABLE');

      const cost = cmd.amount * def.npcBuyPrice;
      if (count(s, rules.currency) < cost) throw new SimError('CANT_AFFORD');
      if (def.storable && spaceLeft(s, rules) < cmd.amount) throw new SimError('SILO_FULL');

      const next = cloneState(s);
      next.items = addItems(s.items, [
        [rules.currency, -cost],
        [cmd.item, cmd.amount],
      ]);
      return next;
    }

    case 'LIST_ORDER': {
      if (!Number.isInteger(cmd.amount) || cmd.amount <= 0) throw new SimError('BAD_AMOUNT');
      if (!Number.isInteger(cmd.price) || cmd.price <= 0) throw new SimError('BAD_AMOUNT');
      if (!rules.items[cmd.item]) throw new SimError('NO_SUCH_ITEM');
      if (!isTradable(rules, cmd.item)) throw new SimError('NOT_TRADABLE');

      if (rules.offerNeedsLevel && levelOf(rules, s.xp) < itemUnlockLevel(rules, cmd.item)) {
        throw new SimError('ITEM_LOCKED');
      }

      if (s.orders.length >= rules.orderSlots) throw new SimError('NO_ORDER_SLOTS');

      const limits = offerLimits(rules, cmd.item);
      if (limits.maxAmount > 0 && cmd.amount > limits.maxAmount) {
        throw new SimError('TOO_MANY_PER_SLOT');
      }
      if (cmd.price < limits.minPrice || cmd.price > limits.maxPrice) {
        throw new SimError('PRICE_OUT_OF_BAND');
      }

      if (count(s, cmd.item) < cmd.amount) throw new SimError('NOT_ENOUGH_ITEMS');

      const fee = listingFee(rules, cmd.item, cmd.amount);
      if (count(s, rules.currency) < fee) throw new SimError('CANT_AFFORD');

      const next = cloneState(s);
      next.items = addItems(s.items, [
        [cmd.item, -cmd.amount],
        [rules.currency, -fee],
      ]);
      next.orders = s.orders.concat({
        id: s.nextOrderId,
        item: cmd.item,
        amount: cmd.amount,
        price: cmd.price,
        listedAt: s.tick,
        verkauft: 0,
      });
      next.nextOrderId = s.nextOrderId + 1;
      return next;
    }

    case 'COLLECT_SALE': {
      const order = s.orders.find((o) => o.id === cmd.orderId);
      if (!order) throw new SimError('NO_SUCH_ORDER');
      if (order.verkauft <= 0) throw new SimError('NOT_SOLD');

      const next = cloneState(s);
      next.orders = s.orders.filter((o) => o.id !== cmd.orderId);
      next.items = addItem(s.items, rules.currency, order.verkauft);
      return next;
    }

    case 'CANCEL_ORDER': {
      const order = s.orders.find((o) => o.id === cmd.orderId);
      if (!order) throw new SimError('NO_SUCH_ORDER');
      if (order.verkauft > 0) throw new SimError('ALREADY_SOLD');

      if (rules.items[order.item]?.storable && spaceLeft(s, rules) < order.amount) {
        throw new SimError('SILO_FULL');
      }

      const next = cloneState(s);
      next.orders = s.orders.filter((o) => o.id !== cmd.orderId);
      next.items = addItem(s.items, order.item, order.amount);
      return next;
    }

    case 'BUY_OFFER': {
      const offer = s.offers.find((o) => o.id === cmd.offerId);
      if (!offer) throw new SimError('NO_SUCH_OFFER');

      if (rules.buyNeedsLevel && levelOf(rules, s.xp) < itemUnlockLevel(rules, offer.item)) {
        throw new SimError('ITEM_LOCKED');
      }

      const total = offer.amount * offer.price;
      if (count(s, rules.currency) < total) throw new SimError('CANT_AFFORD');

      if (rules.items[offer.item]?.storable && spaceLeft(s, rules) < offer.amount) {
        throw new SimError('SILO_FULL');
      }

      const next = cloneState(s);
      next.items = addItems(s.items, [
        [rules.currency, -total],
        [offer.item, offer.amount],
      ]);

      next.offers = s.offers.filter((o) => o.id !== cmd.offerId);
      return next;
    }

    case 'COLLECT_MAIL': {
      if (s.mail.length === 0) throw new SimError('NOTHING_TO_COLLECT');

      const next = cloneState(s);
      const remaining: typeof next.mail = [];
      let collected = 0;
      let items = s.items;

      for (const entry of s.mail) {
        const def = rules.items[entry.item];

        const fits =
          !def?.storable || capacityOf(s, rules) - storedIn(items, rules) >= entry.amount;
        if (fits) {
          items = addItem(items, entry.item, entry.amount);
          collected++;
        } else {
          remaining.push(entry);
        }
      }

      if (collected === 0) throw new SimError('SILO_FULL');
      next.items = items;
      next.mail = remaining;
      return next;
    }

    case 'FILL_REQUEST': {
      if (rules.boardDeliveryOnly) throw new SimError('USE_THE_BOARD');

      const index = s.requests.findIndex((r) => r.id === cmd.requestId);
      if (index < 0) throw new SimError('NO_SUCH_REQUEST');

      if (index >= rules.requestSlots) throw new SimError('REQUEST_NOT_ACTIVE');

      const request = s.requests[index]!;
      for (const stack of request.wants) {
        if (count(s, stack.item) < stack.amount) throw new SimError('NOT_ENOUGH_ITEMS');
      }

      const changes: [number, number][] = request.wants.map((w) => [w.item, -w.amount]);
      for (const r of request.reward) changes.push([r.item, r.amount]);
      if (index === 0) {
        for (const [item, menge] of geladenZurueck(s, request)) changes.push([item, menge]);
      }
      const items = addItems(s.items, changes);
      if (storedIn(items, rules) > capacityOf(s, rules)) throw new SimError('SILO_FULL');

      const next = cloneState(s);
      next.items = items;
      next.requests = s.requests.filter((r) => r.id !== cmd.requestId);
      next.xp = s.xp + request.xp;
      if (index === 0) {
        next.truck = { loaded: leereLadung(next.requests[0]), awayUntil: s.truck.awayUntil };
      }
      return next;
    }

    case 'SKIP_REQUEST': {
      if (rules.requestSkipCooldownTicks <= 0) throw new SimError('SKIP_DISABLED');

      const index = s.requests.findIndex((r) => r.id === cmd.requestId);
      if (index < 0) throw new SimError('NO_SUCH_REQUEST');
      if (index >= rules.requestSlots) throw new SimError('REQUEST_NOT_ACTIVE');
      if (s.tick < s.skipReadyAt) throw new SimError('SKIP_ON_COOLDOWN');

      const next = cloneState(s);
      next.requests = s.requests.filter((r) => r.id !== cmd.requestId);
      next.skipReadyAt = s.tick + rules.requestSkipCooldownTicks;

      if (index === 0) {
        const items = addItems(s.items, geladenZurueck(s, s.requests[0]!));
        if (storedIn(items, rules) > capacityOf(s, rules)) throw new SimError('SILO_FULL');
        next.items = items;
        next.truck = { loaded: leereLadung(next.requests[0]), awayUntil: s.truck.awayUntil };
      }
      return next;
    }

    case 'SEND_SLIP': {
      const away = truckAway(rules);
      if (away <= 0) throw new SimError('TRUCK_DISABLED');
      if (s.tick < s.truck.awayUntil) throw new SimError('TRUCK_AWAY');

      if (!Number.isInteger(cmd.slot) || cmd.slot < 0 || cmd.slot >= rules.requestSlots) {
        throw new SimError('NO_SUCH_SLIP');
      }
      const zettel = s.requests[cmd.slot];
      if (!zettel) throw new SimError('NO_SUCH_SLIP');

      for (const stack of zettel.wants) {
        if (count(s, stack.item) < stack.amount) throw new SimError('NOT_ENOUGH_ITEMS');
      }

      const changes: [number, number][] = zettel.wants.map((w) => [w.item, -w.amount]);
      for (const r of zettel.reward) changes.push([r.item, r.amount]);
      const items = addItems(s.items, changes);
      if (storedIn(items, rules) > capacityOf(s, rules)) throw new SimError('SILO_FULL');

      const next = cloneState(s);
      next.items = items;
      next.requests = s.requests.filter((_, i) => i !== cmd.slot);
      next.xp = s.xp + zettel.xp;
      next.truck = { loaded: [], awayUntil: s.tick + away };
      return next;
    }

    case 'LOAD_TRUCK': {
      const away = truckAway(rules);
      if (away <= 0) throw new SimError('TRUCK_DISABLED');
      if (s.tick < s.truck.awayUntil) throw new SimError('TRUCK_AWAY');

      const waybill = s.requests[0];
      if (!waybill) throw new SimError('NO_WAYBILL');

      const stack = waybill.wants[cmd.stack];
      if (!stack) throw new SimError('NO_SUCH_STACK');
      if (!Number.isInteger(cmd.amount) || cmd.amount <= 0) throw new SimError('BAD_AMOUNT');

      const schon = s.truck.loaded[cmd.stack] ?? 0;
      if (schon + cmd.amount > stack.amount) throw new SimError('TOO_MUCH');
      if (count(s, stack.item) < cmd.amount) throw new SimError('NOT_ENOUGH_ITEMS');

      const loaded = ladungVon(s, waybill);
      loaded[cmd.stack] = schon + cmd.amount;

      const next = cloneState(s);
      next.items = addItem(s.items, stack.item, -cmd.amount);
      next.truck = { loaded, awayUntil: s.truck.awayUntil };
      return next;
    }

    case 'SEND_TRUCK': {
      const away = truckAway(rules);
      if (away <= 0) throw new SimError('TRUCK_DISABLED');
      if (s.tick < s.truck.awayUntil) throw new SimError('TRUCK_AWAY');

      const waybill = s.requests[0];
      if (!waybill) throw new SimError('NO_WAYBILL');

      const voll = waybill.wants.every((w, i) => (s.truck.loaded[i] ?? 0) >= w.amount);
      if (!voll) throw new SimError('TRUCK_NOT_FULL');

      const items = addItems(
        s.items,
        waybill.reward.map((r): [number, number] => [r.item, r.amount]),
      );
      if (storedIn(items, rules) > capacityOf(s, rules)) throw new SimError('SILO_FULL');

      const next = cloneState(s);
      next.items = items;
      next.requests = s.requests.slice(1);
      next.xp = s.xp + waybill.xp;
      next.truck = { loaded: leereLadung(next.requests[0]), awayUntil: s.tick + away };
      return next;
    }

    case 'PLACE': {
      const raster = rules.grid;
      if (!raster) throw new SimError('NO_GRID');

      const def = rules.plots[cmd.plot];
      const plot = s.plots[cmd.plot];
      if (!def || !plot) throw new SimError('NO_SUCH_PLOT');
      if (plot.level <= 0) throw new SimError('PLOT_LOCKED');
      if (def.fixed) throw new SimError('OFF_GRID');

      const groesse = sizeOf(rules, cmd.plot);
      if (!Number.isInteger(cmd.gx) || !Number.isInteger(cmd.gy)) throw new SimError('OFF_GRID');
      if (cmd.gx < 0 || cmd.gy < 0) throw new SimError('OFF_GRID');
      if (cmd.gx + groesse.w > raster.w || cmd.gy + groesse.h > raster.h) {
        throw new SimError('OFF_GRID');
      }

      if (blockiert(rules, cmd.gx, cmd.gy, groesse.w, groesse.h, s.clearedObstacles, s.expandiert)) {
        throw new SimError('CELL_TAKEN');
      }

      for (const [i, other] of s.plots.entries()) {
        if (i === cmd.plot || other.gx < 0) continue;
        const andere = sizeOf(rules, i);
        const frei =
          cmd.gx + groesse.w <= other.gx ||
          other.gx + andere.w <= cmd.gx ||
          cmd.gy + groesse.h <= other.gy ||
          other.gy + andere.h <= cmd.gy;
        if (!frei) throw new SimError('CELL_TAKEN');
      }

      const next = cloneState(s);
      next.plots = replaceAt(s.plots, cmd.plot, { ...plot, gx: cmd.gx, gy: cmd.gy });
      return next;
    }

    case 'EXPAND': {
      const feld = rules.expansions?.find((e) => e.id === cmd.id);
      if (!feld) throw new SimError('NO_SUCH_EXPANSION');
      if (s.expandiert.includes(feld.id)) throw new SimError('ALREADY_EXPANDED');
      if (levelOf(rules, s.xp) < feld.minLevel) throw new SimError('PLAYER_LEVEL_TOO_LOW');
      for (const c of feld.cost) {
        if (count(s, c.item) < c.amount) throw new SimError('NOT_ENOUGH_ITEMS');
      }

      const next = cloneState(s);
      next.items = addItems(
        s.items,
        feld.cost.map((c) => [c.item, -c.amount] as [number, number]),
      );
      next.expandiert = s.expandiert.concat(feld.id);
      return next;
    }

    case 'CLEAR_OBSTACLE': {
      const hindernis = rules.obstacles?.[cmd.index];
      if (!hindernis) throw new SimError('NO_SUCH_OBSTACLE');
      if (s.clearedObstacles.includes(cmd.index)) throw new SimError('ALREADY_CLEARED');

      const art = rules.obstacleKinds?.[hindernis.kind];
      if (!art) throw new SimError('NEEDS_TOOL');
      if (count(s, art.tool) < 1) throw new SimError('NEEDS_TOOL');

      const next = cloneState(s);
      next.items = addItem(s.items, art.tool, -1);
      next.clearedObstacles = s.clearedObstacles.concat(cmd.index);
      next.xp = s.xp + art.xp;
      return next;
    }

    case 'OPEN_CHEST': {
      const kisten = rules.chestKinds;
      if (!kisten || kisten.length === 0) throw new SimError('NO_SUCH_CHEST');

      const kiste = s.chests[0];
      if (!kiste || kiste.id !== cmd.chestId) throw new SimError('NO_SUCH_CHEST');
      if (s.tick < s.chestReadyAt) throw new SimError('CHEST_NOT_READY');
      if (s.pendingBoxes.length >= MAX_PENDING_BOXES) throw new SimError('TOO_MANY_BOXES');

      const next = cloneState(s);
      next.chests = s.chests.slice(1);
      next.pendingBoxes = s.pendingBoxes.concat(kiste.kind);
      next.chestReadyAt = s.tick + (rules.chestEveryTicks ?? 0);
      return next;
    }

    case 'UPGRADE_SILO': {
      const stufen = rules.siloLevels;
      if (!stufen || stufen.length === 0) throw new SimError('SILO_LOCKED');

      const naechste = stufen[s.siloLevel + 1];
      if (!naechste) throw new SimError('SILO_MAX');
      for (const preis of naechste.cost) {
        if (count(s, preis.item) < preis.amount) throw new SimError('CANT_AFFORD');
      }

      const next = cloneState(s);
      next.items = addItems(
        s.items,
        naechste.cost.map((c): [number, number] => [c.item, -c.amount]),
      );
      next.siloLevel = s.siloLevel + 1;
      return next;
    }

    default:
      throw new SimError('UNKNOWN_COMMAND');
  }
}

export function simulateAll(state: State, cmds: readonly Command[], rules: Ruleset): State {
  let s = state;
  for (const cmd of cmds) s = simulate(s, cmd, rules);
  return s;
}
