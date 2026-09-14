import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset, saisonBei, saisonVon, saisonWechselInWochen, LATEST_RULESET_VERSION } from '../src/sim/rules.ts';
import { HOFZEIT_EPOCHE, HOFJAHRESZEIT_S, hofzeit } from '../src/sim/zeit.ts';
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
  assert.ok(LATEST_RULESET_VERSION >= 52);
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

// Ab V53 kommt die Jahreszeit aus der Hofzeit: drei Hofmonate je Jahreszeit,
// aus dem Tick — die Serverwoche spielt keine Rolle mehr.
const r53 = getRuleset(53);

test('V53: die Jahreszeit folgt dem Kalender, nicht der Woche — und braucht den Versatz', () => {
  assert.equal(r53.jahreszeiten!.quelle, 'hofzeit');
  const fruehling = HOFZEIT_EPOCHE + 100;
  assert.equal(saisonVon(r53, fruehling, 0)!.name, 'Frühling', 'Woche 0 ist egal');
  assert.equal(saisonVon(r53, fruehling + HOFJAHRESZEIT_S, 7)!.name, 'Sommer');
  assert.equal(saisonVon(r53, fruehling + 2 * HOFJAHRESZEIT_S, 7)!.name, 'Herbst');
  assert.equal(saisonVon(r53, fruehling + 3 * HOFJAHRESZEIT_S, 7)!.name, 'Winter');
  assert.equal(saisonVon(r53, fruehling + 4 * HOFJAHRESZEIT_S, 7)!.name, 'Frühling');
  assert.equal(saisonVon(r53, null, 7), null, 'ohne gestempelten Versatz keine Jahreszeit');
  assert.equal(saisonVon(rules, fruehling, 3)!.name, saisonBei(rules, 3)!.name, 'V52 bleibt bei der Woche');
  assert.equal(hofzeit(fruehling).jahreszeit, 0);
});

// Der Tick zählt je Hof ab null; der Server stempelt den Versatz zur echten
// Uhr. Ein Stand mit Tick 100 und Versatz V liegt bei Unix-Sekunde 100 + V.
function standBei(unix: number, rulesX = r53) {
  return { ...initialState(rulesX), tick: 100, zeitVersatz: unix - 100 };
}

test('V53: in Saison bringt die Ernte ein Stück mehr — nach dem Kalender', () => {
  const sommer = HOFZEIT_EPOCHE + HOFJAHRESZEIT_S + 50;
  const feld53 = r53.plots.findIndex((p) => p.id === 'field-1');
  let s = standBei(sommer);
  s = simulate(s, { seq: 1, tick: 100, type: 'START', plot: feld53, recipe: R_WHEAT }, r53);
  const vor = count(s, WHEAT);
  s = simulate(s, { seq: 2, tick: 100 + REIFE, type: 'COLLECT', plot: feld53 }, r53);
  assert.equal(count(s, WHEAT) - vor, r53.recipes[R_WHEAT]!.output.amount + 1, 'Sommer: Weizen bringt eine mehr');
  const winter = HOFZEIT_EPOCHE + 3 * HOFJAHRESZEIT_S + 50;
  let w = standBei(winter);
  w = simulate(w, { seq: 1, tick: 100, type: 'START', plot: feld53, recipe: R_WHEAT }, r53);
  const vor2 = count(w, WHEAT);
  w = simulate(w, { seq: 2, tick: 100 + REIFE, type: 'COLLECT', plot: feld53 }, r53);
  assert.equal(count(w, WHEAT) - vor2, r53.recipes[R_WHEAT]!.output.amount, 'Winter: nichts extra für Weizen');
  // Ohne Versatz (noch kein Serverkontakt): keine Jahreszeit, kein Extra.
  let o = { ...initialState(r53), tick: 100 };
  o = simulate(o, { seq: 1, tick: 100, type: 'START', plot: feld53, recipe: R_WHEAT }, r53);
  const vor3 = count(o, WHEAT);
  o = simulate(o, { seq: 2, tick: 100 + REIFE, type: 'COLLECT', plot: feld53 }, r53);
  assert.equal(count(o, WHEAT) - vor3, r53.recipes[R_WHEAT]!.output.amount);
});

test('V53: die Sicht nennt Kalender und Tageszeit', () => {
  const t = HOFZEIT_EPOCHE + 5 * 31 * 3600 + 12 * 150; // Spätsommer, Tag 1, 12 Uhr
  const v = farmView(standBei(t), r53, true);
  assert.ok(v.hofzeit, 'Hofzeit da');
  assert.equal(v.hofzeit!.monatName, 'Spätsommer');
  assert.equal(v.hofzeit!.tag, 1);
  assert.equal(v.hofzeit!.stunde, 12);
  assert.equal(v.hofzeit!.tagesphase, 'tag');
  assert.equal(v.saison!.name, 'Sommer');
  assert.ok(v.saison!.wechselIn > 0 && v.saison!.wechselIn <= 31 * 3600, 'bis zum Herbst: höchstens ein Monat');
  assert.equal(farmView(initialState(rules), rules, true).hofzeit, null, 'V52 kennt keine Hofzeit');
});
