/**
 * Geteilte Testwerkzeuge: Zufallssitzungen und die Tick-für-Tick-Grundwahrheit.
 *
 * Wird sowohl vom Session-Fuzz als auch vom Generator der Golden Vectors benutzt,
 * damit beide dieselbe Definition von „richtig" verwenden.
 *
 * Seit Inhalt Daten ist, laufen beide über MEHRERE Regelwerke: v1 hat sechs
 * Felder und einen Stall, v3 zusätzlich Mühle, Bäckerei und Weide. Damit prüft
 * der Fuzz nicht nur die Sim, sondern auch die Behauptung, dass neuer Inhalt
 * wirklich nur eine Tabellenzeile ist.
 */

import { Client } from '../../src/client/client.ts';
import { getRuleset } from '../../src/sim/rules.ts';
import type { Ruleset } from '../../src/sim/rules.ts';
import { EMPTY_PLOT, cloneState, count, stored } from '../../src/sim/state.ts';
import { simulate } from '../../src/sim/sim.ts';
import { advancePassivesReference } from '../../src/sim/produce.ts';
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
 * die geschlossene Form aus §7 antreten muss — inklusive des Rennens mehrerer
 * passiver Produzenten um denselben Lagerplatz.
 */
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
          if (free <= 0) continue; // blockiert — friert ein, sammelt keinen Fortschritt
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
    // s.tick === cmd.tick → advanceTo schreibt nichts mehr fort, nur die
    // Auftragsfrist läuft noch (das ist Absicht, siehe sim.ts).
    s = simulate(s, cmd, rules);
  }
  return s;
}

/** Absicherung, dass die ausgeschriebene Schleife oben nicht abgedriftet ist. */
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

export type SessionOptions = {
  steps: number;
  maxAdvance: number;
  /** Anteil der Schritte, die nur die Uhr vorstellen. */
  advanceChance: number;
  /** Anteil rein zufälliger (meist illegaler) Aktionen — testet den Ablehnpfad. */
  chaosChance: number;
};

/** Rezepte, die auf diesem Platz laufen dürfen UND deren Zutaten da sind. */
function affordableRecipes(s: State, rules: Ruleset, plot: number): number[] {
  const def = rules.plots[plot];
  if (!def) return [];
  return def.recipes.filter((r) =>
    rules.recipes[r]!.inputs.every((input) => count(s, input.item) >= input.amount),
  );
}

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
  const rules = getRuleset(snapshot.rulesetVersion);
  const client = new Client(snapshot);
  const pick = (n: number) => Math.floor(rnd() * n);
  const tradable = rules.items
    .map((_, i) => i)
    .filter((i) => rules.items[i]!.storable && rules.items[i]!.npcPrice > 0);

  for (let i = 0; i < opts.steps; i++) {
    if (rnd() < opts.advanceChance) {
      client.advanceClock(1 + pick(opts.maxAdvance));
      continue;
    }

    if (rnd() < opts.chaosChance) {
      switch (pick(3)) {
        case 0:
          client.start(pick(rules.plots.length + 1), pick(rules.recipes.length + 1));
          break;
        case 1:
          client.collect(pick(rules.plots.length + 1));
          break;
        default:
          client.sellNpc(pick(rules.items.length + 1), 1 + pick(200));
          break;
      }
      continue;
    }

    const s = client.preview();
    const idle: number[] = [];
    const done: number[] = [];
    s.plots.forEach((p, idx) => {
      if (p.recipe === EMPTY_PLOT) idle.push(idx);
      else if (s.tick - p.startedAt >= rules.recipes[p.recipe]!.durationTicks) done.push(idx);
    });

    switch (pick(6)) {
      case 0: {
        if (idle.length === 0) break;
        const plot = idle[pick(idle.length)]!;
        const options = affordableRecipes(s, rules, plot);
        if (options.length > 0) client.start(plot, options[pick(options.length)]!);
        break;
      }
      case 1:
        if (done.length) client.collect(done[pick(done.length)]!);
        break;
      case 2:
      case 3: {
        // Aus dem WIRKLICH vorhandenen Bestand wählen. Bei fünf handelbaren
        // Waren und zwei im Lager würde blindes Ziehen sonst überwiegend
        // Ablehnungen erzeugen — und der Fuzz käme nie in tiefe Zustände.
        const owned = tradable.filter((it) => count(s, it) > 0);
        if (owned.length === 0) break;
        const item = owned[pick(owned.length)]!;
        client.sellNpc(item, 1 + pick(count(s, item)));
        break;
      }
      case 4: {
        // Preis innerhalb des Bandes wählen, sonst wäre die Aktion fast immer
        // ungültig und der Auftragspfad bliebe ungetestet.
        const owned = tradable.filter((it) => count(s, it) > 0);
        if (owned.length === 0) break;
        const item = owned[pick(owned.length)]!;
        const have = count(s, item);
        const ref = rules.items[item]!.npcPrice;
        const min = Math.max(1, Math.floor((ref * rules.priceBandMinPct) / 100));
        const max = Math.floor((ref * rules.priceBandMaxPct) / 100);
        if (have > 0) client.listOrder(item, 1 + pick(have), min + pick(max - min + 1));
        break;
      }
      default:
        if (s.orders.length > 0 && rnd() < 0.5) {
          client.cancelOrder(s.orders[pick(s.orders.length)]!.id);
        } else if (s.mail.length > 0) {
          client.collectMail();
        }
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
    ...s.items.map((v, i): [string, number] => [`items[${i}]`, v]),
    ...s.passives.map((v, i): [string, number] => [`passives[${i}]`, v]),
    ...s.plots.map((p, i): [string, number] => [`plots[${i}].startedAt`, p.startedAt]),
    ...s.plots.map((p, i): [string, number] => [`plots[${i}].recipe`, p.recipe]),
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
