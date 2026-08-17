/**
 * Der Konformitäts-Bundle muss dem Sim-Kern treu bleiben.
 *
 * Der Bundle ist das Werkzeug für den Plattform-Beweis: Er läuft in Safari auf
 * iPhone und iPad und damit in JavaScriptCore statt V8. Aber ein Beweis ist er
 * nur, wenn er wirklich denselben Code ausführt wie Client und Server.
 *
 * Deshalb wird er hier aus den Quellen frisch gebaut, in einem isolierten
 * Kontext ausgeführt und muss dieselben Golden Vectors bestehen. Schlägt das
 * fehl, hat das Bündeln etwas verbogen — und ein grünes Ergebnis auf dem iPad
 * wäre wertlos.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildConformanceBundle } from '../scripts/build-conformance.ts';

type VectorResult = {
  name: string;
  pass: boolean;
  error: string | null;
  actual: string;
  expected: string;
};
type Report = {
  rulesetVersions: number[];
  total: number;
  passed: number;
  results: VectorResult[];
};

function runBundle(): Report {
  const context: Record<string, unknown> = { console };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(buildConformanceBundle(), context);

  const api = context.NeuesSpielConformance as { runVectors: () => Report } | undefined;
  assert.ok(api, 'Bundle stellt keine API bereit');
  return api.runVectors();
}

test('der Bundle lässt sich bauen und besteht alle Golden Vectors', () => {
  const report = runBundle();

  assert.ok(report.total >= 100, `zu wenige Vektoren im Bundle: ${report.total}`);
  // Umkopieren: Arrays aus dem VM-Kontext haben einen fremden Prototyp.
  assert.deepEqual([...report.rulesetVersions], [1, 2, 3, 4], 'Bundle deckt nicht alle Kataloge ab');

  const failures = report.results.filter((r) => !r.pass);
  const detail = failures
    .map((f) => `  ${f.name}: ${f.error ?? `\n    ist  ${f.actual}\n    soll ${f.expected}`}`)
    .join('\n');
  assert.equal(failures.length, 0, `Bundle weicht vom Sim-Kern ab:\n${detail}`);
  assert.equal(report.passed, report.total);
});

test('der Bundle braucht keine Plattform-APIs', () => {
  const source = buildConformanceBundle();

  // Würde eine davon hineinrutschen, liefe der Bundle im Browser nicht — oder,
  // schlimmer, er liefe mit plattformabhängigem Verhalten.
  for (const forbidden of ['node:crypto', 'require(', 'process.', 'Buffer']) {
    assert.ok(!source.includes(forbidden), `Bundle enthält ${forbidden}`);
  }
  // Und keine übrig gebliebenen Modul-Schlüsselwörter, die im Browser brechen.
  assert.ok(!/^import\b/m.test(source), 'Bundle enthält noch import-Anweisungen');
  assert.ok(!/^export\b/m.test(source), 'Bundle enthält noch export-Anweisungen');
});

test('der Bundle ist reproduzierbar', () => {
  // Zwei Läufe müssen byteweise dasselbe ergeben, sonst ist unklar, welche
  // Fassung auf dem Testgerät lag.
  assert.equal(buildConformanceBundle(), buildConformanceBundle());
});
