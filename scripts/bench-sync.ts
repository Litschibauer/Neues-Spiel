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
import { initialState } from '../src/sim/state.ts';
import { advanceTo, simulate } from '../src/sim/sim.ts';
import { referenceRun } from '../test/helpers/session.ts';
import type { Command } from '../src/sim/commands.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);

/** Baut einen garantiert legalen Log, indem beim Bauen mitsimuliert wird. */
function makeLog(target: number, fieldCount: number): Command[] {
  let state = initialState(fieldCount);
  const cmds: Command[] = [];
  let seq = 0;
  let tick = 0;

  const tryPush = (c: Command): void => {
    try {
      state = simulate(state, c, rules);
      cmds.push(c);
      seq++;
    } catch {
      /* illegal an dieser Stelle — überspringen */
    }
  };

  while (cmds.length < target) {
    for (let f = 0; f < fieldCount && cmds.length < target; f++) {
      tryPush({ seq: seq + 1, tick, type: 'PLANT', field: f });
    }
    tick += rules.wheatGrowTicks;

    for (let f = 0; f < fieldCount && cmds.length < target; f++) {
      tryPush({ seq: seq + 1, tick, type: 'HARVEST', field: f });
    }

    // Lager leeren, damit die Ernte nicht am Limit hängen bleibt.
    const peek = advanceTo(state, tick, rules);
    if (peek.wheat > 0 && cmds.length < target) {
      tryPush({ seq: seq + 1, tick, type: 'SELL_NPC', item: 'wheat', amount: peek.wheat });
    }
    const peek2 = advanceTo(state, tick, rules);
    if (peek2.eggs > 0 && cmds.length < target) {
      tryPush({ seq: seq + 1, tick, type: 'SELL_NPC', item: 'eggs', amount: peek2.eggs });
    }
  }

  return cmds.slice(0, target);
}

function timeSyncs(cmds: Command[], nowMs: number, runs: number): number {
  // Aufwärmen, damit die JIT-Kompilierung nicht mitgemessen wird.
  for (let i = 0; i < 20; i++) {
    const s = new Server(initialState(6), T0, CURRENT_RULESET_VERSION);
    s.sync({ baseSeq: 0, rulesetVersion: CURRENT_RULESET_VERSION, commands: cmds }, nowMs);
  }

  const servers = Array.from(
    { length: runs },
    () => new Server(initialState(6), T0, CURRENT_RULESET_VERSION),
  );
  const req = { baseSeq: 0, rulesetVersion: CURRENT_RULESET_VERSION, commands: cmds };

  const start = performance.now();
  for (const s of servers) s.sync(req, nowMs);
  return (performance.now() - start) / runs;
}

const DAY_MS = 86_400_000;

console.log('\n=== A) Kosten vs. Offline-DAUER (Log konstant: 100 Commands) ===');
console.log('Erwartung: flach. Die Dauer wird in geschlossener Form verrechnet.\n');

const fixedLog = makeLog(100, 6);
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
  const log = makeLog(n, 6);
  const now = Math.max(T0 + log[log.length - 1]!.tick * 1000, T0 + DAY_MS);
  const ms = timeSyncs(log, now, n > 500 ? 300 : 2000);
  console.log(
    `  ${String(n).padStart(5)} Commands  ${(ms * 1000).toFixed(1).padStart(8)} µs` +
      `   (${((ms * 1000) / n).toFixed(2)} µs/Command)`,
  );
}

console.log('\n=== C) Was die geschlossene Form spart ===');
console.log('Derselbe Log, einmal segmentweise und einmal Tick für Tick.\n');

const cmp = makeLog(100, 6);
const cmpNow = T0 + 30 * DAY_MS;
const closed = timeSyncs(cmp, cmpNow, 2000);

// Nur die Command-Spanne, Tick für Tick.
const refStart = performance.now();
referenceRun(initialState(6), cmp);
const naiveSpan = performance.now() - refStart;

// Und das, was ein O(Zeit)-Server für 30 Tage Abwesenheit zusätzlich täte.
const naiveAdvanceStart = performance.now();
let st = initialState(6);
const ticks30d = (30 * DAY_MS) / 1000;
for (let i = 0; i < ticks30d; i++) {
  if (st.wheat + st.eggs < rules.siloCapacity) {
    st.coopProgress++;
    if (st.coopProgress >= rules.coopTicksPerEgg) {
      st.eggs++;
      st.coopProgress = 0;
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

console.log('\n=== D) Durchsatz-Abschätzung ===\n');

const typical = makeLog(60, 6);
const typicalMs = timeSyncs(typical, T0 + 2 * DAY_MS, 3000);
const perCore = Math.round(1000 / typicalMs);
const playersPerCore = Math.round((perCore * 300) / 1_000_000);

console.log(`  Typischer Sync (60 Commands):   ${(typicalMs * 1000).toFixed(1)} µs`);
console.log(`  Ein Kern schafft:               ~${perCore.toLocaleString('de-DE')} Syncs pro Sekunde`);
console.log(`  Bei 1 Sync alle 5 min:          ~${playersPerCore} Mio. Spieler pro Kern`);
console.log('\n  (Reine Sim-Kosten. Netzwerk, Auth und Persistenz kommen obendrauf');
console.log('   und dominieren in der Praxis um Größenordnungen — genau das ist');
console.log('   die Aussage: die Re-Simulation ist NICHT der Engpass.)\n');
