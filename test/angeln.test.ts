import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset, LATEST_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { reachableItems } from '../src/server/requests.ts';

const V = getRuleset(LATEST_RULESET_VERSION);
const F = V.fishing!;
const cast = (tick: number, seq = 1) => ({ seq, tick, type: 'CAST_LINE' as const });
const repair = (tick = 0, seq = 1) => ({ seq, tick, type: 'REPAIR_BOAT' as const });
const craft = (tick = 0, seq = 1) => ({ seq, tick, type: 'CRAFT_BAIT' as const });

function mitItems(base = initialState(V), paare: [number, number][] = []) {
  const items = base.items.slice();
  for (const [i, n] of paare) items[i] = n;
  return { ...base, items };
}

function angelbereit() {
  // Boot repariert, genug XP und ein paar Köder im Lager.
  const base = mitItems(initialState(V), [[F.bait, 5]]);
  return { ...base, xp: 100000, bootRepariert: true };
}

test('solange das Boot kaputt ist, ist der See zu', () => {
  const s = mitItems(initialState(V), [[F.bait, 5]]);
  assert.throws(() => simulate(s, cast(0), V), { code: 'NO_FISHING' });
});

test('ohne Köder beißt nichts (See offen)', () => {
  const s = { ...initialState(V), xp: 100000, bootRepariert: true };
  assert.throws(() => simulate(s, cast(0), V), { code: 'NO_BAIT' });
});

test('Boot reparieren braucht die Stufe und zahlt Gold + Material', () => {
  // Zu niedrige Stufe → geht nicht.
  const reich = mitItems({ ...initialState(V), xp: 0 }, F.repair!.map((c) => [c.item, c.amount] as [number, number]));
  assert.throws(() => simulate(reich, repair(), V), { code: 'PLAYER_LEVEL_TOO_LOW' });

  // Stufe da, aber kein Material → geht nicht.
  const pleite = { ...initialState(V), xp: 100000 };
  assert.throws(() => simulate(pleite, repair(), V), { code: 'CANT_AFFORD' });

  // Stufe + Material → Boot fährt, Kosten abgezogen.
  const bereit = mitItems({ ...initialState(V), xp: 100000 }, F.repair!.map((c) => [c.item, c.amount] as [number, number]));
  const nach = simulate(bereit, repair(), V);
  assert.equal(nach.bootRepariert, true, 'Boot repariert');
  for (const c of F.repair!) assert.equal(nach.items[c.item], 0, 'Material weg');
});

test('ein repariertes Boot bleibt repariert — kein zweites Mal zahlen', () => {
  const bereit = mitItems({ ...initialState(V), xp: 100000, bootRepariert: true }, F.repair!.map((c) => [c.item, c.amount] as [number, number]));
  assert.throws(() => simulate(bereit, repair(), V), { code: 'BOAT_DONE' });
});

test('Köder stellt man am See her — Weizen rein, Köder raus', () => {
  const input = F.craft!.input.map((c) => [c.item, c.amount] as [number, number]);
  const s = mitItems({ ...initialState(V), xp: 100000, bootRepariert: true }, input);
  const nach = simulate(s, craft(), V);
  assert.equal(nach.items[F.bait], F.craft!.output, 'Köder hergestellt');
  for (const c of F.craft!.input) assert.equal(nach.items[c.item], 0, 'Zutat verbraucht');
});

test('Köder herstellen geht nur bei offenem See', () => {
  const input = F.craft!.input.map((c) => [c.item, c.amount] as [number, number]);
  const s = mitItems({ ...initialState(V), xp: 100000 }, input); // Boot noch kaputt
  assert.throws(() => simulate(s, craft(), V), { code: 'NO_FISHING' });
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
  const zu = reachableItems({ ...initialState(V), xp: 100000 }, V); // Stufe da, Boot kaputt
  const auf = reachableItems({ ...initialState(V), xp: 100000, bootRepariert: true }, V);
  assert.ok(!zu.has(F.table[0]!.item), 'vor der Reparatur kein Fisch-Auftrag');
  assert.ok(auf.has(F.table[0]!.item), 'nach der Reparatur schon');
});
