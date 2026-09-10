import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { SyncEngine } from '../src/client/sync-engine.ts';
import { CURRENT_RULESET_VERSION, getRuleset } from '../src/sim/rules.ts';
import { EMPTY_PLOT, count, initialState } from '../src/sim/state.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);
const WHEAT = 1;
const R_WHEAT = 0;
const REIFE = rules.recipes[R_WHEAT]!.durationTicks;

// Die Zeitfensterprüfung des Servers ist der Schutz gegen vorgestellte Uhren.
// Sie darf aber niemanden bestrafen, dessen Uhr bloß driftet — und die driftet,
// weil der Abgleich nur bei jedem Sync passiert. Diese Datei nagelt beide
// Seiten fest: Der Ehrliche verliert nichts, der Schummler nichts Reifes.

function baue(uhrVorsprungS: number) {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot, 'handy');
  // Der Server ist echte `echtVergangenS` Sekunden weiter; der Client glaubt,
  // es seien `echtVergangenS + uhrVorsprungS`.
  const engine = (echtVergangenS: number) =>
    new SyncEngine(client, async (req) => server.sync(req, T0 + echtVergangenS * 1000), {
      baseDelayMs: 1,
      maxDelayMs: 2,
    });
  return { server, client, engine, uhrVorsprungS };
}

test('vorgehende Uhr bei ehrlicher Arbeit: nichts geht verloren', async () => {
  const { server, client, engine } = baue(0);

  client.start(0, R_WHEAT);
  // Das Korn ist wirklich reif — der Client ist nur 45 s zu früh dran.
  const echtVergangen = REIFE;
  client.advanceClock(REIFE + 45);
  assert.equal(client.collect(0).ok, true);

  const e = engine(echtVergangen);
  const erste = await e.attempt(Date.now(), true);
  assert.equal(erste.kind, 'synced');
  if (erste.kind !== 'synced') return;
  assert.equal(erste.result.ok, false, 'der Server weist die vorgestellte Uhr ab');
  if (erste.result.ok) return;
  assert.equal(erste.result.reason, 'CLOCK_AHEAD_OF_SERVER');

  assert.equal(e.umdatiert, 1, 'die Sendung wurde umdatiert, nicht verworfen');
  assert.equal(client.queue.length, 2, 'beide Befehle sind noch da');
  assert.ok(
    client.queue.every((c) => c.tick <= echtVergangen),
    'die Ticks liegen jetzt in der Serverzeit',
  );

  // Zweiter Anlauf mit denselben Befehlen, jetzt in ehrlicher Zeit.
  const zweite = await e.attempt(Date.now(), true);
  assert.equal(zweite.kind, 'synced');
  if (zweite.kind !== 'synced') return;
  assert.equal(zweite.result.ok, true, 'jetzt nimmt der Server die Arbeit an');

  assert.ok(
    count(server.snapshot.state, WHEAT) > count(initialState(rules), WHEAT),
    'die Ernte des ehrlichen Spielers ist angekommen',
  );
  assert.equal(client.queue.length, 0, 'nichts blieb liegen');
});

test('vorgestellte Uhr bei unreifer Ernte: das Korn bleibt weg', async () => {
  const { server, client, engine } = baue(0);

  client.start(0, R_WHEAT);
  // Zwei Stunden vorgestellt, obwohl erst zehn Sekunden vergangen sind.
  client.advanceClock(REIFE);
  assert.equal(client.collect(0).ok, true, 'lokal sieht es für den Schummler gut aus');

  const e = engine(10);
  const erste = await e.attempt(Date.now(), true);
  assert.equal(erste.kind, 'synced');
  if (erste.kind !== 'synced') return;
  assert.equal(erste.result.ok, false);
  if (erste.result.ok) return;
  assert.equal(erste.result.reason, 'CLOCK_AHEAD_OF_SERVER');

  // Das Säen trägt auch in echter Zeit — die Ernte nicht.
  assert.equal(client.queue.length, 1, 'nur das Säen überlebt das Umdatieren');
  assert.equal(client.queue[0]!.type, 'START');

  const zweite = await e.attempt(Date.now(), true);
  assert.equal(zweite.kind, 'synced');
  if (zweite.kind !== 'synced') return;
  assert.equal(zweite.result.ok, true);

  assert.equal(
    count(server.snapshot.state, WHEAT),
    count(initialState(rules), WHEAT) - rules.recipes[R_WHEAT]!.inputs[0]!.amount,
    'geerntet wurde nichts — nur die Saat ist weg',
  );
  assert.notEqual(
    server.snapshot.state.plots[0]!.slots[0]!.recipe,
    EMPTY_PLOT,
    'das Feld wächst weiter, statt abgeerntet zu sein',
  );
});

test('umdatierte Ticks laufen nie rückwärts', async () => {
  const { client, engine } = baue(0);

  client.start(0, R_WHEAT);
  client.advanceClock(30);
  client.start(1, R_WHEAT);
  client.advanceClock(30);
  client.start(2, R_WHEAT);

  const e = engine(5);
  await e.attempt(Date.now(), true);

  assert.equal(e.umdatiert, 1);
  const ticks = client.queue.map((c) => c.tick);
  assert.deepEqual(
    ticks,
    [...ticks].sort((a, b) => a - b),
    `Ticks müssen monoton bleiben, waren: ${ticks.join(', ')}`,
  );
  assert.ok(
    ticks.every((t) => t <= 5),
    'kein Tick liegt über der Serverzeit',
  );
});

test('andere Ablehnungen werden weiterhin verworfen, nicht umdatiert', async () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot, 'handy');

  client.start(0, R_WHEAT);

  const e = new SyncEngine(
    client,
    async () => ({
      ok: false as const,
      kind: 'rejected' as const,
      reason: 'FORK_DETECTED',
      snapshot: server.snapshot,
      serverTime: T0,
    }),
    { baseDelayMs: 1, maxDelayMs: 2 },
  );

  await e.attempt(Date.now(), true);
  assert.equal(e.umdatiert, 0, 'nur die Uhrendrift wird umdatiert');
  assert.equal(client.queue.length, 0, 'alles andere fliegt wie bisher raus');
});
