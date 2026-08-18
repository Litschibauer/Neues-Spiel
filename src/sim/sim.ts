import type { Ruleset } from './rules.ts';
import {
  derivedTables,
  isTradable,
  levelOf,
  levelRecipes,
  listingFee,
  nextLevel,
  priceBand,
} from './rules.ts';
import type { State } from './state.ts';
import {
  EMPTY_PLOT,
  addItem,
  addItems,
  cloneState,
  count,
  replaceAt,
  spaceLeft,
  storedIn,
} from './state.ts';
import { advancePassives } from './produce.ts';
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
    const expired = s.tick - order.listedAt >= rules.orderTtlTicks;
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
      if (plot.recipe !== EMPTY_PLOT) throw new SimError('PLOT_BUSY');

      if (!levelRecipes(rules, cmd.plot, plot.level).includes(cmd.recipe)) {
        throw new SimError('RECIPE_NOT_ALLOWED');
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
        level: plot.level,
        recipe: cmd.recipe,
        startedAt: s.tick,
      });
      return next;
    }

    case 'BUY': {
      const def = rules.plots[cmd.plot];
      const plot = s.plots[cmd.plot];
      if (!def || !plot) throw new SimError('NO_SUCH_PLOT');
      if (plot.recipe !== EMPTY_PLOT) throw new SimError('PLOT_BUSY');

      const level = nextLevel(rules, cmd.plot, plot.level);
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
        level: plot.level + 1,
        recipe: EMPTY_PLOT,
        startedAt: 0,
      });
      return next;
    }

    case 'COLLECT': {
      const plot = s.plots[cmd.plot];
      if (!plot) throw new SimError('NO_SUCH_PLOT');
      if (plot.recipe === EMPTY_PLOT) throw new SimError('PLOT_EMPTY');

      const recipe = rules.recipes[plot.recipe];
      if (!recipe) throw new SimError('RECIPE_NOT_ALLOWED');
      if (s.tick - plot.startedAt < recipe.durationTicks) throw new SimError('NOT_DONE');

      const output = rules.items[recipe.output.item];
      if (output?.storable && spaceLeft(s, rules) < recipe.output.amount) {
        throw new SimError('SILO_FULL');
      }

      const next = cloneState(s);
      next.plots = replaceAt(s.plots, cmd.plot, {
        level: plot.level,
        recipe: EMPTY_PLOT,
        startedAt: 0,
      });
      next.items = addItem(s.items, recipe.output.item, recipe.output.amount);

      next.xp = s.xp + recipe.xp;
      return next;
    }

    case 'SELL_NPC': {
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

      if (s.orders.length >= rules.orderSlots) throw new SimError('NO_ORDER_SLOTS');

      const band = priceBand(rules, cmd.item);
      if (cmd.price < band.min || cmd.price > band.max) throw new SimError('PRICE_OUT_OF_BAND');

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
      });
      next.nextOrderId = s.nextOrderId + 1;
      return next;
    }

    case 'CANCEL_ORDER': {
      const order = s.orders.find((o) => o.id === cmd.orderId);
      if (!order) throw new SimError('NO_SUCH_ORDER');

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
          !def?.storable || rules.siloCapacity - storedIn(items, rules) >= entry.amount;
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
      const index = s.requests.findIndex((r) => r.id === cmd.requestId);
      if (index < 0) throw new SimError('NO_SUCH_REQUEST');

      if (index >= rules.requestSlots) throw new SimError('REQUEST_NOT_ACTIVE');

      const request = s.requests[index]!;
      for (const stack of request.wants) {
        if (count(s, stack.item) < stack.amount) throw new SimError('NOT_ENOUGH_ITEMS');
      }

      const changes: [number, number][] = request.wants.map((w) => [w.item, -w.amount]);
      for (const r of request.reward) changes.push([r.item, r.amount]);
      const items = addItems(s.items, changes);
      if (storedIn(items, rules) > rules.siloCapacity) throw new SimError('SILO_FULL');

      const next = cloneState(s);
      next.items = items;
      next.requests = s.requests.filter((r) => r.id !== cmd.requestId);
      next.xp = s.xp + request.xp;
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
