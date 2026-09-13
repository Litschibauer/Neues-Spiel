import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset, saisonBei, saisonWechselInWochen, LATEST_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState, count } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { farmView } from '../src/client/view.ts';

const rules = getRuleset(52);
const ohne = getRuleset(51);
const j = rules.jahreszeiten!;
const R_WHEAT = 0;
const WHEAT = rules.recipes[R_WHEAT]!.output.item;
const REIFE = rules.recipes[R_WHEAT]!.durationTicks;
const feld = rules.plots.findIndex((p) => p.id === 'field-1');

function wocheMit(item: number): number {
  for (let w = 1; w < 20; w++) if (saisonBei(rules, w)?.bonusItem === item) return w;
  throw new Error('keine Woche mit dieser Saisonware');
}

test('vier Jahreszeiten, reihum je Serverwoche, keine vor dem ersten Kontakt', () => {
  assert.equal(LATEST_RULESET_VERSION, 52);
  assert.equal(j.saisons.length, 4);
  assert.equal(saisonBei(rules, 0), null, 'Woche 0: noch kein Serverkontakt');
  const namen = [1, 2, 3, 4, 5].map((w) => saisonBei(rules, w)!.name);
  assert.deepEqual(namen.slice(0, 4).sort(), ['Frühling', 'Herbst', 'Sommer', 'Winter'].sort());
  assert.equal(namen[4], namen[0], 'nach vier Wochen fängt das Jahr von vorn an');
  assert.equal(saisonWechselInWochen(rules, 3), 1, 'jede Woche eine neue');
  assert.equal(saisonBei(ohne, 5), null, 'V51 kennt keine Jahreszeiten');
});

test('in Saison bringt jede Abholung ein Stück mehr — sonst nicht', () => {
  const inSaison = wocheMit(WHEAT);
  let s = { ...initialState(rules), wochenNummer: inSaison };
  s = simulate(s, { seq: 1, tick: 100, type: 'START', plot: feld, recipe: R_WHEAT }, rules);
  const vor = count(s, WHEAT);
  s = simulate(s, { seq: 2, tick: 100 + REIFE, type: 'COLLECT', plot: feld }, rules);
  assert.equal(count(s, WHEAT) - vor, rules.recipes[R_WHEAT]!.output.amount + 1, 'ein Stück mehr');

  // Andere Jahreszeit: nichts extra.
  const andere = [1, 2, 3, 4].find((w) => saisonBei(rules, w)!.bonusItem !== WHEAT)!;
  let t = { ...initialState(rules), wochenNummer: andere };
  t = simulate(t, { seq: 1, tick: 100, type: 'START', plot: feld, recipe: R_WHEAT }, rules);
  const vor2 = count(t, WHEAT);
  t = simulate(t, { seq: 2, tick: 100 + REIFE, type: 'COLLECT', plot: feld }, rules);
  assert.equal(count(t, WHEAT) - vor2, rules.recipes[R_WHEAT]!.output.amount);

  // V51: dieselbe Woche, kein Extra — alte Stände rechnen wie immer.
  let u = { ...initialState(ohne), wochenNummer: inSaison };
  u = simulate(u, { seq: 1, tick: 100, type: 'START', plot: feld, recipe: R_WHEAT }, ohne);
  const vor3 = count(u, WHEAT);
  u = simulate(u, { seq: 2, tick: 100 + REIFE, type: 'COLLECT', plot: feld }, ohne);
  assert.equal(count(u, WHEAT) - vor3, ohne.recipes[R_WHEAT]!.output.amount);
});

test('das Extrastück verfällt, wenn das Lager voll ist, und blockiert nichts', () => {
  const inSaison = wocheMit(WHEAT);
  let s = { ...initialState(rules), wochenNummer: inSaison };
  s = simulate(s, { seq: 1, tick: 100, type: 'START', plot: feld, recipe: R_WHEAT }, rules);
  // Lager bis auf genau den Ertrag auffüllen.
  const kapazitaet = rules.siloLevels![s.siloLevel ?? 0]!.capacity;
  const ertrag = rules.recipes[R_WHEAT]!.output.amount;
  const belegt = s.items.reduce((n, x, i) => n + (rules.items[i]!.storable ? x : 0), 0);
  const voll = { ...s, items: s.items.map((x, i) => (i === WHEAT ? x + (kapazitaet - belegt - ertrag) : x)) };
  const vor = count(voll, WHEAT);
  const danach = simulate(voll, { seq: 2, tick: 100 + REIFE, type: 'COLLECT', plot: feld }, rules);
  assert.equal(count(danach, WHEAT) - vor, ertrag, 'Ertrag ja, Extra nein');
});

test('die Sicht nennt die Jahreszeit, die Saisonware und wie lange sie noch hat', () => {
  const s = { ...initialState(rules), wochenNummer: wocheMit(WHEAT) };
  const v = farmView(s, rules, true);
  assert.ok(v.saison, 'Jahreszeit da');
  assert.equal(v.saison!.bonusItem, WHEAT);
  assert.equal(v.saison!.name, 'Sommer');
  assert.equal(v.saison!.nochWochen, 1);
  assert.equal(farmView(initialState(rules), rules, true).saison, null, 'ohne Woche keine Jahreszeit');
  assert.equal(farmView({ ...initialState(ohne), wochenNummer: 3 }, ohne, true).saison, null);
});
