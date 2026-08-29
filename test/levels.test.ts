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
  validateRuleset,
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

  // keine harte Höchststufe mehr — es geht über die Schwellen hinaus weiter
  const anZahl = rules.levelThresholds.length + 1;
  assert.ok(levelOf(rules, 10_000_000) > anZahl, 'jenseits der Schwellen steigt die Stufe weiter');
  assert.notEqual(nextLevelAt(rules, 10_000_000), null, 'es gibt immer ein Danach');
});

test('der Fortschrittsbalken hat immer einen Anfang und ein Ende', () => {
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

  assert.deepEqual(
    client.queue.map((c) => c.type),
    ['START', 'COLLECT'],
  );
});

test('Liefern ist die Hauptquelle — deutlich mehr als Ernten', () => {
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
  const rnd = mulberry32(9);
  const start = fuzzStart(rules, 5000, mulberry32(9));
  const saat = start.items.slice();
  saat[WHEAT] = 40;
  const server = new Server({ ...start, items: saat }, T0, CURRENT_RULESET_VERSION);
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
  const max = rules.levelThresholds.length + 1;
  for (const plot of rules.plots) {
    for (const level of plot.levels) {
      assert.ok((level.minPlayerLevel ?? 1) <= max, `${plot.id}: Sperre über dem Maximum`);
    }
  }

  const mill = rules.plots[MILL]!.levels[0]!.minPlayerLevel ?? 1;
  const coop = rules.plots[COOP]!.levels[0]!.minPlayerLevel ?? 1;
  assert.ok(mill <= coop, 'das Gehege öffnet vor der Mühle — Hühner ohne Futter');
});

test('sich hochspielen funktioniert wirklich — und in erträglicher Zeit', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  server.rollRequest = mulberry32(4);
  server.stockRequests();
  const client = new Client(server.snapshot);

  const gate = rules.plots[MILL]!.levels[0]!.minPlayerLevel!;
  const cost = rules.plots[MILL]!.levels[0]!.cost[0]!.amount;
  let cycles = 0;

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

    const sellable = count(client.state, WHEAT) - perRound;
    if (sellable > 0) client.sellNpc(WHEAT, sellable);
    cycles++;
  }

  assert.ok(cycles < 200, 'die Mühle ist unerreichbar');
  assert.equal(client.buy(MILL).ok, true);

  const minutes = Math.round((cycles * GROW) / 60);
  assert.ok(minutes <= 60, `bis zur Mühle vergehen ${minutes} Minuten — zu zäh für den Einstieg`);

  const res = server.sync(client.buildSyncRequest(), T0 + client.localTick * 1000);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.divergence, false);
  assert.equal(res.snapshot.state.xp, client.state.xp);
  assertInvariants(res.snapshot.state, rules);
});

const V4 = getRuleset(4);
const DAIRY = V4.plots.findIndex((p) => p.id === 'dairy');
const PASTURE = V4.plots.findIndex((p) => p.id === 'pasture-1');
const MILK_ITEM = V4.items.findIndex((i) => i.id === 'milk');

function withDairy(xp: number) {
  const base = initialState(V4);
  const items = base.items.slice();
  items[V4.currency] = 100_000;
  items[MILK_ITEM] = 20;
  const plots = base.plots.slice();
  plots[DAIRY] = { level: 1, slots: [{ recipe: -1, startedAt: 0 }] };
  return { ...base, xp, items, plots };
}

const recipeIndex = (id: string) => V4.recipes.findIndex((r) => r.id === id);
const levelFor = (xp: number) => levelOf(V4, xp);

test('eine Kette schaltet auf EINER Stufe frei — Tiefe steckt in den Rezepten', () => {
  const pasture = V4.plots[PASTURE]!.levels[0]!.minPlayerLevel;
  const dairy = V4.plots[DAIRY]!.levels[0]!.minPlayerLevel;
  assert.equal(pasture, dairy, 'Kuhgehege und Molkerei öffnen nicht zusammen');

  const stufen = V4.plots[DAIRY]!.levels[0]!.recipes.map((r) => V4.recipes[r]!.minPlayerLevel ?? 1);
  assert.deepEqual(
    [...stufen].sort((a, b) => a - b),
    stufen,
    'die Rezepte der Molkerei sind nicht aufsteigend gestaffelt',
  );
  assert.ok(stufen[stufen.length - 1]! > stufen[0]!, 'alle Rezepte auf derselben Stufe');
});

test('ein gestaffeltes Rezept ist vor seiner Stufe gesperrt und danach erlaubt', () => {
  const butter = recipeIndex('butter');
  const need = V4.recipes[butter]!.minPlayerLevel!;
  const thresholds = V4.levelThresholds;

  const zuFrueh = new Client({
    state: withDairy(thresholds[need - 3]!),
    seq: 0,
    serverTs: T0,
    rulesetVersion: 4,
  });
  assert.ok(levelFor(zuFrueh.state.xp) < need);
  const res = zuFrueh.start(DAIRY, butter);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'PLAYER_LEVEL_TOO_LOW');

  const reif = new Client({
    state: withDairy(thresholds[need - 2]!),
    seq: 0,
    serverTs: T0,
    rulesetVersion: 4,
  });
  assert.equal(levelFor(reif.state.xp), need);
  assert.equal(reif.start(DAIRY, butter).ok, true);
});

test('DER PUNKT: Geld kauft kein Rezept frei', () => {
  // Der Fall, für den das Stufentor überhaupt existiert — reich, aber neu.
  const reich = new Client({
    state: withDairy(0),
    seq: 0,
    serverTs: T0,
    rulesetVersion: 4,
  });
  for (const id of ['cream', 'butter', 'cheese']) {
    const r = reich.start(DAIRY, recipeIndex(id));
    assert.equal(r.ok, false, `${id} ließ sich mit Gold erkaufen`);
    if (!r.ok) assert.equal(r.code, 'PLAYER_LEVEL_TOO_LOW');
  }
});

test('was später kommt, zahlt besser — sonst wäre Warten sinnlos', () => {
  const proMinute = (id: string) => {
    const r = V4.recipes[recipeIndex(id)]!;
    const ein = r.inputs.reduce((s, i) => s + i.amount * V4.items[i.item]!.npcPrice, 0);
    const aus = r.output.amount * V4.items[r.output.item]!.npcPrice;
    return (aus - ein) / (r.durationTicks / 60);
  };
  const kette = ['cream', 'butter', 'cheese'];
  for (let i = 1; i < kette.length; i++) {
    assert.ok(
      proMinute(kette[i]!) > proMinute(kette[i - 1]!),
      `${kette[i]} zahlt nicht besser als ${kette[i - 1]}`,
    );
  }
});

test('kein Gebäude, das man kaufen kann und nicht benutzen darf', () => {
  // Die Regel steht in `validateRuleset`; hier die Gegenprobe, dass sie beißt.
  const kaputt = {
    ...V4,
    plots: V4.plots.map((p) =>
      p.id === 'dairy'
        ? { ...p, levels: [{ ...p.levels[0]!, recipes: [recipeIndex('cheese')] }] }
        : p,
    ),
  };
  const problems = validateRuleset(kaputt);
  assert.ok(
    problems.some((m) => m.includes('dairy')),
    `der Wächter schweigt: ${problems.join(' | ')}`,
  );
  assert.deepEqual(validateRuleset(V4), [], 'v4 selbst ist nicht sauber');
});
