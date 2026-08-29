import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset, levelOf, nextLevelAt, levelStartedAt } from '../src/sim/rules.ts';

const V = getRuleset(23);

test('es gibt keine harte Höchststufe mehr', () => {
  const t = V.levelThresholds;
  const last = t[t.length - 1]!;
  const step = last - t[t.length - 2]!;

  const beiLetzter = levelOf(V, last);
  assert.equal(beiLetzter, t.length + 1, 'an der letzten Schwelle steht man auf Stufe length+1');

  // eine Lücke weiter = eine Stufe höher
  assert.equal(levelOf(V, last + step), beiLetzter + 1);
  assert.equal(levelOf(V, last + step * 5), beiLetzter + 5);

  // die 13. Stufe ist jetzt erreichbar
  assert.ok(levelOf(V, last + step * 3) >= 13);

  // die nächste Grenze läuft weiter, statt null zu werden
  assert.equal(nextLevelAt(V, last), last + step);
  assert.equal(nextLevelAt(V, last + step), last + step * 2);

  // der Stufenanfang passt zur laufenden Stufe
  assert.equal(levelStartedAt(V, last + step + 5), last + step);
  assert.ok(levelStartedAt(V, last + 5) <= last + 5);
});

test('unterhalb der Schwellen bleibt alles wie gehabt', () => {
  assert.equal(levelOf(V, 0), 1);
  assert.equal(levelOf(V, V.levelThresholds[0]! - 1), 1);
  assert.equal(levelOf(V, V.levelThresholds[0]!), 2);
});
