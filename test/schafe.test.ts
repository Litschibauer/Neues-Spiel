import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { PRODUCTION_VERSIONS, getRuleset, itemUnlockLevel, recipeUnlocked } from '../src/sim/rules.ts';
import { count, initialState } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(46);
const alt = getRuleset(44);
const idx = (id: string) => rules.items.findIndex((i) => i.id === id);
const plotIdx = (id: string) => rules.plots.findIndex((p) => p.id === id);
const rezept = (id: string) => rules.recipes.findIndex((r) => r.id === id);
const WOOL = idx('wool');
const YARN = idx('yarn');
const SWEATER = idx('sweater');
const CORN = idx('corn');
const WHEAT = idx('wheat');
const SHEEP_FEED = idx('sheep-feed');
const MILL = plotIdx('mill');
const SCHAF = plotIdx('sheep-1');
const WEBEREI = plotIdx('weberei');
const R_WOOL = rezept('wool');
const R_YARN = rezept('yarn');
const R_SWEATER = rezept('sweater');
const R_SHEEP_FEED = rezept('sheep-feed');

// Irgendwo hinstellen, wo Platz ist: Zellen durchprobieren, bis die Sim ja sagt.
function setzeIrgendwo(s: ReturnType<typeof initialState>, plot: number, seq: number) {
  if (!rules.grid || s.plots[plot]!.gx >= 0) return s;
  for (let gy = 0; gy < rules.grid.h; gy++) {
    for (let gx = 0; gx < rules.grid.w; gx++) {
      try {
        return simulate(s, { seq, tick: 0, type: 'PLACE', plot, gx, gy }, rules);
      } catch {
        // belegt oder gesperrt — weiter
      }
    }
  }
  throw new Error('nirgends Platz');
}

// Ein Hof mit viel Gold und Stufe, Schafweide gebaut und aufs Raster gesetzt.
function hofMitWeide() {
  let s = initialState(rules);
  s = { ...s, xp: 100_000, items: s.items.map((n, i) => (i === rules.currency ? 100_000 : i === SHEEP_FEED ? 50 : n)) };
  s = simulate(s, { seq: 1, tick: 0, type: 'BUY', plot: SCHAF }, rules);
  return setzeIrgendwo(s, SCHAF, 2);
}

test('alles Neue haengt hinten an — kein alter Index hat sich bewegt', () => {
  assert.equal(rules.items.length, alt.items.length + 4);
  assert.equal(rules.recipes.length, alt.recipes.length + 4);
  assert.equal(rules.plots.length, alt.plots.length + 2);
  alt.items.forEach((it, i) => assert.equal(rules.items[i]!.id, it.id));
  alt.recipes.forEach((r, i) => assert.equal(rules.recipes[i]!.id, r.id));
  alt.plots.forEach((p, i) => assert.equal(rules.plots[i]!.id, p.id));
});

test('die Schafweide ist ein Tierplatz, den man mit Lämmern besetzt', () => {
  const def = rules.plots[SCHAF]!;
  assert.ok(def.animal, 'Schafe muss man kaufen wie Hühner und Kühe');
  assert.equal(def.levels[0]!.minPlayerLevel, 9);
  let s = hofMitWeide();
  assert.equal(s.plots[SCHAF]!.level, 1);
  s = simulate(s, { seq: 3, tick: 0, type: 'BUY_ANIMAL', plot: SCHAF }, rules);
  assert.equal(s.plots[SCHAF]!.tiere.length, 1);
  // Ein Lamm gibt noch keine Wolle.
  assert.throws(
    () => simulate(s, { seq: 4, tick: 1, type: 'START', plot: SCHAF, recipe: R_WOOL, slot: 0 }, rules),
    /ANIMAL_TOO_YOUNG/,
  );
});

test('Schaffutter rein, Wolle raus — nach der Wachszeit', () => {
  let s = hofMitWeide();
  s = simulate(s, { seq: 3, tick: 0, type: 'BUY_ANIMAL', plot: SCHAF }, rules);
  const reif = rules.plots[SCHAF]!.animal!.growTicks;
  const futterVor = count(s, SHEEP_FEED);
  s = simulate(s, { seq: 4, tick: reif, type: 'START', plot: SCHAF, recipe: R_WOOL, slot: 0 }, rules);
  assert.equal(count(s, SHEEP_FEED), futterVor - 1, 'ein Sack Schaffutter gefüttert');
  const dauer = rules.recipes[R_WOOL]!.durationTicks;
  s = simulate(s, { seq: 5, tick: reif + dauer, type: 'COLLECT', plot: SCHAF, slot: 0 }, rules);
  assert.equal(count(s, WOOL), 2, 'zwei Wolle geschoren');
});

test('die Weberei spinnt Garn und strickt Pullover', () => {
  let s = initialState(rules);
  s = { ...s, xp: 100_000, items: s.items.map((n, i) => (i === rules.currency ? 100_000 : i === WOOL ? 20 : i === idx('plank') ? 30 : i === idx('nail') ? 20 : n)) };
  s = simulate(s, { seq: 1, tick: 0, type: 'BUY', plot: WEBEREI }, rules);
  s = setzeIrgendwo(s, WEBEREI, 2);
  let seq = 3, t = 0;
  for (let i = 0; i < 3; i++) {
    s = simulate(s, { seq: seq++, tick: t, type: 'START', plot: WEBEREI, recipe: R_YARN }, rules);
    t += rules.recipes[R_YARN]!.durationTicks;
    s = simulate(s, { seq: seq++, tick: t, type: 'COLLECT', plot: WEBEREI }, rules);
  }
  assert.equal(count(s, YARN), 3);
  assert.equal(count(s, WOOL), 20 - 6);
  s = simulate(s, { seq: seq++, tick: t, type: 'START', plot: WEBEREI, recipe: R_SWEATER }, rules);
  t += rules.recipes[R_SWEATER]!.durationTicks;
  s = simulate(s, { seq: seq++, tick: t, type: 'COLLECT', plot: WEBEREI }, rules);
  assert.equal(count(s, SWEATER), 1, 'ein Pullover aus drei Garn und einer Wolle');
  assert.equal(count(s, YARN), 0);
});

test('Garn und Pullover kommen erst mit der Stufe — Wolle mit der Weide', () => {
  assert.equal(recipeUnlocked(rules, R_YARN, 10), false);
  assert.equal(recipeUnlocked(rules, R_YARN, 11), true);
  assert.equal(recipeUnlocked(rules, R_SWEATER, 12), true);
  assert.ok(itemUnlockLevel(rules, SWEATER) >= 12);
});

test('Preise steigen entlang der Kette', () => {
  const preis = (i: number) => rules.items[i]!.npcPrice;
  assert.ok(preis(WOOL) < preis(YARN) && preis(YARN) < preis(SWEATER));
  // Ein Pullover ist mehr wert als seine Zutaten — sonst lohnt das Stricken nicht.
  assert.ok(preis(SWEATER) > 3 * preis(YARN) + preis(WOOL));
});

test('Zettel und Erfolge kennen die neuen Waren', () => {
  const wanted = new Set(rules.requestTemplates.flatMap((t) => t.wants.map((w) => w.item)));
  assert.ok(wanted.has(WOOL) && wanted.has(YARN) && wanted.has(SWEATER));
  const ids = new Set((rules.achievements ?? []).map((a) => a.id));
  assert.ok(ids.has('sheep') && ids.has('weberei') && ids.has('sweater5'));
});

test('Server und Geraet scheren dasselbe', () => {
  const start = hofMitWeide();
  const server = new Server(start as never, T0, 46);
  const client = new Client(server.snapshot, 'handy');
  assert.equal(client.buyAnimal(SCHAF).ok, true);
  const reif = rules.plots[SCHAF]!.animal!.growTicks;
  client.advanceClock(reif);
  assert.equal(client.start(SCHAF, R_WOOL, 0).ok, true);
  client.advanceClock(rules.recipes[R_WOOL]!.durationTicks);
  assert.equal(client.collect(SCHAF, 0).ok, true);
  const res = server.sync(client.buildSyncRequest(), T0 + (reif + rules.recipes[R_WOOL]!.durationTicks) * 1000);
  assert.equal(res.ok, true);
  assert.equal(count(server.snapshot.state, WOOL), 2);
});

test('Schafe fressen Futter aus der Mühle, kein rohes Korn — wie Hühner und Kühe', () => {
  const wolle = rules.recipes[R_WOOL]!;
  assert.deepEqual(wolle.inputs.map((w) => w.item), [SHEEP_FEED]);
  assert.ok(!wolle.inputs.some((w) => w.item === CORN || w.item === WHEAT));
  const muehle = rules.plots[MILL]!;
  assert.ok(muehle.levels.every((l) => l.recipes.includes(R_SHEEP_FEED)), 'die Mühle macht Schaffutter');
  assert.equal(recipeUnlocked(rules, R_SHEEP_FEED, 8), false);
  assert.equal(recipeUnlocked(rules, R_SHEEP_FEED, 9), true, 'ab Stufe 9, mit der Weide');
  // Kein Sack ohne Weizen und Mais.
  const futter = rules.recipes[R_SHEEP_FEED]!;
  assert.deepEqual(new Set(futter.inputs.map((w) => w.item)), new Set([WHEAT, CORN]));
});

test('Weizen und Mais werden in der Mühle zu Schaffutter', () => {
  let s = initialState(rules);
  s = { ...s, xp: 100_000, items: s.items.map((n, i) => (i === rules.currency ? 100_000 : i === WHEAT || i === CORN ? 10 : n)) };
  if (s.plots[MILL]!.level <= 0) s = simulate(s, { seq: 1, tick: 0, type: 'BUY', plot: MILL }, rules);
  s = setzeIrgendwo(s, MILL, 2);
  s = simulate(s, { seq: 3, tick: 0, type: 'START', plot: MILL, recipe: R_SHEEP_FEED }, rules);
  assert.equal(count(s, WHEAT), 8);
  assert.equal(count(s, CORN), 8);
  s = simulate(s, { seq: 4, tick: rules.recipes[R_SHEEP_FEED]!.durationTicks, type: 'COLLECT', plot: MILL }, rules);
  assert.equal(count(s, SHEEP_FEED), 2);
});

test('alte Fassung 45 bleibt, wie sie war — dort fraßen Schafe noch Mais', () => {
  const v45 = getRuleset(45);
  assert.deepEqual(v45.recipes[R_WOOL]!.inputs.map((w) => w.item), [CORN]);
  assert.equal(v45.items.length, rules.items.length - 1);
});

test('alle Produktionsfassungen bleiben in sich stimmig', () => {
  for (const v of PRODUCTION_VERSIONS) {
    const r = getRuleset(v);
    for (const t of r.requestTemplates) for (const w of t.wants) assert.ok(r.items[w.item], `${v}: ${t.id} will eine Ware, die es nicht gibt`);
  }
});
