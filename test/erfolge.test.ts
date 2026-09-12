import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';

const V = getRuleset(31);

test('ab v31 gibt es Erfolge mit Belohnung', () => {
  assert.ok((V.achievements ?? []).length >= 10);
  assert.ok(V.achievements!.every((a) => a.id && a.label && (a.gold > 0 || a.xp > 0)));
});

test('einen erreichten Erfolg einlösen gibt Gold + XP — genau einmal', () => {
  const base = initialState(V);
  const items = base.items.map(() => 0);
  items[V.currency] = 1000;
  const s = { ...base, items, xp: 0 };

  // gold1k ist erfüllt (1000 Gold), Belohnung nur XP.
  const nach = simulate(s, { seq: 1, tick: 0, type: 'CLAIM_ACHIEVEMENT', id: 'gold1k' }, V);
  const ach = V.achievements!.find((a) => a.id === 'gold1k')!;
  assert.equal(nach.xp, ach.xp, 'XP gutgeschrieben');
  assert.ok(nach.claimed.includes('gold1k'), 'als eingelöst vermerkt');

  assert.throws(
    () => simulate(nach, { seq: 1, tick: 0, type: 'CLAIM_ACHIEVEMENT', id: 'gold1k' }, V),
    { code: 'ALREADY_CLAIMED' },
    'kein zweites Mal',
  );
});

test('ein Bau-Erfolg gibt Gold + XP, sobald das Gebäude steht', () => {
  const base = initialState(V);
  const MILL = V.plots.findIndex((p) => p.id === 'mill');
  const plots = base.plots.map((p, i) => (i === MILL ? { ...p, level: 1 } : p));
  const s = { ...base, plots, items: base.items.map(() => 0), xp: 0 };

  const ach = V.achievements!.find((a) => a.id === 'mill')!;
  const nach = simulate(s, { seq: 1, tick: 0, type: 'CLAIM_ACHIEVEMENT', id: 'mill' }, V);
  assert.equal(nach.items[V.currency], ach.gold, 'Gold-Belohnung');
  assert.equal(nach.xp, ach.xp, 'XP-Belohnung');
});

test('nicht erreichte oder unbekannte Erfolge lassen sich nicht einlösen', () => {
  const s = initialState(V); // frisch, xp 0
  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'CLAIM_ACHIEVEMENT', id: 'lvl15' }, V),
    { code: 'NOT_YET_EARNED' },
  );
  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'CLAIM_ACHIEVEMENT', id: 'gibtsnicht' }, V),
    { code: 'NO_SUCH_ACHIEVEMENT' },
  );
});

// ---- v49: mehr Erfolge, neue Arten, Reihen ----
import { Server as ServerV49 } from '../src/server/server.ts';
import { farmView as farmViewV49 } from '../src/client/view.ts';
import { ZAEHLER as ZAEHLER_V49 } from '../src/sim/state.ts';

const V49 = getRuleset(49);
const V48 = getRuleset(48);

test('v49 haengt nur hinten an und gibt jedem alten Erfolg seine Reihe', () => {
  const alt = V48.achievements!;
  const neu = V49.achievements!;
  assert.ok(neu.length >= alt.length + 40, `${neu.length} Erfolge`);
  alt.forEach((a, i) => assert.equal(neu[i]!.id, a.id, 'Reihenfolge bleibt'));
  assert.equal(neu.find((a) => a.id === 'lvl3')!.reihe, 'stufe');
  assert.equal(neu.find((a) => a.id === 'fest1')!.group, 'treue');
  const ids = new Set(neu.map((a) => a.id));
  assert.equal(ids.size, neu.length, 'keine doppelte Kennung');
  assert.ok(neu.every((a) => a.label && (a.gold > 0 || a.xp > 0)));
});

test('Zaehler, Tiere, Baumzahl, Tage und Wochen werden zu Erfolgen', () => {
  let s = initialState(V49);
  const zaehler = s.zaehler.slice();
  zaehler[ZAEHLER_V49.ERNTEN] = 150;
  zaehler[ZAEHLER_V49.VERKAUFT] = 100;
  s = { ...s, zaehler, tageGeschafft: 7, wochenGeschafft: 4 };
  // Sieben Tiere im ersten Stall — direkt gesetzt, es geht um die Zaehlung.
  const COOP = V49.plots.findIndex((p) => p.id === 'coop-1');
  s = { ...s, plots: s.plots.map((p, i) => (i === COOP ? { ...p, level: 1, gx: 0, gy: 0, tiere: [0, 0, 0, 0, 0, 0, 0] } : p)) };
  const v = farmViewV49(s, V49);
  const stand = (id: string) => v.erfolge.find((e) => e.id === id)!;
  assert.equal(stand('ernte100').erfuellt, true);
  assert.equal(stand('ernte1000').ist, 150);
  assert.equal(stand('verkauf50').erfuellt, true);
  assert.equal(stand('tiere5').erfuellt, true);
  assert.equal(stand('tiere15').ist, 7);
  assert.equal(stand('tage7').erfuellt, true);
  assert.equal(stand('wochen4').erfuellt, true);
  assert.equal(stand('baeume3').ist, 0);
  // Keine Aufgabe und kein Erfolg zaehlt mehr etwas, das man nicht tun kann.
  const alleZettel = [...(V49.tagesaufgaben ?? []), ...(V49.wochenaufgaben ?? []), ...V49.feste!.arten.flatMap((a) => a.aufgaben)];
  assert.ok(alleZettel.every((t) => !/Anfragen/.test(t.label)), 'keine toten Anfragen-Zettel');
  assert.ok(alleZettel.filter((t) => t.art === ZAEHLER_V49.KISTEN).length >= 3, 'Kisten-Zettel an ihrer Stelle');
  assert.ok(alleZettel.filter((t) => t.art === ZAEHLER_V49.VERKAUFT).every((t) => /Kästchen am Stand/.test(t.label) && t.menge <= 25));
  // Eine geoeffnete Kiste zaehlt — aber erst ab 49.
  const mitKiste = { ...s, chests: [{ id: 1, kind: 0, readyAt: 0, gx: 0, gy: 1 }], chestReadyAt: 0 };
  const auf = simulate(mitKiste, { seq: 1, tick: 0, type: 'OPEN_CHEST', chestId: 1 }, V49);
  assert.equal(auf.zaehler[ZAEHLER_V49.KISTEN], (s.zaehler[ZAEHLER_V49.KISTEN] ?? 0) + 1);
  const geholt = simulate(s, { seq: 1, tick: 0, type: 'CLAIM_ACHIEVEMENT', id: 'ernte100' }, V49);
  assert.ok(geholt.claimed.includes('ernte100'));
});

test('Tages- und Wochenabschluss zaehlen mit — vorher steht nichts', () => {
  const T0 = 1_700_000_000_000;
  const server = new ServerV49({ ...initialState(V49), xp: 100_000 }, T0, 49);
  const st = server.snapshot.state;
  assert.equal(st.tageGeschafft, 0);
  assert.equal(st.wochenGeschafft, 0);
});
