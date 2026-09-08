import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset, LATEST_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { reachableItems } from '../src/server/requests.ts';

const V = getRuleset(LATEST_RULESET_VERSION);
const F = V.fishing!;
const SOAK = F.soakTicks!;
const SUD = F.craft!.durationTicks!;

const repair = (tick = 0, seq = 1) => ({ seq, tick, type: 'REPAIR_BOAT' as const });
const craft = (tick = 0, seq = 1, slot?: number) => ({ seq, tick, type: 'CRAFT_BAIT' as const, slot });
const nimmSud = (slot: number, tick: number, seq = 1) =>
  ({ seq, tick, type: 'COLLECT_BAIT' as const, slot });
const lege = (spot: number, tick: number, seq = 1) =>
  ({ seq, tick, type: 'BAIT_SPOT' as const, spot });
const hole = (spot: number, tick: number, seq = 1) =>
  ({ seq, tick, type: 'COLLECT_SPOT' as const, spot });

function mitItems(base = initialState(V), paare: [number, number][] = []) {
  const items = base.items.slice();
  for (const [i, n] of paare) items[i] = n;
  return { ...base, items };
}

function angelbereit(koeder = 5) {
  const base = mitItems(initialState(V), [[F.bait, koeder]]);
  return { ...base, xp: 100000, bootRepariert: true };
}

// — Boot ————————————————————————————————————————————————————————————————

test('Boot reparieren braucht die Stufe und zahlt Gold + Material', () => {
  const kosten = F.repair!.map((c) => [c.item, c.amount] as [number, number]);
  assert.throws(() => simulate(mitItems({ ...initialState(V), xp: 0 }, kosten), repair(), V), {
    code: 'PLAYER_LEVEL_TOO_LOW',
  });
  assert.throws(() => simulate({ ...initialState(V), xp: 100000 }, repair(), V), {
    code: 'CANT_AFFORD',
  });

  const bereit = mitItems({ ...initialState(V), xp: 100000 }, kosten);
  const nach = simulate(bereit, repair(), V);
  assert.equal(nach.bootRepariert, true, 'Boot repariert');
  for (const c of F.repair!) assert.equal(nach.items[c.item], 0, 'Material weg');
});

test('ein repariertes Boot bleibt repariert — kein zweites Mal zahlen', () => {
  const kosten = F.repair!.map((c) => [c.item, c.amount] as [number, number]);
  const bereit = mitItems({ ...initialState(V), xp: 100000, bootRepariert: true }, kosten);
  assert.throws(() => simulate(bereit, repair(), V), { code: 'BOAT_DONE' });
});

// — Köder sieden ————————————————————————————————————————————————————————

test('Köder entstehen nicht sofort: erst sieden, dann abholen', () => {
  const input = F.craft!.input.map((c) => [c.item, c.amount] as [number, number]);
  const s = mitItems({ ...initialState(V), xp: 100000, bootRepariert: true }, input);

  const gestartet = simulate(s, craft(0), V);
  assert.equal(gestartet.items[F.bait], 0, 'noch kein Köder im Lager');
  assert.equal(gestartet.angelKoeder[0], 0, 'Platz 0 siedet seit Tick 0');
  for (const c of F.craft!.input) assert.equal(gestartet.items[c.item], 0, 'Zutat verbraucht');

  assert.throws(() => simulate({ ...gestartet, tick: SUD - 1 }, nimmSud(0, SUD - 1), V), {
    code: 'BAIT_NOT_READY',
  });

  const fertig = simulate({ ...gestartet, tick: SUD }, nimmSud(0, SUD), V);
  assert.equal(fertig.items[F.bait], F.craft!.output, 'Köder da');
  assert.equal(fertig.angelKoeder[0], -1, 'Platz wieder frei');
});

test('die Werkbank hat begrenzte Plätze', () => {
  const viel = F.craft!.input.map((c) => [c.item, c.amount * 10] as [number, number]);
  let s = mitItems({ ...initialState(V), xp: 100000, bootRepariert: true }, viel);
  for (let i = 0; i < F.craft!.slots!; i++) s = simulate(s, craft(0, i + 1), V);
  assert.throws(() => simulate(s, craft(0, 99), V), { code: 'NO_BAIT_SLOT' });
});

test('Köder sieden geht nur bei offenem See', () => {
  const input = F.craft!.input.map((c) => [c.item, c.amount] as [number, number]);
  const s = mitItems({ ...initialState(V), xp: 100000 }, input);
  assert.throws(() => simulate(s, craft(), V), { code: 'NO_FISHING' });
});

// — Reusen ——————————————————————————————————————————————————————————————

test('Köder legen kostet einen Köder und belegt die Stelle', () => {
  const s = angelbereit();
  const nach = simulate(s, lege(2, 10), V);
  assert.equal(nach.items[F.bait], 4, 'ein Köder weg');
  assert.equal(nach.angelSpots[2], 10, 'Stelle beködert');
  assert.throws(() => simulate(nach, lege(2, 11), V), { code: 'SPOT_BUSY' });
});

test('ohne Köder legt man nichts, und der See muss offen sein', () => {
  assert.throws(() => simulate({ ...initialState(V), xp: 100000, bootRepariert: true }, lege(0, 0), V), {
    code: 'NO_BAIT',
  });
  assert.throws(() => simulate(mitItems(initialState(V), [[F.bait, 5]]), lege(0, 0), V), {
    code: 'NO_FISHING',
  });
  assert.throws(() => simulate(angelbereit(), lege(99, 0), V), { code: 'NO_SUCH_SPOT' });
});

test('die Reuse braucht Zeit — vorher gibt es nichts', () => {
  const gelegt = simulate(angelbereit(), lege(0, 0), V);
  assert.throws(() => simulate({ ...gelegt, tick: SOAK - 1 }, hole(0, SOAK - 1), V), {
    code: 'SPOT_NOT_READY',
  });
  assert.throws(() => simulate(angelbereit(), hole(1, 0), V), { code: 'SPOT_EMPTY' });
});

test('eine volle Reuse bringt mehrere Züge, XP und macht die Stelle wieder frei', () => {
  const gelegt = simulate(angelbereit(), lege(0, 0), V);
  const nach = simulate({ ...gelegt, tick: SOAK }, hole(0, SOAK), V);
  const beute = F.table.reduce((n, t) => n + nach.items[t.item]!, 0);
  assert.equal(beute, F.catchPerSpot, 'so viele Züge wie konfiguriert');
  assert.equal(nach.angelSpots[0], -1, 'Stelle wieder frei');
  assert.equal(nach.xp, gelegt.xp + F.xp * F.catchPerSpot!, 'XP je Zug');
  assert.equal(nach.angelFang, F.catchPerSpot, 'Fang-Zähler hoch');
});

test('der Fang ist deterministisch — gleicher Zustand, gleicher Fang', () => {
  const gelegt = { ...simulate(angelbereit(), lege(0, 0), V), tick: SOAK };
  const beute = (st: typeof gelegt) => F.table.map((t) => st.items[t.item]).join(',');
  assert.equal(beute(simulate(gelegt, hole(0, SOAK), V)), beute(simulate(gelegt, hole(0, SOAK), V)));
});

test('über viele Reusen kommen Fische UND Beifang vor', () => {
  let s = angelbereit(120);
  const arten = new Set<number>();
  for (let runde = 0; runde < 120; runde++) {
    const t0 = runde * (SOAK + 3);
    s = simulate({ ...s, tick: t0 }, lege(runde % F.spots!, t0, runde * 2 + 1), V);
    const t1 = t0 + SOAK;
    s = simulate({ ...s, tick: t1 }, hole(runde % F.spots!, t1, runde * 2 + 2), V);
    // Fang notieren und das Lager wieder leeren, sonst läuft es über.
    const items = s.items.slice();
    for (const t of F.table) {
      if (items[t.item]! > 0) arten.add(t.item);
      items[t.item] = 0;
    }
    s = { ...s, items };
  }
  assert.ok(arten.size >= 4, `Vielfalt im Fang (${arten.size} Arten)`);
  const beifang = F.table.filter((t) => V.items[t.item]!.id === 'seaweed' || V.items[t.item]!.id === 'junk-can');
  assert.ok(beifang.some((t) => arten.has(t.item)), 'auch Beifang dabei');
});

test('der Sofort-Wurf ist zu, seit es Reusen gibt', () => {
  assert.throws(() => simulate(angelbereit(), { seq: 1, tick: 0, type: 'CAST_LINE' }, V), {
    code: 'NO_FISHING',
  });
  // Im alten Regelwerk ohne Reusen geht er weiter — Abwärtskompatibilität.
  const alt = getRuleset(33);
  const altF = alt.fishing!;
  const altS = { ...mitItems(initialState(alt), [[altF.bait, 3]]), xp: 100000, bootRepariert: true };
  const nach = simulate(altS, { seq: 1, tick: 0, type: 'CAST_LINE' }, alt);
  assert.equal(nach.items[altF.bait], 2, 'alter Wurf verbraucht Köder');
});

test('Fänge sind auftragsfähig, sobald der See offen ist', () => {
  const zu = reachableItems({ ...initialState(V), xp: 100000 }, V);
  const auf = reachableItems({ ...initialState(V), xp: 100000, bootRepariert: true }, V);
  assert.ok(!zu.has(F.table[0]!.item), 'vor der Reparatur kein Fisch-Auftrag');
  assert.ok(auf.has(F.table[0]!.item), 'nach der Reparatur schon');
});
