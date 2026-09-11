import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, DISCARD_QUEUE } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { farmView } from '../src/client/view.ts';
import { migrateState } from '../src/sim/migrate.ts';
import {
  PRODUCTION_VERSIONS,
  festAktiv,
  festArtIndex,
  festAufgabenFuer,
  getRuleset,
  levelOf,
  wochentagVon,
} from '../src/sim/rules.ts';
import { FEST_ABSCHLUSS, ZAEHLER, count, initialState, wocheVonTag, type State } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';

const TAG_MS = 86_400_000;
const rules = getRuleset(48);
const F = rules.feste!;
// 2026-09-11 ist ein Freitag; der Montag danach der 14.
const FREITAG = Math.floor(Date.UTC(2026, 8, 11) / TAG_MS);
const MONTAG = FREITAG + 3;
const T_FR = FREITAG * TAG_MS + 3_600_000;
const T_MO = MONTAG * TAG_MS + 3_600_000;
const R_WHEAT = 0;
const plotIdx = (id: string) => rules.plots.findIndex((p) => p.id === id);

test('Wochentag und Festfenster: Freitag bis Sonntag, aus dem Servertag', () => {
  assert.equal(wochentagVon(0), 3, 'Tag 0 der Epoche war ein Donnerstag');
  assert.equal(wochentagVon(FREITAG), 4);
  assert.equal(wochentagVon(MONTAG), 0);
  assert.deepEqual(F.tage, [4, 5, 6]);
  for (let d = 0; d < 7; d++) {
    const tag = MONTAG + d;
    assert.equal(festAktiv(rules, tag), d >= 4, 'Wochentag ' + d);
  }
  assert.equal(festAktiv(rules, 0), false, 'ohne Servertag kein Fest');
  assert.equal(festAktiv(getRuleset(47), FREITAG), false, 'Fassung 47 kennt keine Feste');
});

test('die Feste wechseln reihum mit der Woche, und jedes hat drei feste Zettel', () => {
  const w = wocheVonTag(FREITAG);
  const arten = [0, 1, 2, 3].map((k) => festArtIndex(rules, w + k));
  assert.deepEqual([...new Set(arten)].length, F.arten.length, 'in vier Wochen jedes Fest einmal');
  assert.equal(festArtIndex(rules, w + 4), festArtIndex(rules, w));
  const a = festAufgabenFuer(rules, w, 10).map((x) => x.id);
  assert.deepEqual(a, festAufgabenFuer(rules, w, 10).map((x) => x.id), 'ohne Absprache dieselben Zettel');
  assert.equal(a.length, F.aufgabenProFest);
  assert.ok(a.every((id) => id.startsWith('f-')));
  assert.ok(a.every((id) => F.arten[festArtIndex(rules, w)]!.aufgaben.some((t) => t.id === id)), 'aus dem Topf des laufenden Fests');
  // Auch ein Anfaenger bekommt bei jedem Fest mindestens einen Zettel.
  for (let k = 0; k < F.arten.length; k++) assert.ok(festAufgabenFuer(rules, w + k, 1).length >= 1, F.arten[k]!.id);
});

// Ein erfahrener Hof (hohe Stufe), damit jeder Festtopf voll ziehbar ist.
function hofAm(nowMs: number) {
  const server = new Server({ ...initialState(rules), xp: 100_000 }, nowMs, 48);
  const client = new Client(server.snapshot);
  client.start(0, R_WHEAT);
  assert.equal(server.sync(client.buildSyncRequest(), nowMs).ok, true);
  client.adopt(server.snapshot, DISCARD_QUEUE);
  return { server, client };
}

test('der Server stempelt das Fest an einem Festtag — und sonst nicht', () => {
  const fr = hofAm(T_FR).server.snapshot.state;
  assert.equal(fr.festNummer, wocheVonTag(FREITAG));
  assert.deepEqual(fr.festStart, fr.zaehler, 'Nullpunkt ist der Stand bei Festbeginn');
  assert.deepEqual(fr.festGeholt, []);
  const mo = hofAm(T_MO).server.snapshot.state;
  assert.equal(mo.festNummer, 0, 'am Montag laeuft nichts, also wird nichts gestempelt');
});

// Ein gestempelter Freitagshof, dessen Zaehler so weit stehen, dass jeder
// Festzettel erfuellt ist.
function hofMitErfuelltemFest(): State {
  let s = hofAm(T_FR).server.snapshot.state;
  const liste = festAufgabenFuer(rules, wocheVonTag(FREITAG), levelOf(rules, s.xp));
  const zaehler = s.zaehler.slice();
  // Zwei Zettel koennen dieselbe Art zaehlen — dann zaehlt der groessere.
  for (const a of liste) zaehler[a.art] = Math.max(zaehler[a.art] ?? 0, (s.festStart[a.art] ?? 0) + a.menge);
  s = { ...s, zaehler, items: s.items.map((n, i) => (i === rules.currency ? 1000 : n)) };
  return s;
}

test('Festzettel abholen, dann das Fest: Gold, XP, Festtruhe und die Deko im Paket', () => {
  let s = hofMitErfuelltemFest();
  const liste = festAufgabenFuer(rules, wocheVonTag(FREITAG), levelOf(rules, s.xp));
  const art = F.arten[festArtIndex(rules, wocheVonTag(FREITAG))]!;
  let seq = 10;
  assert.throws(() => simulate(s, { seq, tick: s.tick, type: 'CLAIM_FEST' }, rules), /NOT_YET_EARNED/);
  const goldVor = count(s, rules.currency);
  for (const a of liste) {
    s = simulate(s, { seq: seq++, tick: s.tick, type: 'CLAIM_FEST_TASK', id: a.id }, rules);
    assert.throws(() => simulate(s, { seq, tick: s.tick, type: 'CLAIM_FEST_TASK', id: a.id }, rules), /ALREADY_CLAIMED/);
  }
  const xpVor = s.xp;
  s = simulate(s, { seq: seq++, tick: s.tick, type: 'CLAIM_FEST' }, rules);
  assert.equal(count(s, rules.currency), goldVor + liste.reduce((n, a) => n + a.gold, 0) + F.abschluss.gold);
  assert.equal(s.xp, xpVor + F.abschluss.xp);
  assert.ok(s.festGeholt.includes(FEST_ABSCHLUSS));
  assert.equal(s.festeGeschafft, 1);
  assert.deepEqual(s.pendingBoxes, [F.abschluss.kiste], 'die Festtruhe wartet auf den Wuerfelwurf des Servers');
  assert.ok(s.eingepackt.includes(art.deko!), 'die Fest-Deko liegt eingepackt bereit');
  assert.throws(() => simulate(s, { seq, tick: s.tick, type: 'CLAIM_FEST' }, rules), /ALREADY_CLAIMED/);
});

test('die Fest-Deko gibt es nur vom Fest: nicht kaufbar, aus dem Paket kostenlos aufstellbar', () => {
  let s = hofMitErfuelltemFest();
  const art = F.arten[festArtIndex(rules, wocheVonTag(FREITAG))]!;
  const deko = art.deko!;
  assert.ok(rules.plots[deko]!.nurFest && rules.plots[deko]!.deco);
  assert.throws(() => simulate(s, { seq: 10, tick: s.tick, type: 'BUY', plot: deko }, rules), /FEST_ONLY/);
  // Im Baumenue taucht sie erst auf, wenn sie eingepackt ist.
  assert.equal(farmView(s, rules).buildable.some((b) => b.plot === deko), false);
  s = { ...s, eingepackt: s.eingepackt.concat(deko) };
  const eintrag = farmView(s, rules).buildable.find((b) => b.plot === deko)!;
  assert.ok(eintrag && eintrag.packed && eintrag.cost.length === 0);
  const goldVor = count(s, rules.currency);
  s = simulate(s, { seq: 10, tick: s.tick, type: 'BUY', plot: deko }, rules);
  assert.equal(s.plots[deko]!.level, 1);
  assert.equal(count(s, rules.currency), goldVor, 'aufstellen kostet nichts');
  assert.equal(s.eingepackt.includes(deko), false);
});

test('wer die Deko schon hat, bekommt beim naechsten Mal nur Truhe und Lohn', () => {
  let s = hofMitErfuelltemFest();
  const art = F.arten[festArtIndex(rules, wocheVonTag(FREITAG))]!;
  s = { ...s, eingepackt: s.eingepackt.concat(art.deko!) };
  let seq = 10;
  for (const a of festAufgabenFuer(rules, wocheVonTag(FREITAG), levelOf(rules, s.xp))) {
    s = simulate(s, { seq: seq++, tick: s.tick, type: 'CLAIM_FEST_TASK', id: a.id }, rules);
  }
  s = simulate(s, { seq: seq++, tick: s.tick, type: 'CLAIM_FEST' }, rules);
  assert.equal(s.eingepackt.filter((i) => i === art.deko).length, 1, 'kein zweites Paket');
  assert.equal(s.pendingBoxes.length, 1);
});

test('ausserhalb des Fensters gibt es nichts abzuholen — die Sicht zeigt das naechste Fest', () => {
  let s = hofMitErfuelltemFest();
  // Der Server stempelt am Montag den neuen Tag; das Fest bleibt von letzter Woche.
  s = { ...s, serverTag: MONTAG };
  const liste = festAufgabenFuer(rules, wocheVonTag(FREITAG), levelOf(rules, s.xp));
  assert.throws(() => simulate(s, { seq: 10, tick: s.tick, type: 'CLAIM_FEST_TASK', id: liste[0]!.id }, rules), /NO_FEST/);
  assert.throws(() => simulate(s, { seq: 10, tick: s.tick, type: 'CLAIM_FEST' }, rules), /NO_FEST/);
  const v = farmView(s, rules).feste!;
  assert.equal(v.aktiv, false);
  assert.equal(v.inTagen, 4, 'von Montag bis Freitag');
  assert.equal(v.art, festArtIndex(rules, wocheVonTag(MONTAG)), 'das Fest der neuen Woche');
  assert.deepEqual(v.liste, []);
});

test('die Sicht am Festtag: Zettel mit Stand, Urkunde mit Truhe und Deko, Ende am Sonntag', () => {
  const s = hofAm(T_FR).server.snapshot.state;
  const v = farmView(s, rules).feste!;
  assert.equal(v.aktiv, true);
  assert.equal(v.heute, 4);
  assert.equal(v.bis, 6);
  assert.equal(v.tag, FREITAG);
  assert.equal(v.liste.length, F.aufgabenProFest);
  assert.ok(v.liste.every((e) => e.gruppe === 'fest' && !e.erfuellt && !e.eingeloest));
  assert.ok(v.abschluss && v.abschluss.kiste && v.abschluss.deko !== null && v.abschluss.dekoNeu);
  assert.equal(v.abschluss!.noetig, F.aufgabenProFest);
  assert.equal(v.abschluss!.erfuellt, false);
});

test('Fortschritt zaehlt ab Festbeginn — Server und Geraet sehen dasselbe', () => {
  const { server, client } = hofAm(T_FR);
  const wheat = rules.recipes[R_WHEAT]!;
  let t = 0;
  for (let k = 0; k < 4; k++) {
    client.advanceClock(wheat.durationTicks);
    t += wheat.durationTicks;
    assert.equal(client.collect(0).ok, true);
    assert.equal(client.start(0, R_WHEAT).ok, true);
  }
  assert.equal(server.sync(client.buildSyncRequest(), T_FR + t * 1000).ok, true);
  const st = server.snapshot.state;
  assert.equal(st.zaehler[ZAEHLER.ERNTEN]! - st.festStart[ZAEHLER.ERNTEN]!, 4);
  const v = farmView(st, rules).feste!;
  const ernte = v.liste.find((e) => F.arten[v.art]!.aufgaben.find((a) => a.id === e.id)!.art === ZAEHLER.ERNTEN);
  if (ernte) assert.equal(ernte.ist, 4);
});

test('Erfolge zaehlen gefeierte Feste', () => {
  let s = hofMitErfuelltemFest();
  let seq = 10;
  for (const a of festAufgabenFuer(rules, wocheVonTag(FREITAG), levelOf(rules, s.xp))) {
    s = simulate(s, { seq: seq++, tick: s.tick, type: 'CLAIM_FEST_TASK', id: a.id }, rules);
  }
  s = simulate(s, { seq: seq++, tick: s.tick, type: 'CLAIM_FEST' }, rules);
  const fest1 = farmView(s, rules).erfolge.find((e) => e.id === 'fest1')!;
  assert.ok(fest1.erfuellt && !fest1.eingeloest);
});

test('Fassung 47 bleibt ohne Fest, und der Umzug nach 48 faengt leer an', () => {
  const alt = getRuleset(47);
  const s = new Server(initialState(alt), T_FR, 47).snapshot.state;
  assert.equal(farmView(s, alt).feste, null);
  const neu = migrateState(s, 47, 48);
  assert.equal(neu.festNummer, 0);
  assert.deepEqual(neu.festGeholt, []);
  assert.equal(neu.plots.length, rules.plots.length);
});

test('alle Produktionsfassungen bleiben in sich stimmig', () => {
  for (const v of PRODUCTION_VERSIONS) {
    const r = getRuleset(v);
    for (const a of r.feste?.arten ?? []) {
      assert.ok(a.deko === undefined || r.plots[a.deko]?.nurFest, `${v}: ${a.id} zeigt auf keine Fest-Deko`);
    }
  }
});
