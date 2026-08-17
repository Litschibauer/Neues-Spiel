/**
 * Trägt ein Server das?
 *
 *   node --experimental-strip-types scripts/bench-scale.ts [höfe] [runden]
 *
 * Die Frage ist nicht „wie schnell ist ein Sync" — das misst `bench-sync.ts`.
 * Hier geht es um die Größe, an der ein einzelner Server kippt: **wie viele
 * gleichzeitige Spieler**, ohne Loadbalancer, ohne Regionen.
 *
 * Gemessen wird das, was dabei wirklich weh tut, und das ist selten die
 * Rechenzeit:
 *
 *  - **Schreiblast.** Die alte Fassung schrieb bei jedem Sync eine ganze Datei,
 *    und der Command-Log darin wuchs unbegrenzt. Der Aufwand einer Sitzung
 *    stieg damit quadratisch — für EINEN Spieler 344 MB über 6000 Aktionen.
 *  - **Speicher.** Jeder benutzte Hof bleibt geladen. Bei ein paar tausend
 *    Spielern entscheidet sich hier, ob 1 GB RAM reichen.
 *
 * Der Lauf simuliert echte Sitzungen über den echten Sim-Kern und den echten
 * Speicher — keine Attrappe. Was hier steht, gilt.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore } from '../src/server/accounts.ts';
import { Market, connectMarket, publishOrders } from '../src/server/market.ts';
import { Server } from '../src/server/server.ts';
import { Client } from '../src/client/client.ts';
import { CURRENT_RULESET_VERSION, getRuleset } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';

const FARMS = Number(process.argv[2] ?? 2000);
const ROUNDS = Number(process.argv[3] ?? 30);
const FLUSH_EVERY = 8; // entspricht dem Sammel-Takt des Servers

const rules = getRuleset(CURRENT_RULESET_VERSION);
const T0 = 1_700_000_000_000;
const R_WHEAT = 0;
const WHEAT = 1;
const duration = rules.recipes[R_WHEAT]!.durationTicks;

const dir = mkdtempSync(join(tmpdir(), 'ns-bench-'));
const dbPath = join(dir, 'spiel.db');
const accounts = new AccountStore(dbPath);
const market = new Market(accounts.storage);
const live = new Map<string, Server>();

console.log(`\n${FARMS} Höfe, ${ROUNDS} Runden je Hof — echter Kern, echter Speicher\n`);

// ── Höfe anlegen ─────────────────────────────────────────────────────────
const created = process.hrtime.bigint();
const ids: string[] = [];
for (let i = 0; i < FARMS; i++) {
  const game = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  game.stockRequests();
  const { account } = accounts.create(T0, {
    snapshot: game.snapshot,
    appliedLog: [],
    logStartSeq: 1,
    pendingDeliveries: [],
    targetRulesetVersion: CURRENT_RULESET_VERSION,
    nextRequestId: game.nextRequestId,
  });
  connectMarket(market, account.id, game, (id) => live.get(id) ?? null);
  live.set(account.id, game);
  ids.push(account.id);
}
console.log(`Anlegen:   ${(Number(process.hrtime.bigint() - created) / 1e6).toFixed(0)} ms`);

// ── Spielen ──────────────────────────────────────────────────────────────
//
// Eine Runde je Hof ist eine Sitzung, wie sie wirklich vorkommt: säen, ernten,
// verkaufen, gelegentlich am Markt anbieten. Alles über die echten Commands.
let syncs = 0;
let writes = 0;
const start = process.hrtime.bigint();

for (let round = 1; round <= ROUNDS; round++) {
  const nowMs = T0 + round * (duration + 10) * 1000;

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const game = live.get(id)!;
    const account = accounts.get(id)!;

    const client = new Client(game.snapshot);
    client.start(0, R_WHEAT);
    client.advanceClock(duration);
    client.collect(0);
    // Jeder zehnte Hof bietet an statt zu verkaufen — sonst bliebe der Markt
    // leer und die Buchführung ungemessen.
    if (i % 10 === 0 && round % 5 === 0) client.listOrder(WHEAT, 10, rules.items[WHEAT]!.npcPrice);
    else client.sellNpc(WHEAT, 10);

    game.sync(client.buildSyncRequest(), nowMs);
    publishOrders(market, id, game);
    accounts.save(
      { ...account, lastSeenMs: nowMs },
      {
        snapshot: game.snapshot,
        appliedLog: game.appliedLog,
        logStartSeq: game.logStartSeq,
        pendingDeliveries: game.pendingDeliveries,
        targetRulesetVersion: CURRENT_RULESET_VERSION,
        nextRequestId: game.nextRequestId,
      },
    );
    syncs++;
  }

  if (round % FLUSH_EVERY === 0) {
    writes += accounts.flush();
    market.flush();
  }
}

writes += accounts.flush();
market.flush();

const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
const dbBytes = statSync(dbPath).size;
const walPath = `${dbPath}-wal`;
let walBytes = 0;
try {
  walBytes = statSync(walPath).size;
} catch {
  /* kein WAL vorhanden */
}
/**
 * Vor dem Messen aufräumen lassen.
 *
 * `heapUsed` ohne erzwungene Bereinigung misst überwiegend Müll, der noch
 * nicht abgeholt wurde — zwei Läufe desselben Codes unterschieden sich damit
 * um den Faktor zweieinhalb. Mit `--expose-gc` steht hier eine Zahl, die
 * wirklich etwas über den Bedarf aussagt; ohne das Flag wird sie als
 * unzuverlässig ausgewiesen, statt sie zu behaupten.
 */
const gc = (globalThis as { gc?: () => void }).gc;
if (gc) {
  gc();
  gc();
}
const mem = process.memoryUsage();

console.log(`Spielen:   ${elapsedMs.toFixed(0)} ms für ${syncs} Syncs`);
console.log('');
console.log('Durchsatz');
console.log(`  je Sync           ${((elapsedMs * 1000) / syncs).toFixed(0)} µs  (inkl. Speichern und Markt)`);
console.log(`  möglich           ~${Math.round(syncs / (elapsedMs / 1000)).toLocaleString('de-DE')} Syncs/s auf diesem Blech`);
console.log('');
console.log('Platte');
console.log(`  Datenbank         ${(dbBytes / 1024 / 1024).toFixed(1)} MB für ${FARMS} Höfe`);
console.log(`  WAL               ${(walBytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`  je Hof            ${(dbBytes / FARMS / 1024).toFixed(1)} kB`);
console.log(`  Schreibvorgänge   ${writes.toLocaleString('de-DE')} statt ${syncs.toLocaleString('de-DE')}`);
console.log('');
console.log(gc ? 'Speicher (nach Bereinigung)' : 'Speicher (OHNE --expose-gc: unzuverlässig)');
console.log(`  Heap benutzt      ${(mem.heapUsed / 1024 / 1024).toFixed(0)} MB`);
console.log(`  je geladenem Hof  ${(mem.heapUsed / FARMS / 1024).toFixed(0)} kB`);
console.log(`  hochgerechnet     ${((mem.heapUsed / FARMS) * 4000 / 1024 / 1024).toFixed(0)} MB bei 4000 gleichzeitig geladenen Höfen`);
console.log('');

accounts.close();
rmSync(dir, { recursive: true, force: true });
