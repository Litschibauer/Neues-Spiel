/**
 * Lastmessung für die Server-Re-Simulation (Risiko R4).
 *
 *   node --experimental-strip-types scripts/bench-sync.ts
 *
 * Die zentrale Frage bei „mehrere tausend Spieler weltweit": Was kostet ein
 * Sync — und wovon hängen die Kosten ab?
 *
 * Behauptung aus §7: Dank der geschlossenen Produktionsformel kostet ein Sync
 * O(Commands), NICHT O(Offline-Dauer). Ein Spieler, der drei Wochen weg war,
 * ist damit genauso billig wie einer, der drei Minuten weg war. Das hier misst,
 * ob das stimmt.
 */

import { performance } from 'node:perf_hooks';
import { Server } from '../src/server/server.ts';
import { getRuleset, CURRENT_RULESET_VERSION } from '../src/sim/rules.ts';
import type { Ruleset } from '../src/sim/rules.ts';
import { initialState, count } from '../src/sim/state.ts';
import { advanceTo, simulate, simulateAll } from '../src/sim/sim.ts';
import { referenceRun } from '../test/helpers/session.ts';
import type { Command } from '../src/sim/commands.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);
const WHEAT = 1;
const FEED = 2;
const EGGS = 3;
const R_WHEAT = 0;
const R_FEED = 1;

/**
 * Ein Regelwerk mit beliebig vielen Feldern.
 *
 * Früher war die Feldzahl ein Parameter von `initialState`. Jetzt steht sie im
 * Regelwerk — die Spielgröße zu variieren heißt also, eine Tabelle zu bauen.
 * Genau das ist der Punkt von Phase 1.
 */
function withFields(count: number): Ruleset {
  const plots = [];
  for (let i = 0; i < count; i++) {
    plots.push({
      id: `field-${i + 1}`,
      startLevel: 1,
      levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT] }],
    });
  }
  return { ...rules, plots };
}

/** Baut einen garantiert legalen Log, indem beim Bauen mitsimuliert wird. */
function makeLog(target: number, r: Ruleset): Command[] {
  let state = initialState(r);
  const cmds: Command[] = [];
  let seq = 0;
  let tick = 0;
  const plotCount = r.plots.length;

  const tryPush = (c: Command): void => {
    try {
      state = simulate(state, c, r);
      cmds.push(c);
      seq++;
    } catch {
      /* illegal an dieser Stelle — überspringen */
    }
  };

  while (cmds.length < target) {
    for (let f = 0; f < plotCount && cmds.length < target; f++) {
      tryPush({ seq: seq + 1, tick, type: 'START', plot: f, recipe: R_WHEAT });
    }
    tick += r.recipes[R_WHEAT]!.durationTicks;

    for (let f = 0; f < plotCount && cmds.length < target; f++) {
      tryPush({ seq: seq + 1, tick, type: 'COLLECT', plot: f });
    }

    // Lager leeren, damit die Ernte nicht am Limit hängen bleibt.
    for (const item of [WHEAT, FEED, EGGS]) {
      const peek = advanceTo(state, tick, r);
      const have = count(peek, item);
      if (have > 0 && cmds.length < target) {
        tryPush({ seq: seq + 1, tick, type: 'SELL_NPC', item, amount: have });
      }
    }
  }

  return cmds.slice(0, target);
}

function timeSyncs(cmds: Command[], nowMs: number, runs: number): number {
  // Aufwärmen, damit die JIT-Kompilierung nicht mitgemessen wird.
  for (let i = 0; i < 20; i++) {
    const s = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
    s.sync({ baseSeq: 0, rulesetVersion: CURRENT_RULESET_VERSION, commands: cmds }, nowMs);
  }

  const servers = Array.from(
    { length: runs },
    () => new Server(initialState(rules), T0, CURRENT_RULESET_VERSION),
  );
  const req = { baseSeq: 0, rulesetVersion: CURRENT_RULESET_VERSION, commands: cmds };

  const start = performance.now();
  for (const s of servers) s.sync(req, nowMs);
  return (performance.now() - start) / runs;
}

const DAY_MS = 86_400_000;

console.log('\n=== A) Kosten vs. Offline-DAUER (Log konstant: 100 Commands) ===');
console.log('Erwartung: flach. Die Dauer wird in geschlossener Form verrechnet.\n');

const fixedLog = makeLog(100, rules);
const lastTick = fixedLog[fixedLog.length - 1]!.tick;
const minMs = T0 + lastTick * 1000;

for (const [label, nowMs] of [
  ['1 Stunde', Math.max(minMs, T0 + 3_600_000)],
  ['1 Tag', Math.max(minMs, T0 + DAY_MS)],
  ['1 Woche', Math.max(minMs, T0 + 7 * DAY_MS)],
  ['30 Tage', Math.max(minMs, T0 + 30 * DAY_MS)],
  ['1 Jahr', Math.max(minMs, T0 + 365 * DAY_MS)],
] as Array<[string, number]>) {
  const ms = timeSyncs(fixedLog, nowMs, 2000);
  console.log(`  ${label.padEnd(10)} ${(ms * 1000).toFixed(1).padStart(7)} µs / Sync`);
}

console.log('\n=== B) Kosten vs. Command-ANZAHL (Dauer konstant) ===');
console.log('Erwartung: linear.\n');

for (const n of [10, 50, 100, 500, 1000, 2000]) {
  const log = makeLog(n, rules);
  const now = Math.max(T0 + log[log.length - 1]!.tick * 1000, T0 + DAY_MS);
  const ms = timeSyncs(log, now, n > 500 ? 300 : 2000);
  console.log(
    `  ${String(n).padStart(5)} Commands  ${(ms * 1000).toFixed(1).padStart(8)} µs` +
      `   (${((ms * 1000) / n).toFixed(2)} µs/Command)`,
  );
}

console.log('\n=== C) Was die geschlossene Form spart ===');
console.log('Derselbe Log, einmal segmentweise und einmal Tick für Tick.\n');

const cmp = makeLog(100, rules);
const cmpNow = T0 + 30 * DAY_MS;
const closed = timeSyncs(cmp, cmpNow, 2000);

// Nur die Command-Spanne, Tick für Tick.
const refStart = performance.now();
referenceRun(initialState(rules), cmp, rules);
const naiveSpan = performance.now() - refStart;

// Und das, was ein O(Zeit)-Server für 30 Tage Abwesenheit zusätzlich täte.
const naiveAdvanceStart = performance.now();
let held = 0;
let progress = 0;
const interval = rules.recipes[R_FEED]!.durationTicks;
const ticks30d = Math.floor((30 * DAY_MS) / 1000);
for (let i = 0; i < ticks30d; i++) {
  if (held < rules.siloCapacity) {
    progress++;
    if (progress >= interval) {
      held++;
      progress = 0;
    }
  }
}
const naiveAdvance = performance.now() - naiveAdvanceStart;
const naiveTotal = naiveSpan + naiveAdvance;

console.log(`  geschlossen (§7), ganzer Sync:   ${(closed * 1000).toFixed(1)} µs`);
console.log(`  Tick für Tick, Command-Spanne:   ${naiveSpan.toFixed(1)} ms`);
console.log(`  Tick für Tick, 30 Tage aufholen: ${naiveAdvance.toFixed(1)} ms`);
console.log(`  ────────────────────────────────────────────`);
console.log(`  Faktor insgesamt:                ~${Math.round(naiveTotal / closed)}x`);
console.log('\n  Und der Abstand WÄCHST mit der Abwesenheit: die geschlossene Form');
console.log('  bleibt bei denselben Mikrosekunden, die naive Variante nicht.');

console.log('\n=== D) Kosten vs. SPIELGRÖSSE ===');
console.log('Wächst der Sync mit, wenn das Spiel mehr Inhalt hat?');
console.log('(Reine Re-Simulation, ohne Sync-Rahmen — der ist von der Größe unabhängig.)\n');

for (const fieldCount of [6, 60, 600, 3000]) {
  const big = withFields(fieldCount);
  const log = makeLog(100, big);
  const start0 = initialState(big);

  for (let i = 0; i < 20; i++) simulateAll(start0, log, big);
  const runs = 500;
  const start = performance.now();
  for (let i = 0; i < runs; i++) simulateAll(start0, log, big);
  const ms = (performance.now() - start) / runs;

  console.log(
    `  ${String(fieldCount).padStart(5)} Felder, 100 Commands  ${(ms * 1000).toFixed(1).padStart(8)} µs`,
  );
}

console.log('\n  Anfangs war das hier LINEAR und rund 11x teurer: Jeder einzelne');
console.log('  Command hat den ganzen Zustand tiefkopiert. Bei sechs Feldern');
console.log('  unsichtbar, bei einem großen Spiel der Engpass. Seither teilen');
console.log('  Zustände ihre Arrays und ersetzen nur das geänderte Element.');
console.log('\n  Ehrlich bleibt: Es ist NICHT flach. Ein Array-Ersetzen kopiert die');
console.log('  Referenzen, also weiterhin O(Commands x Objekte) — nur mit sehr viel');
console.log('  kleinerem Faktor. Für Spielgrößen, die ein Farmgame je erreicht');
console.log('  (Hunderte Objekte), liegt das im zweistelligen Mikrosekundenbereich.');
console.log('  Wirklich flach würde es erst mit persistenten Datenstrukturen —');
console.log('  lohnt sich, wenn ein Spielstand mal Zehntausende Objekte trägt.');

console.log('\n=== E) Durchsatz-Abschätzung ===\n');

const typical = makeLog(60, rules);
const typicalMs = timeSyncs(typical, T0 + 2 * DAY_MS, 3000);
const perCore = Math.round(1000 / typicalMs);
const playersPerCore = Math.round((perCore * 300) / 1_000_000);

console.log(`  Typischer Sync (60 Commands):   ${(typicalMs * 1000).toFixed(1)} µs`);
console.log(`  Ein Kern schafft:               ~${perCore.toLocaleString('de-DE')} Syncs pro Sekunde`);
console.log(`  Bei 1 Sync alle 5 min:          ~${playersPerCore} Mio. Spieler pro Kern`);
console.log('\n  (Reine Sim-Kosten. Netzwerk, Auth und Persistenz kommen obendrauf');
console.log('   und dominieren in der Praxis um Größenordnungen — genau das ist');
console.log('   die Aussage: die Re-Simulation ist NICHT der Engpass.)\n');
