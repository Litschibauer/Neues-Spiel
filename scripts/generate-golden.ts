/**
 * Generator für die Golden Vectors.
 *
 *   node --experimental-strip-types scripts/generate-golden.ts
 *
 * Erzeugt `test/vectors/golden.json`: einen Korpus aus expliziten Command-Logs
 * mit dem jeweils erwarteten Endzustand.
 *
 * WICHTIG — warum explizite Commands und keine Seeds:
 * Die Vektoren sollen von *jeder* Plattform abspielbar sein (iOS, Android,
 * WASM, Server). Ein Seed würde voraussetzen, dass dort derselbe PRNG bitgenau
 * dasselbe liefert — also genau die Annahme, die wir eigentlich prüfen wollen.
 * Deshalb steht jeder Command ausgeschrieben in der Datei.
 *
 * Neu erzeugen ist eine BEWUSSTE Handlung: Ändern sich die Vektoren, ohne dass
 * jemand die Regeln absichtlich geändert hat, ist das ein Determinismus-Bug.
 * Eine echte Regeländerung gehört in eine neue Ruleset-Version (R2), nicht in
 * überschriebene Golden Vectors.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from '../src/server/server.ts';
import { RULESETS, getRuleset } from '../src/sim/rules.ts';
import { hashState } from '../src/sim/hash.ts';
import { simulate } from '../src/sim/sim.ts';
import type { Command } from '../src/sim/commands.ts';
import { fuzzStart, mulberry32, playRandomSession } from '../test/helpers/session.ts';
import type { SessionOptions } from '../test/helpers/session.ts';

const T0 = 1_700_000_000_000;

const PROFILES: Array<{ name: string; opts: SessionOptions; seeds: number[] }> = [
  {
    name: 'busy',
    opts: { steps: 40, maxAdvance: 4000, advanceChance: 0.3, chaosChance: 0.25 },
    seeds: [1, 2, 3, 5, 8, 13, 21, 34, 55, 89],
  },
  {
    name: 'idle',
    opts: { steps: 20, maxAdvance: 20_000, advanceChance: 0.6, chaosChance: 0.1 },
    seeds: [1, 2, 3, 5, 8, 13, 21, 34, 55, 89],
  },
  {
    // Lange Zeitachse, damit Auftraege die Frist reissen, ins Postfach fallen
    // und wieder abgeholt werden. Ohne dieses Profil bliebe der ganze
    // Verfalls- und Postfachpfad im Korpus unabgedeckt.
    name: 'trade',
    opts: { steps: 45, maxAdvance: 90_000, advanceChance: 0.4, chaosChance: 0.05 },
    seeds: [1, 2, 3, 5, 8, 13, 21, 34, 55, 89],
  },
  {
    // Nie verkaufen: der einzige verlaessliche Weg ans volle Lager.
    name: 'hoard',
    opts: { steps: 60, maxAdvance: 1500, advanceChance: 0.45, chaosChance: 0.05, hoard: true },
    seeds: [1, 2, 3, 5, 8, 13, 21, 34, 55, 89],
  },
];

/**
 * Jeder Vektor trägt seine eigene Regelversion.
 *
 * Seit Inhalt Daten ist, ist der Katalog Teil dessen, was bewiesen werden muss.
 * Der Korpus deckt deshalb jedes ausgelieferte Regelwerk ab — die
 * Produktionsreihe und das Dev-Tempo.
 */
const VERSIONS = [...RULESETS.keys()].sort((a, b) => a - b);

const vectors = [];

for (const profile of PROFILES) {
  for (const seed of profile.seeds) {
    for (const version of VERSIONS) {
      for (const gold of [0, 4000]) {
        const rnd = mulberry32(seed * 7919 + version + gold);
        const rules = getRuleset(version);
        const server = new Server(fuzzStart(rules, gold), T0, version);
        const client = playRandomSession(server.snapshot, rnd, profile.opts);

        if (client.queue.length === 0) continue;

        vectors.push({
          name: `${profile.name}-v${version}-${gold > 0 ? 'rich' : 'poor'}-${String(seed).padStart(3, '0')}`,
          rulesetVersion: version,
          startGold: gold,
          commands: client.queue,
          expectedStateHash: hashState(client.state),
          expectedState: client.state,
        });
      }
    }
  }
}

/**
 * Ein handgeschriebener Vektor für den Kernkreislauf.
 *
 * Die Zufallssitzungen decken breit ab, aber niemand kann ihnen ansehen, WAS
 * sie prüfen. Dieser hier läuft den Weg, um den es im Spiel geht, in genau der
 * Reihenfolge: Feld -> Weizen -> verkaufen -> Mühle kaufen -> Futter mahlen ->
 * Gehege kaufen -> Hühner kaufen -> füttern -> warten -> Eier sammeln.
 *
 * Er ist damit gleichzeitig Abnahmetest und lesbare Dokumentation des Loops.
 */
function coreLoopVector(version: number) {
  const rules = getRuleset(version);
  const R_WHEAT = 0;
  const R_FEED = 1;
  const R_EGGS = 2;
  const MILL = rules.plots.findIndex((p) => p.id === 'mill');
  const COOP = rules.plots.findIndex((p) => p.id === 'coop-1');
  const WHEAT = rules.items.findIndex((i) => i.id === 'wheat');
  const EGGS = rules.items.findIndex((i) => i.id === 'eggs');

  const cmds: Command[] = [];
  let state = fuzzStart(rules, 0);
  let tick = 0;
  const push = (c: Omit<Command, 'seq' | 'tick'>) => {
    const cmd = { ...c, seq: cmds.length + 1, tick } as Command;
    state = simulate(state, cmd, rules);
    cmds.push(cmd);
  };
  const wait = (recipe: number) => {
    tick += rules.recipes[recipe]!.durationTicks;
  };

  // Genug Weizen anbauen und verkaufen, um Mühle + Gehege + Hühner zu zahlen.
  const goal =
    rules.plots[MILL]!.levels[0]!.cost[0]!.amount +
    rules.plots[COOP]!.levels[0]!.cost[0]!.amount +
    rules.plots[COOP]!.levels[1]!.cost[0]!.amount;

  while (state.items[rules.currency]! < goal) {
    for (let plot = 0; plot < 3; plot++) push({ type: 'START', plot, recipe: R_WHEAT });
    wait(R_WHEAT);
    for (let plot = 0; plot < 3; plot++) push({ type: 'COLLECT', plot });
    // Etwas Weizen zurückbehalten, sonst fehlt später das Mahlgut.
    const keep = 3;
    const sellable = state.items[WHEAT]! - keep;
    if (sellable > 0) push({ type: 'SELL_NPC', item: WHEAT, amount: sellable });
  }

  push({ type: 'BUY', plot: MILL });
  push({ type: 'START', plot: MILL, recipe: R_FEED });
  wait(R_FEED);
  push({ type: 'COLLECT', plot: MILL });

  push({ type: 'BUY', plot: COOP }); // Gehege
  push({ type: 'BUY', plot: COOP }); // Hühner
  push({ type: 'START', plot: COOP, recipe: R_EGGS }); // füttern
  wait(R_EGGS);
  push({ type: 'COLLECT', plot: COOP }); // Eier sammeln
  push({ type: 'SELL_NPC', item: EGGS, amount: state.items[EGGS]! });

  return {
    name: `core-loop-v${version}`,
    rulesetVersion: version,
    startGold: 0,
    commands: cmds,
    expectedStateHash: hashState(state),
    expectedState: state,
  };
}

for (const version of VERSIONS) vectors.push(coreLoopVector(version));

const doc = {
  $comment:
    'Golden Vectors für den Sim-Kern. Jede Plattform (iOS, Android, WASM, Server) muss ' +
    'diesen Korpus abspielen und exakt dieselben Endzustände liefern. Abweichung = ' +
    'Determinismus-Bug (R1). Nicht von Hand bearbeiten — siehe scripts/generate-golden.ts.',
  rulesetVersions: VERSIONS,
  vectorCount: vectors.length,
  vectors,
};

const outDir = join(import.meta.dirname, '..', 'test', 'vectors');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'golden.json'), JSON.stringify(doc, null, 2) + '\n');

const commandCount = vectors.reduce((n, v) => n + v.commands.length, 0);
console.log(`${vectors.length} Vektoren, ${commandCount} Commands → test/vectors/golden.json`);
