import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { getRuleset, isTradable } from '../src/sim/rules.ts';
import { EMPTY_PLOT, count, initialState } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { migrateState } from '../src/sim/migrate.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(43);
const ohne = getRuleset(42);
const R_WHEAT = 0;
const REIFE = rules.recipes[R_WHEAT]!.durationTicks;
const XP_WEIZEN = rules.recipes[R_WHEAT]!.xp;
const b = rules.booster!;

function mit(item: number, anzahl = 1) {
  const s = initialState(rules);
  return { ...s, items: s.items.map((n, i) => (i === item ? anzahl : n)) };
}

test('Booster sind Waren, aber weder kaufbar noch handelbar', () => {
  assert.equal(rules.items[b.xpItem]!.id, 'booster-xp');
  assert.equal(rules.items[b.wuchsItem]!.id, 'booster-wuchs');
  assert.equal(isTradable(rules, b.xpItem), false);
  assert.equal(isTradable(rules, b.wuchsItem), false);
  assert.equal(rules.items[b.xpItem]!.storable, false, 'sie belegen keinen Lagerplatz');
});

test('ohne Booster im Lager laesst sich keiner einsetzen', () => {
  assert.throws(
    () => simulate(initialState(rules), { seq: 1, tick: 0, type: 'USE_BOOSTER', item: b.xpItem }, rules),
    /NOT_ENOUGH_ITEMS/,
  );
  assert.throws(
    () => simulate(mit(1, 5), { seq: 1, tick: 0, type: 'USE_BOOSTER', item: 1 }, rules),
    /NOT_A_BOOSTER/,
    'Weizen ist kein Booster',
  );
});

test('der XP-Verdoppler verdoppelt, was ein Befehl bringt — und nur solange er laeuft', () => {
  let s = mit(b.xpItem);
  s = simulate(s, { seq: 1, tick: 0, type: 'USE_BOOSTER', item: b.xpItem }, rules);
  assert.equal(count(s, b.xpItem), 0, 'ein Stueck ist verbraucht');
  assert.equal(s.xpDoppeltBis, b.xpTicks);

  const xpVor = s.xp;
  s = simulate(s, { seq: 2, tick: 1, type: 'START', plot: 0, recipe: R_WHEAT }, rules);
  s = simulate(s, { seq: 3, tick: 1 + REIFE, type: 'COLLECT', plot: 0 }, rules);
  assert.ok(1 + REIFE < b.xpTicks, 'für den Test muss die Ernte in die Laufzeit fallen');
  assert.equal(s.xp - xpVor, 2 * XP_WEIZEN, 'die Ernte zählt doppelt');

  // Nach Ablauf: einfach.
  const xpDanach = s.xp;
  s = simulate(s, { seq: 4, tick: b.xpTicks + 10, type: 'START', plot: 1, recipe: R_WHEAT }, rules);
  s = simulate(s, { seq: 5, tick: b.xpTicks + 10 + REIFE, type: 'COLLECT', plot: 1 }, rules);
  assert.equal(s.xp - xpDanach, XP_WEIZEN, 'nach der halben Stunde zählt es wieder einfach');
});

test('ein zweiter Verdoppler haengt hinten dran statt zu verfallen', () => {
  let s = mit(b.xpItem, 2);
  s = simulate(s, { seq: 1, tick: 0, type: 'USE_BOOSTER', item: b.xpItem }, rules);
  s = simulate(s, { seq: 2, tick: 100, type: 'USE_BOOSTER', item: b.xpItem }, rules);
  assert.equal(s.xpDoppeltBis, 2 * b.xpTicks, 'die Laufzeiten addieren sich');
});

test('der Schnellwuchs rueckt alles Laufende um die Haelfte der Restzeit vor', () => {
  let s = mit(b.wuchsItem);
  s = simulate(s, { seq: 1, tick: 0, type: 'START', plot: 0, recipe: R_WHEAT }, rules);
  s = simulate(s, { seq: 2, tick: 10, type: 'USE_BOOSTER', item: b.wuchsItem }, rules);
  assert.equal(count(s, b.wuchsItem), 0);
  const rest = REIFE - 10;
  const schub = Math.floor((rest * b.wuchsProzent) / 100);
  assert.equal(s.plots[0]!.slots[0]!.startedAt, 0 - schub, 'der Start ist um den Schub nach hinten gerueckt');
  // Und jetzt ist die Ernte entsprechend frueher moeglich.
  assert.throws(() => simulate(s, { seq: 3, tick: 10 + rest - schub - 1, type: 'COLLECT', plot: 0 }, rules), /NOT_DONE/);
  const geerntet = simulate(s, { seq: 3, tick: 10 + rest - schub, type: 'COLLECT', plot: 0 }, rules);
  assert.equal(geerntet.plots[0]!.slots[0]!.recipe, EMPTY_PLOT);
});

test('laeuft nichts, bleibt der Schnellwuchs in der Hand', () => {
  const s = mit(b.wuchsItem);
  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'USE_BOOSTER', item: b.wuchsItem }, rules),
    /NOTHING_GROWING/,
  );
  assert.equal(count(s, b.wuchsItem), 1, 'nichts verbraucht');
});

test('ein Regelwerk ohne Booster kennt den Befehl nicht', () => {
  const s = { ...initialState(ohne), items: initialState(ohne).items.slice() };
  assert.throws(() => simulate(s, { seq: 1, tick: 0, type: 'USE_BOOSTER', item: 1 }, ohne), /NO_BOOSTER/);
});

test('Booster kommen aus Funden und aus jeder Kiste — selten', () => {
  const funde = rules.fundstuecke!.tabelle;
  assert.ok(funde.some((t) => t.item === b.xpItem) && funde.some((t) => t.item === b.wuchsItem));
  const gesamt = funde.reduce((n, t) => n + t.weight, 0);
  const boosterGewicht = funde.filter((t) => t.item === b.xpItem || t.item === b.wuchsItem).reduce((n, t) => n + t.weight, 0);
  assert.ok(boosterGewicht * 10 < gesamt, `Booster dürfen höchstens ein Zehntel der Funde sein (${boosterGewicht}/${gesamt})`);
  for (const k of rules.chestKinds!) {
    assert.ok(k.drops.some((d) => d.item === b.xpItem), `${k.id} kennt den Verdoppler nicht`);
    assert.ok(k.drops.some((d) => d.item === b.wuchsItem), `${k.id} kennt den Schnellwuchs nicht`);
  }
});

test('Server und Geraet kommen mit laufendem Verdoppler auf dieselben XP', () => {
  const server = new Server(mit(b.xpItem) as never, T0, 43);
  const client = new Client(server.snapshot, 'handy');
  assert.equal(client.useBooster(b.xpItem).ok, true);
  client.start(0, R_WHEAT);
  client.advanceClock(REIFE);
  assert.equal(client.collect(0).ok, true);
  const res = server.sync(client.buildSyncRequest(), T0 + REIFE * 1000);
  assert.equal(res.ok, true, 'keine Divergenz durch den Verdoppler');
  assert.equal(server.snapshot.state.xp, client.preview().xp);
});

test('ein Hof aus v42 hat keinen laufenden Verdoppler', () => {
  const roh = { ...initialState(ohne) } as Record<string, unknown>;
  delete roh.xpDoppeltBis;
  const neu = migrateState(roh as never, 42, 43);
  assert.equal(neu.xpDoppeltBis, 0);
  assert.equal(neu.items.length, rules.items.length, 'die beiden neuen Waren sind da');
});
