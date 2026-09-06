import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset, LATEST_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { reachableItems } from '../src/server/requests.ts';

const V = getRuleset(LATEST_RULESET_VERSION);
const F = V.fishing!;
const cast = (tick: number, seq = 1) => ({ seq, tick, type: 'CAST_LINE' as const });

function angelbereit() {
  // Genug XP (über minLevel) und ein paar Köder im Lager.
  const base = initialState(V);
  const items = base.items.slice();
  items[F.bait] = 5;
  return { ...base, xp: 100000, items };
}

test('ohne freigeschalteten See (zu niedrige Stufe) geht Angeln nicht', () => {
  const s = { ...initialState(V), items: initialState(V).items.map((_, i) => (i === F.bait ? 5 : 0)) };
  assert.throws(() => simulate(s, cast(0), V), { code: 'NO_FISHING' });
});

test('ohne Köder beißt nichts', () => {
  const s = { ...initialState(V), xp: 100000 };
  assert.throws(() => simulate(s, cast(0), V), { code: 'NO_BAIT' });
});

test('Auswerfen verbraucht einen Köder und bringt genau einen Fisch', () => {
  const s = angelbereit();
  const fischItems = F.table.map((t) => t.item);
  const fischVor = fischItems.reduce((n, i) => n + s.items[i]!, 0);
  const nach = simulate(s, cast(0), V);
  assert.equal(nach.items[F.bait], s.items[F.bait]! - 1, 'ein Köder weg');
  const fischNach = fischItems.reduce((n, i) => n + nach.items[i]!, 0);
  assert.equal(fischNach, fischVor + 1, 'genau ein Fisch dazu');
  assert.equal(nach.angelFang, 1, 'Fang-Zähler hoch');
  assert.equal(nach.xp, s.xp + F.xp, 'XP dazu');
});

test('der Fang ist deterministisch — gleicher Zustand, gleicher Fisch', () => {
  const s = angelbereit();
  const a = simulate(s, cast(42), V);
  const b = simulate(s, cast(42), V);
  const fisch = (st: typeof a) => F.table.map((t) => st.items[t.item]).join(',');
  assert.equal(fisch(a), fisch(b), 'reproduzierbar');
});

test('über viele Würfe kommen mehrere Fischarten vor (Verteilung)', () => {
  let s = angelbereit();
  s = { ...s, items: s.items.map((v, i) => (i === F.bait ? 200 : v)) };
  const arten = new Set<number>();
  for (let t = 0; t < 200; t++) {
    s = simulate(s, cast(t * 7, t + 1), V);
    F.table.forEach((f) => { if (s.items[f.item]! > 0) arten.add(f.item); });
  }
  assert.ok(arten.size >= 2, 'nicht immer derselbe Fisch');
});

test('Fische sind auftragsfähig, sobald der See offen ist', () => {
  const zu = reachableItems({ ...initialState(V), xp: 0 }, V);
  const auf = reachableItems({ ...initialState(V), xp: 100000 }, V);
  assert.ok(!zu.has(F.table[0]!.item), 'vor Freischaltung kein Fisch-Auftrag');
  assert.ok(auf.has(F.table[0]!.item), 'nach Freischaltung schon');
});
