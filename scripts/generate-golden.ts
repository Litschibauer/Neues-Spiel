import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from '../src/server/server.ts';
import { RULESETS, getRuleset, levelOf } from '../src/sim/rules.ts';
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
    name: 'trade',
    opts: { steps: 45, maxAdvance: 90_000, advanceChance: 0.4, chaosChance: 0.05 },
    seeds: [1, 2, 3, 5, 8, 13, 21, 34, 55, 89],
  },
  {
    name: 'hoard',
    opts: { steps: 120, maxAdvance: 1500, advanceChance: 0.45, chaosChance: 0.05, hoard: true },
    seeds: [1, 2, 3, 5, 8, 13, 21, 34, 55, 89],
  },
];

const VERSIONS = [...RULESETS.keys()].sort((a, b) => a - b);

const vectors = [];

for (const profile of PROFILES) {
  for (const seed of profile.seeds) {
    for (const version of VERSIONS) {
      for (const gold of [0, 4000]) {
        const rnd = mulberry32(seed * 7919 + version + gold);
        const rules = getRuleset(version);
        const start = fuzzStart(rules, gold, mulberry32(seed * 31 + version));
        const server = new Server(start, T0, version);
        const client = playRandomSession(server.snapshot, rnd, profile.opts);

        if (client.queue.length === 0) continue;

        vectors.push({
          name: `${profile.name}-v${version}-${gold > 0 ? 'rich' : 'poor'}-${String(seed).padStart(3, '0')}`,
          rulesetVersion: version,
          startState: start,
          commands: client.queue,
          expectedStateHash: hashState(client.state),
          expectedState: client.state,
        });
      }
    }
  }
}

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
  const start = fuzzStart(rules, 0, mulberry32(4242 + version));
  let state = start;
  let tick = 0;
  const push = (c: Omit<Command, 'seq' | 'tick'>) => {
    const cmd = { ...c, seq: cmds.length + 1, tick } as Command;
    state = simulate(state, cmd, rules);
    cmds.push(cmd);
  };
  const wait = (recipe: number) => {
    tick += rules.recipes[recipe]!.durationTicks;
  };

  const SEED = rules.recipes[R_WHEAT]!.inputs.find((i) => i.item === WHEAT)?.amount ?? 0;
  const seedsForARound = 3 * SEED;
  const restock = () => {
    const missing = seedsForARound - state.items[WHEAT]!;
    if (missing > 0) push({ type: 'BUY_NPC', item: WHEAT, amount: missing });
  };
  const sowThreeFields = () => {
    restock();
    for (let plot = 0; plot < 3; plot++) push({ type: 'START', plot, recipe: R_WHEAT });
    wait(R_WHEAT);
    for (let plot = 0; plot < 3; plot++) push({ type: 'COLLECT', plot });
  };

  const goal =
    rules.plots[MILL]!.levels[0]!.cost[0]!.amount +
    rules.plots[COOP]!.levels[0]!.cost[0]!.amount +
    rules.plots[COOP]!.levels[1]!.cost[0]!.amount;
  const needLevel = Math.max(
    rules.plots[MILL]!.levels[0]!.minPlayerLevel ?? 1,
    rules.plots[COOP]!.levels[0]!.minPlayerLevel ?? 1,
  );

  for (let round = 0; round < 200; round++) {
    if (state.items[rules.currency]! >= goal && levelOf(rules, state.xp) >= needLevel) break;

    sowThreeFields();

    for (;;) {
      const fillable = state.requests
        .slice(0, rules.requestSlots)
        .find((r) => r.wants.every((w) => (state.items[w.item] ?? 0) >= w.amount));
      if (!fillable) break;
      push({ type: 'FILL_REQUEST', requestId: fillable.id });
    }

    const keep = seedsForARound;
    const sellable = state.items[WHEAT]! - keep;
    if (sellable > 0) push({ type: 'SELL_NPC', item: WHEAT, amount: sellable });
  }

  push({ type: 'BUY', plot: MILL });

  const haveAll = () =>
    rules.recipes[R_FEED]!.inputs.every((i) => (state.items[i.item] ?? 0) >= i.amount);
  for (let guard = 0; guard < 50 && !haveAll(); guard++) {
    for (const input of rules.recipes[R_FEED]!.inputs) {
      const missing = input.amount - (state.items[input.item] ?? 0);
      if (missing <= 0) continue;

      if (input.item === WHEAT) sowThreeFields();
      else if (rules.items[input.item]!.npcBuyPrice > 0) {
        push({ type: 'BUY_NPC', item: input.item, amount: missing });
      }
    }
  }

  push({ type: 'START', plot: MILL, recipe: R_FEED });
  wait(R_FEED);
  push({ type: 'COLLECT', plot: MILL });

  const coopCost =
    rules.plots[COOP]!.levels[0]!.cost[0]!.amount + rules.plots[COOP]!.levels[1]!.cost[0]!.amount;
  for (let round = 0; round < 200 && state.items[rules.currency]! < coopCost; round++) {
    sowThreeFields();
    for (;;) {
      const fillable = state.requests
        .slice(0, rules.requestSlots)
        .find((r) => r.wants.every((w) => (state.items[w.item] ?? 0) >= w.amount));
      if (!fillable) break;
      push({ type: 'FILL_REQUEST', requestId: fillable.id });
    }
    const sellable = state.items[WHEAT]! - seedsForARound;
    if (sellable > 0) push({ type: 'SELL_NPC', item: WHEAT, amount: sellable });
  }

  push({ type: 'BUY', plot: COOP });
  push({ type: 'BUY', plot: COOP });
  push({ type: 'START', plot: COOP, recipe: R_EGGS });
  wait(R_EGGS);
  push({ type: 'COLLECT', plot: COOP });

  const last = state.requests
    .slice(0, rules.requestSlots)
    .find((r) => r.wants.every((w) => (state.items[w.item] ?? 0) >= w.amount));
  if (last) push({ type: 'FILL_REQUEST', requestId: last.id });
  else push({ type: 'SELL_NPC', item: EGGS, amount: state.items[EGGS]! });

  return {
    name: `core-loop-v${version}`,
    rulesetVersion: version,
    startState: start,
    commands: cmds,
    expectedStateHash: hashState(state),
    expectedState: state,
  };
}


function coreLoopBrett(version: number) {
  const rules = getRuleset(version);
  const R_WHEAT = 0;
  const R_FEED = 1;
  const R_EGGS = 2;
  const MILL = rules.plots.findIndex((p) => p.id === 'mill');
  const COOP = rules.plots.findIndex((p) => p.id === 'coop-1');
  const WHEAT = rules.items.findIndex((i) => i.id === 'wheat');

  const cmds: Command[] = [];
  const start = fuzzStart(rules, 0, mulberry32(9090 + version));
  let state = start;
  let tick = 0;
  const push = (c: Omit<Command, 'seq' | 'tick'>) => {
    const cmd = { ...c, seq: cmds.length + 1, tick } as Command;
    state = simulate(state, cmd, rules);
    cmds.push(cmd);
  };
  const versuche = (c: Omit<Command, 'seq' | 'tick'>): boolean => {
    try {
      push(c);
      return true;
    } catch {
      return false;
    }
  };

  const platziere = (plot: number): void => {
    const raster = rules.grid;
    if (!raster || state.plots[plot]!.gx >= 0) return;
    const groesse = rules.plots[plot]!.size ?? { w: 1, h: 1 };
    for (let gy = 0; gy <= raster.h - groesse.h; gy++) {
      for (let gx = 0; gx <= raster.w - groesse.w; gx++) {
        if (versuche({ type: 'PLACE', plot, gx, gy })) return;
      }
    }
    return;
  };

  const saat = () => state.items[WHEAT] ?? 0;
  const felder = rules.plots
    .map((p, i) => i)
    .filter((i) => rules.plots[i]!.id.startsWith('field-') && state.plots[i]!.level > 0);

  const runde = () => {
    if (saat() === 0) versuche({ type: 'BUY_NPC', item: WHEAT, amount: 1 });
    let gesetzt = 0;
    for (const plot of felder) {
      if (saat() <= 0) break;
      if (versuche({ type: 'START', plot, slot: 0, recipe: R_WHEAT })) gesetzt++;
    }
    if (gesetzt === 0) return;
    tick += rules.recipes[R_WHEAT]!.durationTicks;
    for (const plot of felder) versuche({ type: 'COLLECT', plot, slot: 0 });

    for (let slot = 0; slot < rules.requestSlots; slot++) {
      const zettel = state.requests[slot];
      if (!zettel) continue;
      if (!zettel.wants.every((w) => (state.items[w.item] ?? 0) >= w.amount)) continue;
      if (state.tick < state.truck.awayUntil) continue;
      if (versuche({ type: 'SEND_SLIP', slot })) {
        tick += rules.truckAwayTicks ?? 0;
        break;
      }
    }
  };

  const ziel =
    rules.plots[MILL]!.levels[0]!.cost[0]!.amount + rules.plots[COOP]!.levels[0]!.cost[0]!.amount;
  const brauchtStufe = Math.max(
    rules.plots[MILL]!.levels[0]!.minPlayerLevel ?? 1,
    rules.plots[COOP]!.levels[0]!.minPlayerLevel ?? 1,
  );

  for (let i = 0; i < 400; i++) {
    if ((state.items[rules.currency] ?? 0) >= ziel && levelOf(rules, state.xp) >= brauchtStufe) {
      break;
    }
    runde();
  }

  if (versuche({ type: 'BUY', plot: MILL })) platziere(MILL);
  for (let i = 0; i < 30; i++) {
    if (rules.recipes[R_FEED]!.inputs.every((x) => (state.items[x.item] ?? 0) >= x.amount)) break;
    runde();
  }
  if (versuche({ type: 'START', plot: MILL, slot: 0, recipe: R_FEED })) {
    tick += rules.recipes[R_FEED]!.durationTicks;
    versuche({ type: 'COLLECT', plot: MILL, slot: 0 });
  }

  for (let i = 0; i < 200; i++) {
    if ((state.items[rules.currency] ?? 0) >= rules.plots[COOP]!.levels[0]!.cost[0]!.amount) break;
    runde();
  }
  if (versuche({ type: 'BUY', plot: COOP })) {
    platziere(COOP);
    if (versuche({ type: 'START', plot: COOP, slot: 0, recipe: R_EGGS })) {
      tick += rules.recipes[R_EGGS]!.durationTicks;
      versuche({ type: 'COLLECT', plot: COOP, slot: 0 });
    }
  }

  for (let i = 0; i < 40; i++) runde();

  return {
    name: `core-loop-v${version}`,
    rulesetVersion: version,
    startState: start,
    commands: cmds,
    expectedStateHash: hashState(state),
    expectedState: state,
  };
}

for (const version of VERSIONS) {
  const rules = getRuleset(version);
  vectors.push(rules.boardDeliveryOnly ? coreLoopBrett(version) : coreLoopVector(version));
}

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
