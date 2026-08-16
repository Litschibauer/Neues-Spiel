/**
 * Geteilte Testwerkzeuge: Zufallssitzungen und die Tick-für-Tick-Grundwahrheit.
 *
 * Wird sowohl vom Session-Fuzz als auch vom Generator der Golden Vectors benutzt,
 * damit beide dieselbe Definition von „richtig" verwenden.
 */

import { Client } from '../../src/client/client.ts';
import { getRuleset, CURRENT_RULESET_VERSION } from '../../src/sim/rules.ts';
import { cloneState, stored } from '../../src/sim/state.ts';
import { simulate } from '../../src/sim/sim.ts';
import { advanceCoopReference } from '../../src/sim/produce.ts';
import type { State } from '../../src/sim/state.ts';
import type { Command } from '../../src/sim/commands.ts';
import type { Snapshot } from '../../src/server/server.ts';

/** Deterministischer PRNG — jeder Fehlschlag ist exakt reproduzierbar. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Unabhängiger Rechenweg: Zeit stur Tick für Tick, Command-Wirkung via Sim-Kern.
 *
 * Bewusst langsam und dumm. Genau deshalb ist er die Grundwahrheit, gegen die
 * die geschlossene Form aus §7 antreten muss.
 */
export function referenceRun(start: State, cmds: readonly Command[]): State {
  const rules = getRuleset(CURRENT_RULESET_VERSION);
  let s = cloneState(start);

  for (const cmd of cmds) {
    while (s.tick < cmd.tick) {
      // Identische Semantik zu `advanceCoopReference(1, …)`, hier ausgeschrieben,
      // weil diese Schleife über Millionen Ticks läuft.
      if (stored(s) < rules.siloCapacity) {
        s.coopProgress++;
        if (s.coopProgress >= rules.coopTicksPerEgg) {
          s.eggs++;
          s.coopProgress = 0;
        }
      }
      s.tick++;
    }
    // s.tick === cmd.tick → advanceTo ist ein No-op, nur die Wirkung zählt.
    s = simulate(s, cmd, rules);
  }
  return s;
}

/** Absicherung, dass die ausgeschriebene Schleife oben nicht abgedriftet ist. */
export function referenceStepMatchesUnit(): boolean {
  for (let progress = 0; progress < 3; progress++) {
    for (let space = 0; space < 3; space++) {
      const unit = advanceCoopReference(1, progress, space, 2);
      let eggs = 0;
      let p = progress;
      if (space > 0) {
        p++;
        if (p >= 2) {
          eggs++;
          p = 0;
        }
      }
      if (unit.eggs !== eggs || unit.coopProgress !== p) return false;
    }
  }
  return true;
}

export type SessionOptions = {
  steps: number;
  maxAdvance: number;
  fieldCount: number;
  /** Anteil der Schritte, die nur die Uhr vorstellen. */
  advanceChance: number;
  /** Anteil rein zufälliger (meist illegaler) Aktionen — testet den Ablehnpfad. */
  chaosChance: number;
};

/**
 * Spielt eine zufällige Offline-Sitzung auf einem Client.
 *
 * Bewusst *zustandsbewusst*: Ein rein zufälliger Fuzzer erzeugt fast nur
 * abgelehnte Aktionen (ernten auf leeren Feldern, verkaufen ohne Ware) und
 * kommt nie in die tiefen Zustände, in denen die interessanten Bugs wohnen.
 * Über `chaosChance` bleibt trotzdem ein Anteil purer Zufall erhalten, damit
 * auch der Ablehnpfad belastet wird.
 *
 * Illegale Aktionen landen nicht im Log — genau wie bei einem echten Spieler.
 */
export function playRandomSession(
  snapshot: Snapshot,
  rnd: () => number,
  opts: SessionOptions,
): Client {
  const rules = getRuleset(CURRENT_RULESET_VERSION);
  const client = new Client(snapshot);
  const pick = (n: number) => Math.floor(rnd() * n);

  for (let i = 0; i < opts.steps; i++) {
    if (rnd() < opts.advanceChance) {
      client.advanceClock(1 + pick(opts.maxAdvance));
      continue;
    }

    if (rnd() < opts.chaosChance) {
      switch (pick(3)) {
        case 0:
          client.plant(pick(opts.fieldCount + 1));
          break;
        case 1:
          client.harvest(pick(opts.fieldCount + 1));
          break;
        default:
          client.sellNpc(rnd() < 0.5 ? 'wheat' : 'eggs', 1 + pick(200));
          break;
      }
      continue;
    }

    const s = client.preview();
    const empty: number[] = [];
    const ripe: number[] = [];
    s.fields.forEach((f, idx) => {
      if (f.crop === null) empty.push(idx);
      else if (s.tick - f.plantedAt >= rules.wheatGrowTicks) ripe.push(idx);
    });

    switch (pick(7)) {
      case 0:
        if (empty.length) client.plant(empty[pick(empty.length)]!);
        break;
      case 1:
        if (ripe.length) client.harvest(ripe[pick(ripe.length)]!);
        break;
      case 2:
        if (s.wheat > 0) client.sellNpc('wheat', 1 + pick(s.wheat));
        break;
      case 3:
        if (s.eggs > 0) client.sellNpc('eggs', 1 + pick(s.eggs));
        break;
      case 4: {
        // Preis innerhalb des Bandes wählen, sonst wäre die Aktion fast immer
        // ungültig und der Auftragspfad bliebe ungetestet.
        const item = rnd() < 0.5 ? 'wheat' : 'eggs';
        const have = item === 'wheat' ? s.wheat : s.eggs;
        const ref = rules.npcPrices[item];
        const min = Math.max(1, Math.floor((ref * rules.priceBandMinPct) / 100));
        const max = Math.floor((ref * rules.priceBandMaxPct) / 100);
        if (have > 0) client.listOrder(item, 1 + pick(have), min + pick(max - min + 1));
        break;
      }
      case 5:
        if (s.orders.length > 0) client.cancelOrder(s.orders[pick(s.orders.length)]!.id);
        break;
      default:
        if (s.mail.length > 0) client.collectMail();
        break;
    }
  }

  return client;
}

/**
 * Harte Zusicherung gegen Floats (§2.2).
 *
 * Ein einziger Float im Zustand macht bit-für-bit-Gleichheit über Plattformen
 * hinweg zur Glückssache. Diese Prüfung fängt ihn sofort.
 */
export function assertAllIntegers(s: State): void {
  const nums: Array<[string, number]> = [
    ['tick', s.tick],
    ['wheat', s.wheat],
    ['eggs', s.eggs],
    ['gold', s.gold],
    ['coopProgress', s.coopProgress],
    ...s.fields.map((f, i): [string, number] => [`fields[${i}].plantedAt`, f.plantedAt]),
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
