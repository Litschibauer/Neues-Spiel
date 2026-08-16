/**
 * Der Sim-Kern (Architektur §2.2).
 *
 * DIESE DATEI IST DAS EINZIGE ARTEFAKT, das den Spielzustand fortschreibt —
 * und sie läuft unverändert auf Client UND Server. Zwei Implementierungen
 * wären der sichere Weg in R1.
 *
 *   neuerZustand = simulate(alterZustand, command)
 *
 * Reine Funktion: gleicher Input → bit-für-bit gleicher Output.
 */

import type { Ruleset } from './rules.ts';
import type { State } from './state.ts';
import { cloneState, replaceAt, spaceLeft } from './state.ts';
import { advanceCoop } from './produce.ts';
import type { Command } from './commands.ts';
import { SimError } from './commands.ts';

/**
 * Schreibt die passive Produktion bis `toTick` fort — ein Segment.
 *
 * Wird vor jedem Command aufgerufen, damit zwischen zwei Aktionen exakt die
 * geschlossene Form aus §7 greift und nicht Tick für Tick geloopt werden muss.
 */
export function advanceTo(state: State, toTick: number, rules: Ruleset): State {
  const elapsed = toTick - state.tick;
  if (elapsed < 0) throw new SimError('TIME_WENT_BACKWARDS');
  if (elapsed === 0 && state.orders.length === 0) return state;

  const next = cloneState(state);

  if (elapsed > 0) {
    const { eggs, coopProgress } = advanceCoop(
      elapsed,
      state.coopProgress,
      spaceLeft(state, rules.siloCapacity),
      rules.coopTicksPerEgg,
    );
    next.tick = toTick;
    next.eggs += eggs;
    next.coopProgress = coopProgress;
  }

  // Auch bei `elapsed === 0` prüfen. Sonst hinge das Ergebnis davon ab, WIE die
  // Zeitachse in Segmente zerteilt wurde — und genau solche Abhängigkeiten
  // sind es, die Client und Server auseinanderlaufen lassen (R1).
  expireOrders(next, rules);
  return next;
}

/**
 * Verfallene Aufträge ins Postfach zurückgeben (§8).
 *
 * Läuft am Segmentende statt tickgenau — das ist zulässig, weil zwischen zwei
 * Commands niemand Aufträge oder Postfach liest. Die Reihenfolge (nach `id`)
 * ist stabil, damit das Ergebnis bei vollem Postfach eindeutig bleibt.
 *
 * Passt nichts mehr ins Postfach, bleibt der Auftrag einfach stehen und
 * verfällt später. Nie etwas vernichten, wovon der Spieler nichts wusste (§7).
 */
function expireOrders(s: State, rules: Ruleset): void {
  if (s.orders.length === 0) return;

  const survivors: typeof s.orders = [];
  let mail = s.mail;
  for (const order of s.orders) {
    const expired = s.tick - order.listedAt >= rules.orderTtlTicks;
    if (expired && mail.length < rules.mailCapacity) {
      // Neues Array statt push: `mail` wird mit älteren Zuständen geteilt.
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

/**
 * Wendet ein einzelnes Command an. Wirft `SimError`, wenn die Aktion nach den
 * Regeln nicht erlaubt ist.
 *
 * Wichtig: Der Client ruft exakt dieselbe Funktion. Eine illegale Aktion wird
 * damit schon offline abgelehnt und landet gar nicht erst im Log — statt beim
 * Sync einen Rollback auszulösen.
 */
export function simulate(state: State, cmd: Command, rules: Ruleset): State {
  const s = advanceTo(state, cmd.tick, rules);

  switch (cmd.type) {
    case 'PLANT': {
      const field = s.fields[cmd.field];
      if (!field) throw new SimError('NO_SUCH_FIELD');
      if (field.crop !== null) throw new SimError('FIELD_OCCUPIED');

      const next = cloneState(s);
      next.fields = replaceAt(s.fields, cmd.field, { crop: 'wheat', plantedAt: s.tick });
      return next;
    }

    case 'HARVEST': {
      const field = s.fields[cmd.field];
      if (!field) throw new SimError('NO_SUCH_FIELD');
      if (field.crop === null) throw new SimError('FIELD_EMPTY');
      if (s.tick - field.plantedAt < rules.wheatGrowTicks) throw new SimError('NOT_RIPE');
      // Hard block statt stillem Verlust (§7): das Feld bleibt reif stehen.
      if (spaceLeft(s, rules.siloCapacity) < rules.wheatYield) throw new SimError('SILO_FULL');

      const next = cloneState(s);
      next.fields = replaceAt(s.fields, cmd.field, { crop: null, plantedAt: 0 });
      next.wheat += rules.wheatYield;
      return next;
    }

    case 'SELL_NPC': {
      if (!Number.isInteger(cmd.amount) || cmd.amount <= 0) throw new SimError('BAD_AMOUNT');
      const have = cmd.item === 'wheat' ? s.wheat : s.eggs;
      if (have < cmd.amount) throw new SimError('NOT_ENOUGH_ITEMS');

      const next = cloneState(s);
      if (cmd.item === 'wheat') next.wheat -= cmd.amount;
      else next.eggs -= cmd.amount;
      next.gold += cmd.amount * rules.npcPrices[cmd.item];
      return next;
    }

    case 'LIST_ORDER': {
      if (!Number.isInteger(cmd.amount) || cmd.amount <= 0) throw new SimError('BAD_AMOUNT');
      if (!Number.isInteger(cmd.price) || cmd.price <= 0) throw new SimError('BAD_AMOUNT');

      // Der strukturelle Riegel gegen Escrow-als-Lager (§8).
      if (s.orders.length >= rules.orderSlots) throw new SimError('NO_ORDER_SLOTS');

      // Preisband: Was eingestellt wird, muss plausibel verkäuflich sein —
      // sonst wäre der Auftrag nur ein Parkplatz für Ware.
      const reference = rules.npcPrices[cmd.item];
      const min = Math.floor((reference * rules.priceBandMinPct) / 100);
      const max = Math.floor((reference * rules.priceBandMaxPct) / 100);
      if (cmd.price < min || cmd.price > max) throw new SimError('PRICE_OUT_OF_BAND');

      const have = cmd.item === 'wheat' ? s.wheat : s.eggs;
      if (have < cmd.amount) throw new SimError('NOT_ENOUGH_ITEMS');

      const next = cloneState(s);
      if (cmd.item === 'wheat') next.wheat -= cmd.amount;
      else next.eggs -= cmd.amount;
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
      // Zurücknehmen darf das Lager nicht sprengen — sonst wäre der Auftrag
      // ein Weg, das Limit zu umgehen.
      if (spaceLeft(s, rules.siloCapacity) < order.amount) throw new SimError('SILO_FULL');

      const next = cloneState(s);
      next.orders = s.orders.filter((o) => o.id !== cmd.orderId);
      if (order.item === 'wheat') next.wheat += order.amount;
      else next.eggs += order.amount;
      return next;
    }

    case 'COLLECT_MAIL': {
      if (s.mail.length === 0) throw new SimError('NOTHING_TO_COLLECT');

      const next = cloneState(s);
      const remaining: typeof next.mail = [];
      let collected = 0;
      const inbox = s.mail;

      // In Ankunftsreihenfolge, damit das Ergebnis bei knappem Platz eindeutig
      // ist. Was nicht passt, bleibt liegen — nichts verfällt hier.
      for (const item of inbox) {
        if (item.item === 'gold') {
          next.gold += item.amount;
          collected++;
          continue;
        }
        if (spaceLeft(next, rules.siloCapacity) >= item.amount) {
          if (item.item === 'wheat') next.wheat += item.amount;
          else next.eggs += item.amount;
          collected++;
        } else {
          remaining.push(item);
        }
      }

      if (collected === 0) throw new SimError('SILO_FULL');
      next.mail = remaining;
      return next;
    }

    default:
      throw new SimError('UNKNOWN_COMMAND');
  }
}

/** Wendet eine ganze Command-Folge an. Wirft beim ersten illegalen Command. */
export function simulateAll(state: State, cmds: readonly Command[], rules: Ruleset): State {
  let s = state;
  for (const cmd of cmds) s = simulate(s, cmd, rules);
  return s;
}
