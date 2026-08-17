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
import { CURRENT_RULESET_VERSION, getRuleset } from '../src/sim/rules.ts';
import { initialState, count } from '../src/sim/state.ts';
import { mulberry32 } from './helpers/session.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);
const WHEAT = 1;
const R_WHEAT = 0;

function setup() {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
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
  client.start(0, R_WHEAT);
  clock.now = T0 + 10_000;
  client.advanceClock(10);
  assert.equal((await engine.attempt(clock.now)).kind, 'synced');
  assert.equal(engine.view, 'live');
  assert.equal(client.queue.length, 0);

  // ── Tunnel ──
  state.online = false;

  client.start(1, R_WHEAT);
  client.advanceClock(7200);
  client.collect(0);
  client.collect(1);
  clock.now = T0 + 7300_000;

  const failed = await engine.attempt(clock.now);
  assert.equal(failed.kind, 'failed');
  assert.equal(engine.view, 'offline');

  // Entscheidend: Das Gameplay merkt davon nichts. Die Commands liegen sicher
  // in der Queue, und der Spieler kann einfach weitermachen.
  assert.equal(client.queue.length, 3);
  assert.equal(client.start(2, R_WHEAT).ok, true);
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
  assert.equal(count(server.snapshot.state, WHEAT), 20);
  assert.equal(server.snapshot.state.plots[2]!.recipe, R_WHEAT);
});

test('verlorene Antwort: Server hat den Batch, der Client weiß es nicht', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport, state } = makeTransport(server, clock);
  const engine = new SyncEngine(client, transport, { rnd: mulberry32(2) });

  client.start(0, R_WHEAT);
  client.advanceClock(7200);
  client.collect(0);
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
  assert.equal(client.start(1, R_WHEAT).ok, true);
  clock.now += 600_000;

  // Neuer Versuch: Der Client schickt ab seinem alten Stand — inklusive der
  // zwei Commands, die längst drin sind.
  state.dropResponses = false;
  clock.now += 120_000;
  const res = await engine.attempt(clock.now);

  assert.equal(res.kind, 'synced');
  // Nichts verloren …
  assert.equal(server.snapshot.seq, 3);
  assert.equal(server.snapshot.state.plots[1]!.recipe, R_WHEAT);
  // … und nichts doppelt: Feld 0 wurde genau einmal geerntet.
  assert.equal(count(server.snapshot.state, WHEAT), 10);
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

  client.start(0, R_WHEAT);
  clock.now = T0 + 2_000; // Server ist jetzt real 2 s weiter als Tick 0.

  state.dropResponses = true;
  await engine.attempt(clock.now);
  assert.equal(server.snapshot.seq, 1, 'Server hat den Batch angewandt');

  // Kein advanceClock: Der Spieler tippt einfach weiter, im selben Tick.
  assert.equal(client.start(1, R_WHEAT).ok, true);

  state.dropResponses = false;
  clock.now += 5_000;
  const res = await engine.attempt(clock.now);

  assert.equal(res.kind, 'synced');
  if (res.kind !== 'synced') return;
  assert.equal(res.result.ok, true, 'Wiederaufsetzen darf nicht abgelehnt werden');
  assert.equal(server.snapshot.seq, 2);
  assert.equal(server.snapshot.state.plots[1]!.recipe, R_WHEAT);
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
  client.start(0, R_WHEAT);

  // Sync erst deutlich später — 900 s liegen ungenutzt dazwischen.
  clock.now = T0 + 1000 * 1000;
  await engine.attempt(clock.now);

  assert.equal(server.snapshot.state.tick, 100);
  assert.equal(server.snapshot.serverTs, T0 + 100 * 1000, 'serverTs folgt dem Tick, nicht der Uhr');

  // Die ungenutzten 900 s stehen dem Spieler weiterhin zur Verfügung.
  client.advanceClock(900);
  assert.equal(client.start(1, R_WHEAT).ok, true);
  const res = await engine.attempt(clock.now);
  assert.equal(res.kind, 'synced');
  assert.equal(server.snapshot.state.tick, 1000);
});

test('verlorene Antwort ohne Weiterspielen bleibt ein sauberes No-op', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport, state } = makeTransport(server, clock);
  const engine = new SyncEngine(client, transport, { rnd: mulberry32(3) });

  client.start(0, R_WHEAT);
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
  assert.deepEqual(server.snapshot.state.plots, afterFirst.plots);
});

test('Fork wird auch über die Engine sauber aufgelöst — Server gewinnt', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport } = makeTransport(server, clock);

  // Zweites Gerät synct zuerst.
  const other = new Client(server.snapshot);
  other.start(2, R_WHEAT);
  other.advanceClock(50);
  server.sync(other.buildSyncRequest(), T0 + 50_000);

  const engine = new SyncEngine(client, transport, { rnd: mulberry32(4) });
  client.start(0, R_WHEAT);
  clock.now = T0 + 60_000;

  const res = await engine.attempt(clock.now);
  assert.equal(res.kind, 'synced');
  if (res.kind !== 'synced') return;
  assert.equal(res.result.ok, false);

  // Der Client steht danach sauber auf dem Server-Stand, nicht in einem
  // Zwischenzustand — und die Queue ist leer, nicht endlos wiederholend.
  assert.equal(client.queue.length, 0);
  assert.equal(client.state.plots[2]!.recipe, R_WHEAT);
  assert.equal(engine.view, 'live');
});

test('Präfix-Commit über die Engine: legale Arbeit bleibt, Rest wird gemeldet', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport } = makeTransport(server, clock);
  const engine = new SyncEngine(client, transport, { rnd: mulberry32(5) });

  // Ein manipulierter/kaputter Client, der die lokale Prüfung umgeht.
  client.start(0, R_WHEAT);
  client.advanceClock(100);
  client.queue.push({ seq: 2, tick: 100, type: 'START', plot: 0, recipe: R_WHEAT }); // belegt
  clock.now = T0 + 200_000;

  const res = await engine.attempt(clock.now);

  assert.equal(res.kind, 'dropped');
  if (res.kind !== 'dropped') return;
  assert.equal(res.rejectedFrom, 2);
  assert.equal(server.snapshot.seq, 1);
  assert.equal(client.state.plots[0]!.recipe, R_WHEAT);
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
    client.start(0, R_WHEAT);
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
  client.start(0, R_WHEAT);

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

test('eine ausdrückliche Handlung überspringt das Backoff', async () => {
  // Nach längerer Funkstille wächst der Abstand auf bis zu eine Minute. Tippt
  // der Spieler dann auf „jetzt syncen", darf ihn das Backoff nicht ignorieren:
  // Er weiß etwas, das der Timer nicht weiß — nämlich dass er wieder Netz hat.
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport, state } = makeTransport(server, clock);
  const engine = new SyncEngine(client, transport, { rnd: mulberry32(21) });

  state.online = false;
  client.start(0, R_WHEAT);
  for (let i = 0; i < 4; i++) {
    const res = await engine.attempt(clock.now);
    if (res.kind === 'failed') clock.now += 10; // absichtlich NICHT abwarten
  }
  assert.equal((await engine.attempt(clock.now)).kind, 'backing-off');

  state.online = true;
  const forced = await engine.attempt(clock.now, true);
  assert.equal(forced.kind, 'synced', 'erzwungener Versuch muss durchgehen');
  assert.equal(client.queue.length, 0);
});

/**
 * Schwaches Netz — der Fall, der schlimmer ist als gar keines.
 *
 * Kein Netz ist harmlos: Der Aufruf scheitert sofort, das Backoff greift, das
 * Spiel läuft weiter. Ein Balken mit einem halben Balken Empfang scheitert
 * aber nicht — er **hängt**. Ohne Frist bliebe `inFlight` für immer gesetzt,
 * jeder weitere Versuch prallte daran ab, und der Client synchronisierte nie
 * wieder, ohne dass irgendwo ein Fehler aufträte.
 *
 * Das ist die unangenehmste Sorte Fehler: Ein hängender Client sieht für den
 * Spieler genauso aus wie ein verbundener.
 */
test('eine hängende Leitung blockiert den Client nicht dauerhaft', async () => {
  const { server, client } = setup();

  let hangs = true;
  let aborted = false;
  const transport: Transport = (req, signal) =>
    new Promise((resolve, reject) => {
      if (!hangs) {
        resolve(server.sync(req, T0 + 60_000));
        return;
      }
      // Genau wie ein `fetch`, das auf Antwort wartet: Es passiert nichts —
      // weder Erfolg noch Fehler.
      signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    });

  const engine = new SyncEngine(client, transport, {
    baseDelayMs: 5,
    maxDelayMs: 10,
    timeoutMs: 40,
    rnd: () => 0.5,
  });

  client.start(0, R_WHEAT);
  const first = await engine.attempt(Date.now(), true);

  assert.equal(first.kind, 'failed');
  if (first.kind === 'failed') assert.equal(first.timedOut, true, 'nicht als Frist erkannt');
  assert.equal(aborted, true, 'die Anfrage läuft im Hintergrund weiter');
  assert.equal(engine.inFlight, false, 'der Client bleibt für immer „beschäftigt"');
  assert.equal(engine.timeouts, 1);

  // Die Arbeit ist unangetastet — nichts wurde verworfen, nur nicht gesendet.
  assert.equal(client.queue.length, 1);

  // Und sobald die Leitung wieder trägt, geht es ohne Zutun weiter.
  hangs = false;
  const second = await engine.attempt(Date.now(), true);
  assert.equal(second.kind, 'synced');
  assert.equal(client.queue.length, 0);
  assert.equal(server.snapshot.seq, 1);
});

/**
 * Und die Gegenprobe: Eine langsame, aber funktionierende Verbindung darf
 * nicht abgewürgt werden. Sonst hätte man aus schwachem Netz gar keines
 * gemacht — dieselbe Krankheit mit umgekehrtem Vorzeichen.
 */
test('langsam ist nicht kaputt — eine träge Antwort wird abgewartet', async () => {
  const { server, client } = setup();

  const transport: Transport = (req) =>
    new Promise((resolve) => setTimeout(() => resolve(server.sync(req, T0 + 60_000)), 30));

  const engine = new SyncEngine(client, transport, {
    baseDelayMs: 5,
    maxDelayMs: 10,
    timeoutMs: 400,
    rnd: () => 0.5,
  });

  client.start(0, R_WHEAT);
  const outcome = await engine.attempt(Date.now(), true);

  assert.equal(outcome.kind, 'synced');
  assert.equal(engine.timeouts, 0);
  assert.equal(server.snapshot.seq, 1);
});

/**
 * Ein abgebrochener Sync darf nichts doppelt anwenden.
 *
 * Der Server kann den Batch längst haben — die Frist lief ja auf dem Rückweg
 * ab. Genau dafür ist der Sync idempotent (§9): Beim nächsten Versuch erkennt
 * der Server das überlappende Präfix und wendet nur den Rest an.
 */
test('nach einer Frist ist der erneute Versuch sicher', async () => {
  const { server, client } = setup();

  let swallowResponse = true;
  const transport: Transport = (req, signal) =>
    new Promise((resolve, reject) => {
      // Der Server wendet an — die Antwort bleibt auf der Strecke.
      // Reichlich Zeitbudget: Der Server misst selbst (§4), und die Ernte
      // liegt zwei Minuten Spielzeit hinter dem Start.
      const result = server.sync(req, T0 + 600_000);
      if (!swallowResponse) {
        resolve(result);
        return;
      }

      signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });

  const engine = new SyncEngine(client, transport, {
    baseDelayMs: 5,
    maxDelayMs: 10,
    timeoutMs: 30,
    rnd: () => 0.5,
  });

  client.start(0, R_WHEAT);
  client.advanceClock(rules.recipes[R_WHEAT]!.durationTicks);
  client.collect(0);
  await engine.attempt(Date.now(), true);
  assert.equal(server.snapshot.seq, 2, 'der Server hat den Batch nicht angewandt');

  swallowResponse = false;
  const again = await engine.attempt(Date.now(), true);
  assert.equal(again.kind, 'synced');
  if (again.kind === 'synced') assert.equal(again.result.kind, 'duplicate');

  // Die Ernte gibt es genau einmal.
  assert.equal(count(server.snapshot.state, WHEAT), rules.recipes[R_WHEAT]!.output.amount);
  assert.equal(server.snapshot.seq, 2);
});
