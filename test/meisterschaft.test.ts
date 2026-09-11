import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { farmView } from '../src/client/view.ts';
import { hashState } from '../src/sim/hash.ts';
import { migrateState } from '../src/sim/migrate.ts';
import { getRuleset, meisterFaehig, meisterGrenzen, sterneVon } from '../src/sim/rules.ts';
import { count, initialState, type State } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(47);
const M = rules.meisterschaft!;
const idx = (id: string) => rules.items.findIndex((i) => i.id === id);
const plotIdx = (id: string) => rules.plots.findIndex((p) => p.id === id);
const WHEAT = idx('wheat');
const FEED = idx('feed');
const MILL = plotIdx('mill');
const R_FEED = rules.recipes.findIndex((r) => r.id === 'feed');
const FUTTER = rules.recipes[R_FEED]!;

function setzeIrgendwo(s: State, plot: number, seq: number): State {
  if (!rules.grid || s.plots[plot]!.gx >= 0) return s;
  for (let gy = 0; gy < rules.grid.h; gy++) {
    for (let gx = 0; gx < rules.grid.w; gx++) {
      try {
        return simulate(s, { seq, tick: s.tick, type: 'PLACE', plot, gx, gy }, rules);
      } catch {
        // belegt oder gesperrt — weiter
      }
    }
  }
  throw new Error('nirgends Platz');
}

// Ein Hof mit Mühle, Gold und Stufe. Weizen liegt bereit, das Lager ist sonst leer.
function hofMitMuehle(r = rules) {
  let s = initialState(r);
  s = { ...s, xp: 100_000, items: s.items.map((n, i) => (i === r.currency ? 100_000 : i === WHEAT ? 60 : n)) };
  s = simulate(s, { seq: 1, tick: 0, type: 'BUY', plot: MILL }, r);
  s = setzeIrgendwo(s, MILL, 2);
  return { s, seq: 3 };
}

// So viele Durchläufe Hühnerfutter: ansetzen, abholen, den Sack wieder loswerden,
// damit das Lager nie voll wird. Weizen wird zwischendurch aufgefüllt.
function laufe(hof: { s: State; seq: number }, n: number, r = rules) {
  let { s, seq } = hof;
  for (let k = 0; k < n; k++) {
    if (count(s, WHEAT) < 3) s = { ...s, items: s.items.map((x, i) => (i === WHEAT ? 60 : x)) };
    const start = s.tick;
    s = simulate(s, { seq: seq++, tick: start, type: 'START', plot: MILL, recipe: R_FEED }, r);
    s = simulate(s, { seq: seq++, tick: start + FUTTER.durationTicks, type: 'COLLECT', plot: MILL }, r);
    const futter = count(s, FEED);
    if (futter > 0) s = simulate(s, { seq: seq++, tick: s.tick, type: 'DISCARD', item: FEED, amount: futter }, r);
  }
  // Wer danach weitermahlen will, findet Weizen vor.
  if (count(s, WHEAT) < 3) s = { ...s, items: s.items.map((x, i) => (i === WHEAT ? 60 : x)) };
  return { s, seq };
}

test('Sterne bekommen Werkstätten und Ställe — nicht Felder, Bäume und Deko', () => {
  assert.ok(meisterFaehig(rules, MILL));
  assert.ok(meisterFaehig(rules, plotIdx('coop-1')));
  assert.ok(meisterFaehig(rules, plotIdx('sheep-1')));
  assert.ok(meisterFaehig(rules, plotIdx('weberei')));
  assert.equal(meisterFaehig(rules, plotIdx('field-1')), false);
  assert.equal(meisterFaehig(rules, rules.plots.findIndex((p) => p.baum)), false);
  assert.equal(meisterFaehig(rules, rules.plots.findIndex((p) => p.deco)), false);
  // Ohne Meisterschaft im Regelwerk macht niemand mit.
  assert.equal(meisterFaehig(getRuleset(46), MILL), false);
});

test('aus Abholungen werden Sterne, mit klaren Grenzen', () => {
  assert.deepEqual(M.stufen, [25, 100, 300]);
  assert.equal(sterneVon(rules, 0), 0);
  assert.equal(sterneVon(rules, 24), 0);
  assert.equal(sterneVon(rules, 25), 1);
  assert.equal(sterneVon(rules, 100), 2);
  assert.equal(sterneVon(rules, 999), 3);
  assert.deepEqual(meisterGrenzen(rules, 0), { von: 0, ziel: 25 });
  assert.deepEqual(meisterGrenzen(rules, 40), { von: 25, ziel: 100 });
  assert.deepEqual(meisterGrenzen(rules, 300), { von: 300, ziel: null });
});

test('jede Abholung zählt — vorher steht nichts im Zustand', () => {
  const hof = hofMitMuehle();
  assert.equal('meister' in hof.s.plots[MILL]!, false, 'ohne Abholung kein Feld');
  const { s } = laufe(hof, 3);
  assert.equal(s.plots[MILL]!.meister, 3);
  // Der Zähler steht auch in der Prüfsumme — sonst könnte er unbemerkt abweichen.
  const ohne = { ...s, plots: s.plots.map((p, i) => (i === MILL ? { ...p, meister: undefined } : p)) } as State;
  assert.notEqual(hashState(s), hashState(ohne));
});

test('erster Stern: alles läuft zehn Prozent schneller', () => {
  let hof = laufe(hofMitMuehle(), M.stufen[0]! - 1);
  const kurz = FUTTER.durationTicks - Math.floor((FUTTER.durationTicks * M.schnellerProzent) / 100);
  // Noch kein Stern: nach 90 % der Zeit ist nichts fertig.
  let s = simulate(hof.s, { seq: hof.seq++, tick: hof.s.tick, type: 'START', plot: MILL, recipe: R_FEED }, rules);
  assert.throws(() => simulate(s, { seq: hof.seq, tick: s.tick + kurz, type: 'COLLECT', plot: MILL }, rules), /NOT_DONE/);
  s = simulate(s, { seq: hof.seq++, tick: s.tick + FUTTER.durationTicks, type: 'COLLECT', plot: MILL }, rules);
  assert.equal(sterneVon(rules, s.plots[MILL]!.meister!), 1, 'jetzt leuchtet der Stern');
  // Mit Stern: nach 90 % ist es fertig.
  s = simulate(s, { seq: hof.seq++, tick: s.tick, type: 'START', plot: MILL, recipe: R_FEED }, rules);
  s = simulate(s, { seq: hof.seq++, tick: s.tick + kurz, type: 'COLLECT', plot: MILL }, rules);
  assert.equal(s.plots[MILL]!.meister, M.stufen[0]! + 1);
});

test('zweiter Stern: die Hälfte mehr XP je Abholung', () => {
  let hof = laufe(hofMitMuehle(), M.stufen[1]!);
  const xpVor = hof.s.xp;
  let s = simulate(hof.s, { seq: hof.seq++, tick: hof.s.tick, type: 'START', plot: MILL, recipe: R_FEED }, rules);
  s = simulate(s, { seq: hof.seq++, tick: s.tick + FUTTER.durationTicks, type: 'COLLECT', plot: MILL }, rules);
  assert.equal(s.xp - xpVor, FUTTER.xp + Math.floor((FUTTER.xp * M.xpProzent) / 100));
});

test('dritter Stern: jede fünfte Abholung bringt ein Stück extra', () => {
  let hof = laufe(hofMitMuehle(), M.stufen[2]!);
  let s = hof.s;
  let seq = hof.seq;
  const mengen: number[] = [];
  for (let k = 0; k < M.extraJede; k++) {
    s = simulate(s, { seq: seq++, tick: s.tick, type: 'START', plot: MILL, recipe: R_FEED }, rules);
    s = simulate(s, { seq: seq++, tick: s.tick + FUTTER.durationTicks, type: 'COLLECT', plot: MILL }, rules);
    mengen.push(count(s, FEED));
    s = simulate(s, { seq: seq++, tick: s.tick, type: 'DISCARD', item: FEED, amount: count(s, FEED) }, rules);
  }
  const normal = FUTTER.output.amount;
  assert.deepEqual(mengen, [normal, normal, normal, normal, normal + 1]);
});

test('Fassung 46 zählt nichts — ihr Zustand bleibt, wie er war', () => {
  const alt = getRuleset(46);
  const { s } = laufe(hofMitMuehle(alt), 3, alt);
  assert.equal('meister' in s.plots[MILL]!, false);
  // Und wer von 46 nach 47 kommt, fängt bei null an, ohne dass etwas kippt.
  const neu = migrateState(s, 46, 47);
  assert.equal(neu.plots[MILL]!.meister, undefined);
  assert.equal(neu.plots[MILL]!.level, 1);
});

test('die Sicht zeigt Sterne, Weg und Vorteile — nur an Gebäuden', () => {
  const { s } = laufe(hofMitMuehle(), 4);
  const v = farmView(s, rules);
  assert.deepEqual(v.plots[MILL]!.meister, {
    punkte: 4, sterne: 0, maxSterne: 3, von: 0, ziel: 25,
    schnellerProzent: 10, xpProzent: 50, extraJede: 5,
  });
  assert.equal(v.plots[plotIdx('field-1')]!.meister, null);
});

test('Erfolge zählen Sterne über den ganzen Hof', () => {
  const hof = laufe(hofMitMuehle(), M.stufen[0]!);
  const v = farmView(hof.s, rules);
  const stern1 = v.erfolge.find((e) => e.id === 'stern1')!;
  assert.ok(stern1.erfuellt && !stern1.eingeloest);
  const s = simulate(hof.s, { seq: hof.seq, tick: hof.s.tick, type: 'CLAIM_ACHIEVEMENT', id: 'stern1' }, rules);
  assert.ok((s.claimed ?? []).includes('stern1'));
  const meister1 = v.erfolge.find((e) => e.id === 'meister1')!;
  assert.equal(meister1.erfuellt, false, 'ein Stern ist noch kein gemeistertes Gebäude');
});

test('Server und Gerät zählen dasselbe', () => {
  const start = hofMitMuehle();
  const server = new Server(start.s as never, T0, 47);
  const client = new Client(server.snapshot, 'handy');
  let t = 0;
  for (let k = 0; k < 3; k++) {
    assert.equal(client.start(MILL, R_FEED, 0).ok, true);
    client.advanceClock(FUTTER.durationTicks);
    t += FUTTER.durationTicks;
    assert.equal(client.collect(MILL, 0).ok, true);
  }
  const res = server.sync(client.buildSyncRequest(), T0 + t * 1000);
  assert.equal(res.ok, true);
  assert.equal(server.snapshot.state.plots[MILL]!.meister, 3);
});
