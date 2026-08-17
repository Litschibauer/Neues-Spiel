/**
 * Erfahrung und Level (M8).
 *
 * Die kleinste Mechanik im ganzen Projekt — und die einzige, die **kein
 * Command** braucht. Erfahrung fällt beim Abholen und Liefern nebenbei an,
 * das Level wird daraus abgeleitet, und seine ganze Wirkung ist eine Zahl
 * neben dem Preis eines Platzes.
 *
 * Zwei Eigenschaften sind hier wichtiger als die Regel selbst:
 *
 *  1. **Das Level steht nicht im Zustand.** Es wird aus der Erfahrung
 *     berechnet. Zwei Zahlen für dieselbe Sache laufen sonst auseinander.
 *  2. **Niemand wird zurückgestuft.** Eine Levelkurve, die in einem Patch
 *     steigt, würde genau das tun — deshalb dürfen Schwellen nur sinken.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import {
  CURRENT_RULESET_VERSION,
  PRODUCTION_VERSIONS,
  RULESETS,
  getRuleset,
  levelOf,
  levelStartedAt,
  nextLevelAt,
} from '../src/sim/rules.ts';
import { initialState, count } from '../src/sim/state.ts';
import { assertInvariants } from '../src/sim/migrate.ts';
import { fuzzStart, mulberry32 } from './helpers/session.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);

const WHEAT = 1;
const R_WHEAT = 0;
const MILL = 6;
const COOP = 7;
const GROW = rules.recipes[R_WHEAT]!.durationTicks;

test('das Level ergibt sich aus der Erfahrung, nicht aus einem zweiten Feld', () => {
  assert.equal(levelOf(rules, 0), 1);
  assert.equal(levelOf(rules, rules.levelThresholds[0]! - 1), 1);
  assert.equal(levelOf(rules, rules.levelThresholds[0]!), 2);
  assert.equal(levelOf(rules, rules.levelThresholds[1]!), 3);

  // Über der letzten Schwelle ist Schluss — kein Level aus dem Nichts.
  const max = rules.levelThresholds.length + 1;
  assert.equal(levelOf(rules, 10_000_000), max);
  assert.equal(nextLevelAt(rules, 10_000_000), null, 'Maximum hat kein Danach');
});

test('der Fortschrittsbalken hat immer einen Anfang und ein Ende', () => {
  // Ohne beides ließe sich kein Balken zeichnen, und genau dafür sind die
  // beiden Abfragen da.
  for (const xp of [0, 5, 39, 40, 41, 119, 500, 4400, 99_999]) {
    const start = levelStartedAt(rules, xp);
    const next = nextLevelAt(rules, xp);
    assert.ok(start <= xp, `Anfang ${start} liegt hinter dem Stand ${xp}`);
    if (next !== null) {
      assert.ok(next > xp, `nächste Schwelle ${next} liegt nicht vor uns`);
      assert.ok(next > start, 'leerer Levelabschnitt');
    }
  }
});

test('Erfahrung fällt beim Abholen an — ohne eigenes Command', () => {
  const client = new Client({
    state: initialState(rules),
    seq: 0,
    serverTs: T0,
    rulesetVersion: 1,
  });

  assert.equal(client.state.xp, 0);
  assert.equal(client.start(0, R_WHEAT).ok, true);
  assert.equal(client.state.xp, 0, 'Starten allein gibt noch nichts');

  client.advanceClock(GROW);
  assert.equal(client.collect(0).ok, true);
  assert.equal(client.state.xp, rules.recipes[R_WHEAT]!.xp);

  // Und das Log enthält nur die zwei Aktionen — kein XP-Command.
  assert.deepEqual(
    client.queue.map((c) => c.type),
    ['START', 'COLLECT'],
  );
});

test('Liefern ist die Hauptquelle — deutlich mehr als Ernten', () => {
  // Sonst wäre der schnellste Weg nach oben, Aufträge zu ignorieren.
  const perHarvest = rules.recipes[R_WHEAT]!.xp;
  for (const template of rules.requestTemplates) {
    assert.ok(
      template.xp > perHarvest,
      `${template.id}: ${template.xp} XP nicht mehr als eine Ernte (${perHarvest})`,
    );
  }
});

test('ein Platz hinter einer Schwelle bleibt zu, egal wie reich man ist', () => {
  const rich = new Client({
    state: fuzzStart(rules, 1_000_000),
    seq: 0,
    serverTs: T0,
    rulesetVersion: 1,
  });

  const res = rich.buy(MILL);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'PLAYER_LEVEL_TOO_LOW');
  assert.equal(rich.queue.length, 0, 'abgelehnter Kauf landet im Log');
});

test('genau an der Schwelle geht es auf — keinen Punkt früher', () => {
  const gate = rules.plots[MILL]!.levels[0]!.minPlayerLevel!;
  const needed = rules.levelThresholds[gate - 2]!;
  const cost = rules.plots[MILL]!.levels[0]!.cost[0]!.amount;

  const justBelow = new Client({
    state: { ...fuzzStart(rules, cost), xp: needed - 1 },
    seq: 0,
    serverTs: T0,
    rulesetVersion: 1,
  });
  const tooEarly = justBelow.buy(MILL);
  assert.equal(tooEarly.ok, false);
  if (!tooEarly.ok) assert.equal(tooEarly.code, 'PLAYER_LEVEL_TOO_LOW');

  const exactly = new Client({
    state: { ...fuzzStart(rules, cost), xp: needed },
    seq: 0,
    serverTs: T0,
    rulesetVersion: 1,
  });
  assert.equal(exactly.buy(MILL).ok, true);
});

test('Erfahrung geht nie zurück', () => {
  // Keine Aktion darf Erfahrung kosten — sonst könnte ein Spieler ein Level
  // verlieren, und ein Platz, den er gekauft hat, wäre plötzlich gesperrt.
  const rnd = mulberry32(9);
  const server = new Server(fuzzStart(rules, 5000, mulberry32(9)), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  let highest = client.state.xp;
  for (let step = 0; step < 400; step++) {
    const before = client.state.xp;
    switch (Math.floor(rnd() * 5)) {
      case 0:
        client.start(Math.floor(rnd() * 9), R_WHEAT);
        break;
      case 1:
        client.collect(Math.floor(rnd() * 9));
        break;
      case 2:
        client.advanceClock(1 + Math.floor(rnd() * GROW * 2));
        break;
      case 3:
        client.sellNpc(WHEAT, 1 + Math.floor(rnd() * 20));
        break;
      default: {
        const r = client.state.requests[Math.floor(rnd() * rules.requestSlots)];
        if (r) client.fillRequest(r.id);
        break;
      }
    }
    assert.ok(client.state.xp >= before, 'Erfahrung ist gesunken');
    highest = Math.max(highest, client.state.xp);
  }
  assert.ok(highest > 0, 'in 400 Schritten keine Erfahrung gesammelt');
});

test('Levelschwellen dürfen über Versionen nur sinken', () => {
  // Ein Patch, der die Kurve anhebt, würde Spieler zurückstufen — und ihnen
  // damit Plätze wieder zusperren, die sie längst gekauft haben. Das Level
  // wird ja abgeleitet, es kann sich also rückwärts bewegen.
  for (let i = 1; i < PRODUCTION_VERSIONS.length; i++) {
    const from = getRuleset(PRODUCTION_VERSIONS[i - 1]!);
    const to = getRuleset(PRODUCTION_VERSIONS[i]!);
    const label = `v${from.version} → v${to.version}`;

    assert.ok(
      to.levelThresholds.length >= from.levelThresholds.length,
      `${label}: Levelstufen verschwunden`,
    );
    from.levelThresholds.forEach((threshold, index) => {
      assert.ok(
        to.levelThresholds[index]! <= threshold,
        `${label}: Schwelle für Stufe ${index + 2} gestiegen — das stuft Spieler zurück`,
      );
    });
  }
});

test('die Levelsperren sind erreichbar und in sinnvoller Reihenfolge', () => {
  // Eine Sperre über dem Maximum wäre ein Platz, den es nie gibt.
  const max = rules.levelThresholds.length + 1;
  for (const plot of rules.plots) {
    for (const level of plot.levels) {
      assert.ok((level.minPlayerLevel ?? 1) <= max, `${plot.id}: Sperre über dem Maximum`);
    }
  }

  // Und die Kette muss in der Reihenfolge aufgehen, in der man sie spielt:
  // Mühle vor Gehege, sonst hat man Hühner ohne Futter.
  const mill = rules.plots[MILL]!.levels[0]!.minPlayerLevel ?? 1;
  const coop = rules.plots[COOP]!.levels[0]!.minPlayerLevel ?? 1;
  assert.ok(mill <= coop, 'das Gehege öffnet vor der Mühle — Hühner ohne Futter');
});

test('sich hochspielen funktioniert wirklich — und in erträglicher Zeit', () => {
  // Der Praxistest: ein frischer Hof, nur die drei Startfelder, keine
  // Geschenke. Wie lange bis zur Mühle?
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  server.rollRequest = mulberry32(4);
  server.stockRequests();
  const client = new Client(server.snapshot);

  const gate = rules.plots[MILL]!.levels[0]!.minPlayerLevel!;
  const cost = rules.plots[MILL]!.levels[0]!.cost[0]!.amount;
  let cycles = 0;

  // Saatgut ist endlich: Drei Felder kosten drei Körner pro Runde. Wer die
  // Aufträge beliefert hat, muss beim Händler nachkaufen — genau der Weg, den
  // ein Spieler ohne Weizen im Lager gehen muss.
  const seed = rules.recipes[R_WHEAT]!.inputs.find((i) => i.item === WHEAT)?.amount ?? 0;
  const perRound = 3 * seed;

  while (cycles < 200) {
    if (levelOf(rules, client.state.xp) >= gate && count(client.state, 0) >= cost) break;

    const missing = perRound - count(client.state, WHEAT);
    if (missing > 0) client.buyNpc(WHEAT, missing);
    for (let plot = 0; plot < 3; plot++) client.start(plot, R_WHEAT);
    client.advanceClock(GROW);
    for (let plot = 0; plot < 3; plot++) client.collect(plot);

    for (;;) {
      const fillable = client.state.requests
        .slice(0, rules.requestSlots)
        .find((r) => r.wants.every((w) => count(client.state, w.item) >= w.amount));
      if (!fillable) break;
      client.fillRequest(fillable.id);
    }
    // Die Aussaat der nächsten Runde bleibt liegen — zurückkaufen wäre teurer.
    const sellable = count(client.state, WHEAT) - perRound;
    if (sellable > 0) client.sellNpc(WHEAT, sellable);
    cycles++;
  }

  assert.ok(cycles < 200, 'die Mühle ist unerreichbar');
  assert.equal(client.buy(MILL).ok, true);

  // In Spielzeit: Wie lange dauert das? Ein Zyklus ist eine Wachstumsdauer.
  const minutes = Math.round((cycles * GROW) / 60);
  assert.ok(minutes <= 60, `bis zur Mühle vergehen ${minutes} Minuten — zu zäh für den Einstieg`);

  // Und der Server nimmt die ganze Aufstiegs-Sitzung ohne Divergenz ab.
  const res = server.sync(client.buildSyncRequest(), T0 + client.localTick * 1000);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.divergence, false);
  assert.equal(res.snapshot.state.xp, client.state.xp);
  assertInvariants(res.snapshot.state, rules);
});
