import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset, levelRecipes, recipeUnlocked, PRODUCTION_VERSIONS } from '../src/sim/rules.ts';
import { count, initialState, type State } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';

const rules = getRuleset(50);
const alt = getRuleset(49);
const idx = (id: string) => rules.items.findIndex((i) => i.id === id);
const plotIdx = (id: string) => rules.plots.findIndex((p) => p.id === id);
const rezept = (id: string) => rules.recipes.findIndex((r) => r.id === id);
const CARROT = idx('carrot');
const CANE = idx('sugar-cane');
const SUGAR = idx('sugar');
const APPLE = idx('apple');
const MEHL = idx('flour');
const EGGS = idx('eggs');
const FELD = plotIdx('field-1');
const MILL = plotIdx('mill');
const OVEN = plotIdx('oven');
const PRESSE = plotIdx('saftpresse');

function setzeIrgendwo(s: State, plot: number, seq: number): State {
  if (!rules.grid || s.plots[plot]!.gx >= 0) return s;
  for (let gy = 0; gy < rules.grid.h; gy++) {
    for (let gx = 0; gx < rules.grid.w; gx++) {
      try {
        return simulate(s, { seq, tick: s.tick, type: 'PLACE', plot, gx, gy }, rules);
      } catch {
        // weiter
      }
    }
  }
  throw new Error('nirgends Platz');
}

function reicherHof(vorrat: Record<number, number>): State {
  let s = initialState(rules);
  return { ...s, xp: 100_000, items: s.items.map((n, i) => (i === rules.currency ? 100_000 : vorrat[i] ?? n)) };
}

test('alles Neue haengt hinten an', () => {
  assert.equal(rules.items.length, alt.items.length + 7);
  assert.equal(rules.recipes.length, alt.recipes.length + 7);
  assert.equal(rules.plots.length, alt.plots.length + 1);
  alt.items.forEach((it, i) => assert.equal(rules.items[i]!.id, it.id));
  alt.recipes.forEach((r, i) => assert.equal(rules.recipes[i]!.id, r.id));
  alt.plots.forEach((p, i) => assert.equal(rules.plots[i]!.id, p.id));
});

test('jedes Feld kennt Moehren ab Stufe 6 und Zuckerrohr ab Stufe 9 — die Saat kauft man nach', () => {
  const felder = rules.plots.map((p, i) => i).filter((i) => rules.plots[i]!.id.indexOf('field') === 0);
  assert.ok(felder.length >= 6);
  for (const f of felder) {
    const r = levelRecipes(rules, f, 1);
    assert.ok(r.includes(rezept('carrot')) && r.includes(rezept('sugar-cane')), rules.plots[f]!.id);
  }
  assert.equal(recipeUnlocked(rules, rezept('carrot'), 5), false);
  assert.equal(recipeUnlocked(rules, rezept('carrot'), 6), true);
  assert.equal(recipeUnlocked(rules, rezept('sugar-cane'), 9), true);
  assert.ok(rules.items[CARROT]!.npcBuyPrice > 0 && rules.items[CANE]!.npcBuyPrice > 0, 'Saat nachkaufbar wie Mais');
});

test('aus einer Moehre werden zwei, aus einem Zuckerrohr zwei', () => {
  let s = reicherHof({ [CARROT]: 1, [CANE]: 1 });
  s = simulate(s, { seq: 1, tick: 0, type: 'START', plot: FELD, recipe: rezept('carrot') }, rules);
  assert.equal(count(s, CARROT), 0);
  s = simulate(s, { seq: 2, tick: rules.recipes[rezept('carrot')]!.durationTicks, type: 'COLLECT', plot: FELD }, rules);
  assert.equal(count(s, CARROT), 2);
  s = simulate(s, { seq: 3, tick: s.tick, type: 'START', plot: FELD, recipe: rezept('sugar-cane') }, rules);
  s = simulate(s, { seq: 4, tick: s.tick + rules.recipes[rezept('sugar-cane')]!.durationTicks, type: 'COLLECT', plot: FELD }, rules);
  assert.equal(count(s, CANE), 2);
});

test('die Ketten: Muehle mahlt Zucker, die Saftpresse presst, der Ofen backt Moehrenkuchen', () => {
  let s = reicherHof({ [CANE]: 10, [CARROT]: 10, [APPLE]: 6, [MEHL]: 2, [EGGS]: 2, [idx('plank')]: 40, [idx('nail')]: 20 });
  let seq = 1;
  for (const plot of [MILL, OVEN, PRESSE]) {
    if (s.plots[plot]!.level <= 0) s = simulate(s, { seq: seq++, tick: s.tick, type: 'BUY', plot }, rules);
    s = setzeIrgendwo(s, plot, seq++);
  }
  const lauf = (plot: number, id: string) => {
    s = simulate(s, { seq: seq++, tick: s.tick, type: 'START', plot, recipe: rezept(id) }, rules);
    s = simulate(s, { seq: seq++, tick: s.tick + rules.recipes[rezept(id)]!.durationTicks, type: 'COLLECT', plot }, rules);
  };
  lauf(MILL, 'sugar');
  assert.equal(count(s, SUGAR), 1);
  lauf(PRESSE, 'apple-juice');
  assert.equal(count(s, idx('apple-juice')), 1);
  lauf(PRESSE, 'carrot-juice');
  assert.equal(count(s, idx('carrot-juice')), 1);
  lauf(PRESSE, 'syrup');
  assert.equal(count(s, idx('syrup')), 1);
  lauf(OVEN, 'carrot-cake');
  assert.equal(count(s, idx('carrot-cake')), 1);
  assert.equal(count(s, SUGAR), 0, 'der Zucker steckt im Kuchen');
});

test('Preise steigen entlang jeder Kette', () => {
  const preis = (id: string) => rules.items[idx(id)]!.npcPrice;
  assert.ok(preis('sugar') > 2 * preis('sugar-cane'));
  assert.ok(preis('apple-juice') > 3 * preis('apple'));
  assert.ok(preis('carrot-juice') > 4 * preis('carrot'));
  assert.ok(preis('syrup') > 3 * preis('sugar-cane'));
  assert.ok(preis('carrot-cake') > 3 * preis('carrot') + preis('flour') + preis('eggs') + preis('sugar'));
});

test('Zettel, Erfolge und Funde kennen die neuen Waren; alle Fassungen bleiben stimmig', () => {
  const wanted = new Set(rules.requestTemplates.flatMap((t) => t.wants.map((w) => w.item)));
  for (const id of ['carrot', 'sugar', 'apple-juice', 'carrot-juice', 'syrup', 'carrot-cake']) assert.ok(wanted.has(idx(id)), id);
  const ids = new Set((rules.achievements ?? []).map((a) => a.id));
  assert.ok(ids.has('saftpresse') && ids.has('juice10') && ids.has('cake5'));
  assert.ok(rules.fundstuecke!.tabelle.some((f) => f.item === CARROT));
  for (const v of PRODUCTION_VERSIONS) {
    const r = getRuleset(v);
    for (const t of r.requestTemplates) for (const w of t.wants) assert.ok(r.items[w.item], `${v}: ${t.id}`);
  }
});
