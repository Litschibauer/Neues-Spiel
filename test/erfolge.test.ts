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
