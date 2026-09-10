import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { getRuleset } from '../src/sim/rules.ts';
import type { State } from '../src/sim/state.ts';
import { ZAEHLER, count, initialState, zaehlerStand } from '../src/sim/state.ts';
import { fundstueck, simulate } from '../src/sim/sim.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(41);
const ohneFunde = getRuleset(40);
const R_WHEAT = 0;
const REIFE = rules.recipes[R_WHEAT]!.durationTicks;
const GOLD = rules.currency;

// Einen Hof so lange abernten und neu ansetzen, wie es Ernten braucht. Gibt
// zurueck, was dabei zusammenkam — Funde eingeschlossen.
function ernte(regeln: typeof rules, wieOft: number) {
  const WEIZEN = 1;
  // Vor jeder Runde denselben Vorrat herstellen: So geht weder das Saatgut aus
  // noch laeuft das Lager ueber. Auf den Fund wirkt das nicht — der haengt an
  // Tick, Erntezahl und Platz, nicht am Korn.
  const nachfuellen = (st: State): State => ({
    ...st,
    items: st.items.map((n, i) => (i === WEIZEN ? 100 : n)),
  });

  let s = nachfuellen(initialState(regeln));
  let seq = 1;
  const funde: Array<{ item: number; amount: number }> = [];

  for (let i = 0; i < wieOft; i++) {
    const plot = i % 3;
    s = simulate(s, { seq: seq++, tick: s.tick, type: 'START', plot, recipe: R_WHEAT }, regeln);
    const vorher = s.items.slice();
    const erwartet = regeln.recipes[R_WHEAT]!.output;
    s = simulate(s, { seq: seq++, tick: s.tick + REIFE, type: 'COLLECT', plot }, regeln);
    for (let item = 0; item < s.items.length; item++) {
      const dazu = (s.items[item] ?? 0) - (vorher[item] ?? 0) -
        (item === erwartet.item ? erwartet.amount : 0);
      if (dazu > 0) funde.push({ item, amount: dazu });
    }
    s = nachfuellen(s);
  }
  return { state: s, funde };
}

test('derselbe Spielstand liefert denselben Fund — zweimal gerechnet, gleiches Ergebnis', () => {
  const s = initialState(rules);
  const a = fundstueck(s, rules, 0);
  const b = fundstueck(s, rules, 0);
  assert.deepEqual(a, b);
});

test('der Fund haengt am Stand, nicht am Zufall: zwei gleiche Laeufe enden gleich', () => {
  const eins = ernte(rules, 40);
  const zwei = ernte(rules, 40);
  assert.deepEqual(eins.funde, zwei.funde, 'zwei identische Laeufe muessen dasselbe finden');
  assert.deepEqual(eins.state.items, zwei.state.items);
});

test('es liegt regelmaessig etwas im Acker — aber nicht bei jeder Ernte', () => {
  const { funde } = ernte(rules, 200);
  assert.ok(funde.length > 0, 'in 200 Ernten muss etwas dabei sein');
  assert.ok(
    funde.length < 200,
    `ein Fund bei jeder Ernte waere kein Fund mehr (${funde.length} von 200)`,
  );
  // Die Regel sagt „jede achte" — grob muss die Wirklichkeit dazu passen.
  assert.ok(
    funde.length >= 200 / 24 && funde.length <= 200 / 3,
    `${funde.length} Funde in 200 Ernten liegen zu weit von einem Achtel entfernt`,
  );
});

test('gefunden wird nur, was in der Tabelle steht', () => {
  const erlaubt = new Set(rules.fundstuecke!.tabelle.map((t) => `${t.item}x${t.amount}`));
  const { funde } = ernte(rules, 200);
  for (const f of funde) {
    assert.ok(erlaubt.has(`${f.item}x${f.amount}`), `unbekannter Fund: ${f.item} x${f.amount}`);
  }
});

test('ein Regelwerk ohne Fundstuecke laesst den Acker leer', () => {
  assert.equal(fundstueck(initialState(ohneFunde), ohneFunde, 0), null);
  const { funde } = ernte(ohneFunde, 60);
  assert.deepEqual(funde, [], 'unter Regelwerk 40 darf nichts obendrauf kommen');
});

test('ist das Lager voll, bleibt der Fund liegen — sonst spraenge es der Fund', () => {
  const s = initialState(rules);
  const lagerbar = rules.fundstuecke!.tabelle.find((t) => rules.items[t.item]?.storable);
  assert.ok(lagerbar, 'für den Test braucht es ein lagerbares Fundstück');

  // Ein Stand, dessen Lager bis an den Rand voll ist.
  const voll = { ...s, items: s.items.map((n, i) => (i === 1 ? 100_000 : n)) } as State;
  const gefunden = fundstueck(voll, rules, 0);
  assert.ok(
    gefunden === null || !rules.items[gefunden.item]?.storable,
    'im vollen Lager darf nichts Lagerbares gefunden werden',
  );
});

test('gefundenes Gold zaehlt als Einnahme — die Tagesaufgabe merkt es', () => {
  const { state, funde } = ernte(rules, 200);
  const goldFunde = funde.filter((f) => f.item === GOLD).reduce((n, f) => n + f.amount, 0);
  assert.ok(goldFunde > 0, 'in 200 Ernten muss Gold dabei sein');
  assert.ok(
    zaehlerStand(state, ZAEHLER.GOLD) >= goldFunde,
    'der Gold-Zähler muss die Funde enthalten',
  );
});

test('Server und Geraet finden dasselbe — sonst gaebe es Divergenz', () => {
  const server = new Server(initialState(rules), T0, 41);
  const client = new Client(server.snapshot, 'handy');

  let vergangen = 0;
  for (let i = 0; i < 12; i++) {
    client.start(i % 3, R_WHEAT);
    client.advanceClock(REIFE);
    vergangen += REIFE;
    assert.equal(client.collect(i % 3).ok, true, `Ernte ${i} muss lokal klappen`);
  }

  const res = server.sync(client.buildSyncRequest(), T0 + vergangen * 1000);
  assert.equal(res.ok, true, 'der Server darf die Funde nicht als Abweichung sehen');
  assert.equal(
    count(server.snapshot.state, GOLD),
    count(client.preview(), GOLD),
    'beide Seiten müssen auf denselben Goldstand kommen',
  );
});
