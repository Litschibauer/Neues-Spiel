/**
 * Der Tunnel-Test (Architektur §10).
 *
 * Szenario: Zug fährt in den Tunnel, Verbindung ist tot, der Spieler spielt
 * weiter. Danach wieder Empfang. Nichts darf verloren gehen, nichts doppelt
 * angewandt werden, und es darf keinen sichtbaren Moduswechsel geben.
 *
 * Der fieseste Fall ist NICHT „keine Verbindung" — das ist einfach. Es ist die
 * verlorene ANTWORT: Der Server hat den Batch bereits angewandt, der Client
 * hat es nie erfahren und spielt weiter. Dann behauptet der Client beim
 * nächsten Versuch, an einer Stelle zu stehen, die der Server längst hinter
 * sich hat.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { SyncEngine } from '../src/client/sync-engine.ts';
import type { Transport } from '../src/client/sync-engine.ts';
import { Server } from '../src/server/server.ts';
import { CURRENT_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { mulberry32 } from './helpers/session.ts';

const T0 = 1_700_000_000_000;

function setup() {
  const server = new Server(initialState(6), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);
  return { server, client };
}

/** Transport mit Schalter — „im Tunnel" heißt: wirft. */
function makeTransport(server: Server, clock: { now: number }) {
  const state = { online: true, dropResponses: false, calls: 0 };
  const transport: Transport = async (req) => {
    state.calls++;
    if (!state.online) throw new Error('ENETUNREACH');
    const res = server.sync(req, clock.now);
    if (state.dropResponses) throw new Error('ETIMEDOUT'); // Server hat's, Client nicht
    return res;
  };
  return { transport, state };
}

test('Tunnel: Spielen läuft weiter, nichts geht verloren, kein Moduswechsel', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport, state } = makeTransport(server, clock);
  const engine = new SyncEngine(client, transport, { rnd: mulberry32(1) });

  // Vor dem Tunnel: normaler Sync.
  client.plant(0);
  clock.now = T0 + 10_000;
  client.advanceClock(10);
  assert.equal((await engine.attempt(clock.now)).kind, 'synced');
  assert.equal(engine.view, 'live');
  assert.equal(client.queue.length, 0);

  // ── Tunnel ──
  state.online = false;

  client.plant(1);
  client.advanceClock(7200);
  client.harvest(0);
  client.harvest(1);
  clock.now = T0 + 7300_000;

  const failed = await engine.attempt(clock.now);
  assert.equal(failed.kind, 'failed');
  assert.equal(engine.view, 'offline');

  // Entscheidend: Das Gameplay merkt davon nichts. Die Commands liegen sicher
  // in der Queue, und der Spieler kann einfach weitermachen.
  assert.equal(client.queue.length, 3);
  assert.equal(client.plant(2).ok, true);
  assert.equal(client.queue.length, 4);

  // Backoff greift — es wird nicht in einer Schleife gehämmert.
  const backing = await engine.attempt(clock.now);
  assert.equal(backing.kind, 'backing-off');

  // ── Raus aus dem Tunnel ──
  state.online = true;
  clock.now += 120_000;

  const synced = await engine.attempt(clock.now);
  assert.equal(synced.kind, 'synced');
  assert.equal(engine.view, 'live');
  assert.equal(client.queue.length, 0);

  // Alle vier Offline-Commands sind angekommen.
  assert.equal(server.snapshot.seq, 5);
  assert.equal(server.snapshot.state.wheat, 20);
  assert.equal(server.snapshot.state.fields[2]!.crop, 'wheat');
});

test('verlorene Antwort: Server hat den Batch, der Client weiß es nicht', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport, state } = makeTransport(server, clock);
  const engine = new SyncEngine(client, transport, { rnd: mulberry32(2) });

  client.plant(0);
  client.advanceClock(7200);
  client.harvest(0);
  clock.now = T0 + 7200_000;

  // Der Request kommt an und wird angewandt — nur die Antwort geht verloren.
  state.dropResponses = true;
  const lost = await engine.attempt(clock.now);
  assert.equal(lost.kind, 'failed');

  // Server ist weiter, Client denkt, nichts sei passiert.
  assert.equal(server.snapshot.seq, 2);
  assert.equal(client.queue.length, 2);

  // Der Spieler spielt ahnungslos weiter.
  client.advanceClock(600);
  assert.equal(client.plant(1).ok, true);
  clock.now += 600_000;

  // Neuer Versuch: Der Client schickt ab seinem alten Stand — inklusive der
  // zwei Commands, die längst drin sind.
  state.dropResponses = false;
  clock.now += 120_000;
  const res = await engine.attempt(clock.now);

  assert.equal(res.kind, 'synced');
  // Nichts verloren …
  assert.equal(server.snapshot.seq, 3);
  assert.equal(server.snapshot.state.fields[1]!.crop, 'wheat');
  // … und nichts doppelt: Feld 0 wurde genau einmal geerntet.
  assert.equal(server.snapshot.state.wheat, 10);
  assert.equal(client.queue.length, 0);
});

test('Regression: Wiederaufsetzen ohne Zeitsprung dazwischen', async () => {
  // Der Bug, den erst ein echter Lauf über HTTP zeigte: Der Server schrieb
  // seinen Zustand beim Sync bis „jetzt" fort und war damit der Zeitachse des
  // Clients voraus. Nach einer verlorenen Antwort datierte der ahnungslose
  // Client seine nächsten Commands auf Ticks, die der Server längst hinter
  // sich hatte — und lehnte sie als TIME_WENT_BACKWARDS ab.
  //
  // Die alten Tests trafen das nicht, weil sie zwischen den Aktionen großzügig
  // die Uhr vorstellten. Hier passiert bewusst fast nichts dazwischen.
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport, state } = makeTransport(server, clock);
  const engine = new SyncEngine(client, transport, { rnd: mulberry32(11) });

  client.plant(0);
  clock.now = T0 + 2_000; // Server ist jetzt real 2 s weiter als Tick 0.

  state.dropResponses = true;
  await engine.attempt(clock.now);
  assert.equal(server.snapshot.seq, 1, 'Server hat den Batch angewandt');

  // Kein advanceClock: Der Spieler tippt einfach weiter, im selben Tick.
  assert.equal(client.plant(1).ok, true);

  state.dropResponses = false;
  clock.now += 5_000;
  const res = await engine.attempt(clock.now);

  assert.equal(res.kind, 'synced');
  if (res.kind !== 'synced') return;
  assert.equal(res.result.ok, true, 'Wiederaufsetzen darf nicht abgelehnt werden');
  assert.equal(server.snapshot.seq, 2);
  assert.equal(server.snapshot.state.fields[1]!.crop, 'wheat');
  assert.equal(client.queue.length, 0);
});

test('Snapshot-Zeit bleibt an den verbrauchten Ticks ausgerichtet', async () => {
  // Der Server darf `serverTs` nicht auf die Wanduhr setzen, sondern nur um die
  // tatsächlich verbrauchten Ticks weiterstellen. Sonst verfiele dem Spieler
  // die Zeit zwischen seinem letzten Command und dem Sync.
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport } = makeTransport(server, clock);
  const engine = new SyncEngine(client, transport, { rnd: mulberry32(12) });

  client.advanceClock(100);
  client.plant(0);

  // Sync erst deutlich später — 900 s liegen ungenutzt dazwischen.
  clock.now = T0 + 1000 * 1000;
  await engine.attempt(clock.now);

  assert.equal(server.snapshot.state.tick, 100);
  assert.equal(server.snapshot.serverTs, T0 + 100 * 1000, 'serverTs folgt dem Tick, nicht der Uhr');

  // Die ungenutzten 900 s stehen dem Spieler weiterhin zur Verfügung.
  client.advanceClock(900);
  assert.equal(client.plant(1).ok, true);
  const res = await engine.attempt(clock.now);
  assert.equal(res.kind, 'synced');
  assert.equal(server.snapshot.state.tick, 1000);
});

test('verlorene Antwort ohne Weiterspielen bleibt ein sauberes No-op', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport, state } = makeTransport(server, clock);
  const engine = new SyncEngine(client, transport, { rnd: mulberry32(3) });

  client.plant(0);
  clock.now = T0 + 5_000;

  state.dropResponses = true;
  await engine.attempt(clock.now);
  const afterFirst = structuredClone(server.snapshot.state);

  state.dropResponses = false;
  clock.now += 60_000;
  const res = await engine.attempt(clock.now);

  assert.equal(res.kind, 'synced');
  if (res.kind !== 'synced') return;
  assert.equal(res.result.ok && res.result.kind, 'duplicate');
  assert.equal(engine.resumes, 1);
  assert.deepEqual(server.snapshot.state.fields, afterFirst.fields);
});

test('Fork wird auch über die Engine sauber aufgelöst — Server gewinnt', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport } = makeTransport(server, clock);

  // Zweites Gerät synct zuerst.
  const other = new Client(server.snapshot);
  other.plant(3);
  other.advanceClock(50);
  server.sync(other.buildSyncRequest(), T0 + 50_000);

  const engine = new SyncEngine(client, transport, { rnd: mulberry32(4) });
  client.plant(0);
  clock.now = T0 + 60_000;

  const res = await engine.attempt(clock.now);
  assert.equal(res.kind, 'synced');
  if (res.kind !== 'synced') return;
  assert.equal(res.result.ok, false);

  // Der Client steht danach sauber auf dem Server-Stand, nicht in einem
  // Zwischenzustand — und die Queue ist leer, nicht endlos wiederholend.
  assert.equal(client.queue.length, 0);
  assert.equal(client.state.fields[3]!.crop, 'wheat');
  assert.equal(engine.view, 'live');
});

test('Präfix-Commit über die Engine: legale Arbeit bleibt, Rest wird gemeldet', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport } = makeTransport(server, clock);
  const engine = new SyncEngine(client, transport, { rnd: mulberry32(5) });

  // Ein manipulierter/kaputter Client, der die lokale Prüfung umgeht.
  client.plant(0);
  client.advanceClock(100);
  client.queue.push({ seq: 2, tick: 100, type: 'PLANT', field: 0 }); // belegt
  clock.now = T0 + 200_000;

  const res = await engine.attempt(clock.now);

  assert.equal(res.kind, 'dropped');
  if (res.kind !== 'dropped') return;
  assert.equal(res.rejectedFrom, 2);
  assert.equal(server.snapshot.seq, 1);
  assert.equal(client.state.fields[0]!.crop, 'wheat');
  assert.equal(client.queue.length, 0);
});

test('Thundering Herd: 500 Clients verlassen gleichzeitig den Tunnel', async () => {
  // Ohne Jitter würden alle im selben Moment erneut anklopfen und sich ihre
  // eigene Lastspitze bauen — genau dann, wenn der Zug den Tunnel verlässt.
  const attempts: number[] = [];

  for (let i = 0; i < 500; i++) {
    const { server, client } = setup();
    const clock = { now: T0 };
    const { transport, state } = makeTransport(server, clock);
    state.online = false;

    const engine = new SyncEngine(client, transport, { rnd: mulberry32(i + 1) });
    client.plant(0);
    await engine.attempt(clock.now);
    attempts.push(engine.nextAttemptAt - clock.now);
  }

  const min = Math.min(...attempts);
  const max = Math.max(...attempts);

  // Alle liegen im erwarteten Fenster (baseDelay 2s, halbiert plus Jitter).
  assert.ok(min >= 1000 && max <= 2000, `Backoff außerhalb der Erwartung: ${min}–${max}ms`);

  // Der eigentliche Test ist die VERTEILUNG, nicht die Anzahl verschiedener
  // Werte: Bei ~1000 möglichen Millisekunden und 500 Ziehungen sind Kollisionen
  // statistisch normal. Entscheidend ist, dass die Last das ganze Fenster füllt
  // und sich nicht in einer Ecke sammelt.
  const buckets = new Array(10).fill(0);
  for (const a of attempts) {
    const idx = Math.min(9, Math.floor(((a - 1000) / 1000) * 10));
    buckets[idx]++;
  }

  assert.ok(
    buckets.every((n) => n > 0),
    `Lücken in der Streuung: ${buckets.join(', ')}`,
  );
  // Kein Zehntel des Fensters trägt mehr als das Dreifache des Durchschnitts.
  assert.ok(
    Math.max(...buckets) < (attempts.length / 10) * 3,
    `Ballung in einem Fenster: ${buckets.join(', ')}`,
  );
});

test('wiederholtes Scheitern verlängert den Abstand, statt zu hämmern', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport, state } = makeTransport(server, clock);
  state.online = false;

  const engine = new SyncEngine(client, transport, { rnd: mulberry32(9) });
  client.plant(0);

  const delays: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await engine.attempt(clock.now);
    assert.equal(res.kind, 'failed');
    if (res.kind !== 'failed') return;
    delays.push(res.retryInMs);
    clock.now += res.retryInMs;
  }

  assert.ok(delays[5]! > delays[0]! * 4, `kein spürbares Backoff: ${delays.join(', ')}`);
  assert.ok(Math.max(...delays) <= 60_000, 'Backoff übersteigt das Maximum');
  // Und die Commands liegen die ganze Zeit unversehrt in der Queue.
  assert.equal(client.queue.length, 1);
});
