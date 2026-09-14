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
  assert.equal(server.snapshot.state.zeitVersatz, vorher, 'nie wieder angefasst');
});
