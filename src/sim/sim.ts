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
import { cloneState, spaceLeft } from './state.ts';
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
  if (elapsed === 0) return state;

  const { eggs, coopProgress } = advanceCoop(
    elapsed,
    state.coopProgress,
    spaceLeft(state, rules.siloCapacity),
    rules.coopTicksPerEgg,
  );

  const next = cloneState(state);
  next.tick = toTick;
  next.eggs += eggs;
  next.coopProgress = coopProgress;
  return next;
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
      next.fields[cmd.field] = { crop: 'wheat', plantedAt: s.tick };
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
      next.fields[cmd.field] = { crop: null, plantedAt: 0 };
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
