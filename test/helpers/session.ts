import { Client } from '../../src/client/client.ts';
import {
  blockiert,
  getRuleset,
  levelOf,
  levelRecipes,
  nextLevel,
  priceBand,
  sizeOf,
} from '../../src/sim/rules.ts';
import type { Ruleset } from '../../src/sim/rules.ts';
import { EMPTY_PLOT, cloneState, count, initialState, stored } from '../../src/sim/state.ts';
import type { MailItem, Offer, State } from '../../src/sim/state.ts';
import { simulate } from '../../src/sim/sim.ts';
import { advancePassivesReference } from '../../src/sim/produce.ts';
import type { State } from '../../src/sim/state.ts';
import type { Command } from '../../src/sim/commands.ts';
import type { Snapshot } from '../../src/server/server.ts';
import { topUpRequests } from '../../src/server/requests.ts';
import { topUpChests } from '../../src/server/chests.ts';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function referenceRun(start: State, cmds: readonly Command[], rules: Ruleset): State {
  const intervals = rules.passives.map((p) => rules.recipes[p.recipe]!.durationTicks);
  const outputs = rules.passives.map((p) => rules.recipes[p.recipe]!.output.item);
  let s = cloneState(start);

  for (const cmd of cmds) {
    if (s.tick < cmd.tick) {
      const progress = s.passives.slice();
      const items = s.items.slice();
      let free = rules.siloCapacity - stored(s, rules);

      for (let tick = s.tick; tick < cmd.tick; tick++) {
        for (let i = 0; i < intervals.length; i++) {
          if (free <= 0) continue;
          progress[i]!++;
          if (progress[i]! >= intervals[i]!) {
            items[outputs[i]!] = (items[outputs[i]!] ?? 0) + 1;
            progress[i] = 0;
            free--;
          }
        }
      }

      const advanced = cloneState(s);
      advanced.tick = cmd.tick;
      advanced.items = items;
      advanced.passives = progress;
      s = advanced;
    }

    s = simulate(s, cmd, rules);
  }
  return s;
}

export function referenceStepMatchesUnit(): boolean {
  for (let progress = 0; progress < 3; progress++) {
    for (let space = 0; space < 3; space++) {
      const unit = advancePassivesReference(1, [progress], space, [2]);
      let produced = 0;
      let p = progress;
      if (space > 0) {
        p++;
        if (p >= 2) {
          produced++;
          p = 0;
        }
      }
      if (unit.produced[0] !== produced || unit.progress[0] !== p) return false;
    }
  }
  return true;
}

export function fuzzStart(rules: Ruleset, gold: number, rnd?: () => number): State {
  const base = initialState(rules);
  const items = base.items.slice();
  if (gold > 0) items[rules.currency] = gold;

  if (rnd) {
    const platz = Math.floor(rules.siloCapacity / 4);
    let belegt = 0;
    rules.items.forEach((item, i) => {
      if (i === rules.currency) return;
      if (!item.storable) {
        items[i] = (items[i] ?? 0) + Math.floor(rnd() * 14);
        return;
      }
      const menge = Math.floor(rnd() * 6);
      if (belegt + menge > platz) return;
      items[i] = (items[i] ?? 0) + menge;
      belegt += menge;
    });
  }

  const requests = rnd ? topUpRequests({ ...base, items }, rules, 1, rnd).requests : [];

  const kisten = rnd ? topUpChests({ ...base, items }, rules, rnd) : { chests: [], nextChestId: 1 };

  const offers = rnd ? fuzzOffers(rules, rnd) : [];

  const mail = rnd ? fuzzMail(rules, rnd) : [];
  return {
    ...base,
    items,
    requests,
    offers,
    mail,
    chests: kisten.chests,
    nextChestId: kisten.nextChestId,
  };
}

function fuzzMail(rules: Ruleset, rnd: () => number): MailItem[] {
  const goods = rules.items
    .map((_, i) => i)
    .filter((i) => rules.items[i]!.storable && rules.items[i]!.npcPrice > 0);
  const mail: MailItem[] = [];
  for (let i = 0; i < 3; i++) {
    const item = goods[Math.floor(rnd() * goods.length)]!;
    mail.push({ item, amount: 1 + Math.floor(rnd() * 5), arrivedAt: 0 });
    mail.push({ item: rules.currency, amount: 5 + Math.floor(rnd() * 50), arrivedAt: 0 });
  }
  return mail;
}

function fuzzOffers(rules: Ruleset, rnd: () => number): Offer[] {
  const sellable = rules.items
    .map((_, i) => i)
    .filter((i) => rules.items[i]!.storable && rules.items[i]!.npcPrice > 0);
  const offers: Offer[] = [];
  for (let i = 0; i < Math.min(rules.offerSlots, sellable.length * 2); i++) {
    const item = sellable[Math.floor(rnd() * sellable.length)]!;
    const { min, max } = priceBand(rules, item);
    offers.push({
      id: i + 1,
      item,
      amount: 1 + Math.floor(rnd() * 12),
      price: min + Math.floor(rnd() * (max - min + 1)),
    });
  }
  return offers;
}

export type SessionOptions = {
  steps: number;
  maxAdvance: number;
  advanceChance: number;
  chaosChance: number;
  hoard?: boolean;
};

function affordableRecipes(s: State, rules: Ruleset, plot: number): number[] {
  const level = s.plots[plot]?.level ?? 0;
  return levelRecipes(rules, plot, level).filter((r) =>
    rules.recipes[r]!.inputs.every((input) => count(s, input.item) >= input.amount),
  );
}

function freiesFeld(s: State, rules: Ruleset, plot: number): { gx: number; gy: number } | null {
  const raster = rules.grid;
  if (!raster) return null;
  const groesse = sizeOf(rules, plot);

  for (let gy = 0; gy <= raster.h - groesse.h; gy++) {
    for (let gx = 0; gx <= raster.w - groesse.w; gx++) {
      if (blockiert(rules, gx, gy, groesse.w, groesse.h, s.clearedObstacles)) continue;
      const frei = s.plots.every((other, j) => {
        if (j === plot || other.gx < 0) return true;
        const andere = sizeOf(rules, j);
        return (
          gx + groesse.w <= other.gx ||
          other.gx + andere.w <= gx ||
          gy + groesse.h <= other.gy ||
          other.gy + andere.h <= gy
        );
      });
      if (frei) return { gx, gy };
    }
  }
  return null;
}

function affordableUpgrades(s: State, rules: Ruleset): number[] {
  const out: number[] = [];
  s.plots.forEach((plot, i) => {
    if (plot.slots.some((x) => x.recipe !== EMPTY_PLOT)) return;
    if (rules.grid && plot.level > 0 && plot.gx < 0) return;
    const level = nextLevel(rules, i, plot.level);
    if (!level) return;
    if (levelOf(rules, s.xp) < (level.minPlayerLevel ?? 1)) return;
    if (level.cost.every((c) => count(s, c.item) >= c.amount)) out.push(i);
  });
  return out;
}

export function playRandomSession(
  snapshot: Snapshot,
  rnd: () => number,
  opts: SessionOptions,
): Client {
  const rules = getRuleset(snapshot.rulesetVersion);
  const client = new Client(snapshot);
  const pick = (n: number) => Math.floor(rnd() * n);
  const tradable = rules.items
    .map((_, i) => i)
    .filter((i) => rules.items[i]!.storable && rules.items[i]!.npcPrice > 0);

  const buyable = rules.items.map((_, i) => i).filter((i) => rules.items[i]!.npcBuyPrice > 0);

  for (let i = 0; i < opts.steps; i++) {
    if (rnd() < opts.advanceChance) {
      client.advanceClock(1 + pick(opts.maxAdvance));
      continue;
    }

    if (rnd() < opts.chaosChance) {
      switch (pick(7)) {
        case 6:

          client.buyNpc(pick(rules.items.length + 1), 1 + pick(200));
          break;
        case 0:
          client.start(pick(rules.plots.length + 1), pick(rules.recipes.length + 1));
          break;
        case 1:
          client.collect(pick(rules.plots.length + 1));
          break;
        case 3:
          if (rnd() < 0.5) client.buyAnimal(pick(rules.plots.length + 1));
          else client.buy(pick(rules.plots.length + 1));
          break;
        case 4:

          client.fillRequest(pick(40));
          break;
        case 2:

          client.buyOffer(pick(40));
          break;
        case 5:

          client.skipRequest(pick(40));
          break;
        default:
          client.sellNpc(pick(rules.items.length + 1), 1 + pick(200));
          break;
      }
      continue;
    }

    const s = client.preview();
    const moves: Array<() => void> = [];

    s.plots.forEach((plot, idx) => {
      plot.slots.forEach((slot, j) => {
        if (slot.recipe === EMPTY_PLOT) {
          const options = affordableRecipes(s, rules, idx);
          for (const recipe of options) moves.push(() => client.start(idx, recipe, j));
        } else if (s.tick - slot.startedAt >= rules.recipes[slot.recipe]!.durationTicks) {
          moves.push(() => client.collect(idx, j));
        }
      });
    });

    for (const plot of affordableUpgrades(s, rules)) {
      moves.push(() => client.buy(plot));
    }

    if (rules.animalsMustBeBought) {
      s.plots.forEach((plot, idx) => {
        const tier = rules.plots[idx]?.animal;
        if (!tier || plot.level <= 0 || plot.gx < 0) return;
        if (plot.tiere.length >= plot.slots.length) return;
        if (count(s, rules.currency) < tier.cost) return;
        moves.push(() => client.buyAnimal(idx));
      });
    }

    if (rules.grid) {
      s.plots.forEach((plot, i) => {
        if (plot.level <= 0 || plot.gx >= 0) return;
        const stelle = freiesFeld(s, rules, i);
        if (stelle) moves.push(() => client.place(i, stelle.gx, stelle.gy));
      });
    }

    if (!opts.hoard) {
      for (const item of tradable) {
        const have = count(s, item);
        if (have <= 0) continue;
        moves.push(() => client.sellNpc(item, 1 + pick(have)));

        const { min, max } = priceBand(rules, item);
        moves.push(() => client.listOrder(item, 1 + pick(have), min + pick(max - min + 1)));
      }

      if (s.orders.length > 0) {
        moves.push(() => client.cancelOrder(s.orders[pick(s.orders.length)]!.id));
      }

      if (s.offers.length > 0) {
        const offer = s.offers[pick(s.offers.length)]!;
        moves.push(() => client.buyOffer(offer.id));
      }
    }

    for (const item of buyable) {
      const price = rules.items[item]!.npcBuyPrice;
      const canPay = Math.floor(count(s, rules.currency) / price);
      const fits = rules.items[item]!.storable ? rules.siloCapacity - stored(s, rules) : canPay;
      const max = Math.min(canPay, fits, 10);
      if (max > 0) moves.push(() => client.buyNpc(item, 1 + pick(max)));
    }

    if (s.mail.length > 0) moves.push(() => client.collectMail());

    for (const kiste of s.chests) {
      if (s.tick >= kiste.readyAt) moves.push(() => client.openChest(kiste.id));
    }

    (rules.obstacles ?? []).forEach((h, i) => {
      if (s.clearedObstacles.includes(i)) return;
      const art = rules.obstacleKinds?.[h.kind];
      if (art && count(s, art.tool) >= 1) moves.push(() => client.clearObstacle(i));
    });
    if ((rules.siloLevels?.length ?? 0) > s.siloLevel + 1) {
      const naechste = rules.siloLevels![s.siloLevel + 1]!;
      if (naechste.cost.every((c) => count(s, c.item) >= c.amount)) {
        moves.push(() => client.upgradeSilo());
      }
    }

    if (!opts.hoard) {
      s.requests.slice(0, rules.requestSlots).forEach((request, slot) => {
        if (!request.wants.every((w) => count(s, w.item) >= w.amount)) return;
        if (rules.boardDeliveryOnly) {
          if (s.tick >= s.truck.awayUntil) moves.push(() => client.sendSlip(slot));
        } else {
          moves.push(() => client.fillRequest(request.id));
        }
      });
    }

    const fahrzeit = rules.truckAwayTicks ?? 0;
    if (fahrzeit > 0 && s.tick >= s.truck.awayUntil && s.requests.length > 0) {
      const frachtbrief = s.requests[0]!;
      let voll = true;
      frachtbrief.wants.forEach((w, i) => {
        const drin = s.truck.loaded[i] ?? 0;
        if (drin >= w.amount) return;
        voll = false;
        const moeglich = Math.min(w.amount - drin, count(s, w.item));
        if (moeglich > 0) moves.push(() => client.loadTruck(i, 1 + pick(moeglich)));
      });
      if (voll) moves.push(() => client.sendTruck());
    }

    if (rules.requestSkipCooldownTicks > 0 && s.tick >= s.skipReadyAt) {
      const open = s.requests.slice(0, rules.requestSlots);
      if (open.length > 0) {
        const target = open[pick(open.length)]!;
        moves.push(() => client.skipRequest(target.id));
      }
    }

    if (moves.length > 0) moves[pick(moves.length)]!();
  }

  return client;
}

export function assertAllIntegers(s: State): void {
  const nums: Array<[string, number]> = [
    ['tick', s.tick],
    ['xp', s.xp],
    ...s.items.map((v, i): [string, number] => [`items[${i}]`, v]),
    ...s.passives.map((v, i): [string, number] => [`passives[${i}]`, v]),
    ...s.plots.flatMap((p, i): Array<[string, number]> =>
      p.slots.flatMap((slot, j): Array<[string, number]> => [
        [`plots[${i}].slots[${j}].startedAt`, slot.startedAt],
        [`plots[${i}].slots[${j}].recipe`, slot.recipe],
      ]),
    ),
    ...s.plots.map((p, i): [string, number] => [`plots[${i}].level`, p.level]),
  ];

  for (const [name, value] of nums) {
    if (!Number.isInteger(value)) {
      throw new Error(`Nicht-Integer im Zustand: ${name} = ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Unsicherer Integer im Zustand: ${name} = ${value}`);
    }
  }
}
