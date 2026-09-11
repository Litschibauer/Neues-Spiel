import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { getRuleset, wetterBei, wetterWechselIn } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(44);
const ohne = getRuleset(43);
const R_WHEAT = 0;
const REIFE = rules.recipes[R_WHEAT]!.durationTicks;
const w = rules.wetter!;

// Den ersten Tick finden, an dem es regnet bzw. nicht regnet.
function tickMit(regen: boolean): number {
  for (let f = 0; f < 10_000; f++) {
    const t = f * w.fensterTicks;
    if ((wetterBei(rules, t) === 'regen') === regen) return t;
  }
  throw new Error('kein passendes Fenster gefunden');
}

test('das Wetter steht je Fenster fest und wechselt am Fensterrand', () => {
  const t = tickMit(true);
  assert.equal(wetterBei(rules, t), 'regen');
  assert.equal(wetterBei(rules, t + w.fensterTicks - 1), 'regen', 'innerhalb des Fensters stabil');
  assert.equal(wetterWechselIn(rules, t + 100), w.fensterTicks - 100);
  // Ohne Wetter im Regelwerk: immer klar, kein Wechsel.
  assert.equal(wetterBei(ohne, t), 'klar');
  assert.equal(wetterWechselIn(ohne, t), 0);
});

test('die Verteilung passt zur alten Stimmung: meist klar, manchmal Regen', () => {
  let klar = 0, regen = 0;
  for (let f = 0; f < 2000; f++) {
    const art = wetterBei(rules, f * w.fensterTicks);
    if (art === 'klar') klar++;
    if (art === 'regen') regen++;
  }
  assert.ok(klar > 1000 && klar < 1500, `klar: ${klar} von 2000`);
  assert.ok(regen > 150 && regen < 450, `Regen: ${regen} von 2000`);
});

test('bei Regen angesetzt, reift die Saat ein Fuenftel frueher', () => {
  const t = tickMit(true);
  const feld = w.plaetze[0]!;
  let s = initialState(rules);
  s = simulate(s, { seq: 1, tick: t, type: 'START', plot: feld, recipe: R_WHEAT }, rules);
  const schub = Math.floor((REIFE * w.regenSchubProzent) / 100);
  assert.ok(schub > 0);
  assert.equal(s.plots[feld]!.slots[0]!.startedAt, t - schub, 'der Start ist um den Schub vorgerueckt');
  assert.throws(() => simulate(s, { seq: 2, tick: t + REIFE - schub - 1, type: 'COLLECT', plot: feld }, rules), /NOT_DONE/);
  assert.doesNotThrow(() => simulate(s, { seq: 2, tick: t + REIFE - schub, type: 'COLLECT', plot: feld }, rules));
});

test('ohne Regen bleibt alles wie es war', () => {
  const t = tickMit(false);
  const feld = w.plaetze[0]!;
  const s = simulate(initialState(rules), { seq: 1, tick: t, type: 'START', plot: feld, recipe: R_WHEAT }, rules);
  assert.equal(s.plots[feld]!.slots[0]!.startedAt, t);
});

test('der Regen hilft nur Feldern — nicht Staellen oder Werkstaetten', () => {
  const felder = new Set(w.plaetze);
  rules.plots.forEach((p, i) => {
    assert.equal(felder.has(i), p.id.startsWith('field-'), `${p.id} ist ${felder.has(i) ? '' : 'kein '}Feld`);
  });
});

test('ein Regelwerk ohne Wetter kennt keinen Schub', () => {
  const t = tickMit(true);
  const s = simulate(initialState(ohne), { seq: 1, tick: t, type: 'START', plot: 0, recipe: R_WHEAT }, ohne);
  assert.equal(s.plots[0]!.slots[0]!.startedAt, t);
});

test('Server und Geraet sehen dasselbe Wetter — kein Divergenzalarm bei Regen', () => {
  const t = tickMit(true);
  const server = new Server(initialState(rules), T0, 44);
  const client = new Client(server.snapshot, 'handy');
  client.advanceClock(t);
  assert.equal(client.start(w.plaetze[0]!, R_WHEAT).ok, true);
  const res = server.sync(client.buildSyncRequest(), T0 + t * 1000);
  assert.equal(res.ok, true);
  assert.equal(
    server.snapshot.state.plots[w.plaetze[0]!]!.slots[0]!.startedAt,
    client.preview().plots[w.plaetze[0]!]!.slots[0]!.startedAt,
  );
});
