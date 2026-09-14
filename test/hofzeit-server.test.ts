import test from 'node:test';
import assert from 'node:assert/strict';
import { Server } from '../src/server/server.ts';
import { getRuleset, LATEST_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState, unixVon } from '../src/sim/state.ts';
import { hofzeit, HOFZEIT_EPOCHE, HOFTAG_S, HOFSTUNDE_S } from '../src/sim/zeit.ts';

// Der Server stempelt den Versatz zur echten Uhr genau einmal. Danach ist
// tick + zeitVersatz die Unix-Sekunde des Standes — für jeden Hof dieselbe
// Uhr, auch wenn jeder Tick bei null anfängt.
test('der Server stempelt den Zeitversatz einmal, und danach stimmt die Hofzeit', () => {
  const rules = getRuleset(LATEST_RULESET_VERSION);
  const startMs = (HOFZEIT_EPOCHE + 5 * HOFTAG_S + 7 * HOFSTUNDE_S + 75) * 1000; // Tag 6, 7:30 Hofzeit
  const server = new Server(initialState(rules), startMs, LATEST_RULESET_VERSION);
  assert.equal(server.snapshot.state.zeitVersatz, 0, 'frisch: noch nicht gestempelt');
  server.receiveExternal(startMs + 1000);
  const s = server.snapshot.state;
  assert.ok(s.zeitVersatz > 0, 'gestempelt');
  assert.equal(unixVon(s), Math.floor(startMs / 1000) + s.tick, 'Unix-Sekunde = Tick + Versatz');
  const z = hofzeit(unixVon(s)!);
  assert.equal(z.tag, 6);
  assert.equal(z.stunde, 7);
  assert.equal(z.minute, 30);
  const vorher = s.zeitVersatz;
  server.receiveExternal(startMs + 3_600_000);
  assert.equal(server.snapshot.state.zeitVersatz, vorher, 'ohne Anlass nie wieder angefasst');
});

// Die Werkbank schenkt Zeit, indem sie serverTs zurückrückt: Der Tick springt
// beim nächsten Abgleich voraus. Die Hofzeit darf das nicht mitmachen — sie
// ist die Uhr aller Höfe. Also stempelt der Server den Versatz neu, und
// tick + zeitVersatz bleibt die echte Unix-Sekunde.
test('geschenkte Zeit aus der Werkbank verschiebt die Hofzeit nicht', () => {
  const rules = getRuleset(LATEST_RULESET_VERSION);
  const startMs = (HOFZEIT_EPOCHE + 5 * HOFTAG_S + 7 * HOFSTUNDE_S + 75) * 1000; // Tag 6, 7:30 Hofzeit
  const server = new Server(initialState(rules), startMs, LATEST_RULESET_VERSION);
  server.receiveExternal(startMs + 1000);
  const vorher = server.snapshot.state.zeitVersatz;
  server.grantTime(6 * 3600); // sechs Stunden — sechs Hoftage, liefen sie mit
  server.receiveExternal(startMs + 2000);
  const s = server.snapshot.state;
  assert.equal(s.zeitVersatz, vorher - 6 * 3600, 'neu gestempelt um die geschenkte Zeit');
  // Der Abgleich verbraucht die geschenkte Zeit: Der Tick springt sechs
  // Stunden voraus, die Hofzeit bleibt bei der echten Uhr.
  const res = server.sync({ baseSeq: server.snapshot.seq, rulesetVersion: LATEST_RULESET_VERSION, commands: [] }, startMs + 3000);
  const nach = res.snapshot.state;
  // Der Tick des Snapshots wächst erst mit Befehlen; was der Client als
  // „jetzt" sieht, ist Snapshot-Tick plus die seit serverTs verstrichene Zeit
  // — und die ist um die geschenkten sechs Stunden größer.
  const tickJetzt = nach.tick + Math.floor((startMs + 3000 - res.snapshot.serverTs) / 1000);
  assert.ok(tickJetzt >= 6 * 3600, `die Uhr des Hofs sprang voraus: ${tickJetzt}`);
  assert.equal(tickJetzt + nach.zeitVersatz, Math.floor((startMs + 3000) / 1000), 'tick + Versatz = echte Uhr, trotz Geschenk');
  const z = hofzeit(tickJetzt + nach.zeitVersatz);
  assert.equal(z.tag, 6, 'immer noch Tag 6 …');
  assert.equal(z.stunde, 7, '… um 7 Uhr Hofzeit');
});
