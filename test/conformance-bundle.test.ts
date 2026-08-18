import test from 'node:test';
import assert from 'node:assert/strict';
import { RULESETS } from '../src/sim/rules.ts';
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

  assert.deepEqual(
    [...report.rulesetVersions].sort((a, b) => a - b),
    [...RULESETS.keys()].sort((a, b) => a - b),
    'Bundle deckt nicht alle Kataloge ab',
  );

  const failures = report.results.filter((r) => !r.pass);
  const detail = failures
    .map((f) => `  ${f.name}: ${f.error ?? `\n    ist  ${f.actual}\n    soll ${f.expected}`}`)
    .join('\n');
  assert.equal(failures.length, 0, `Bundle weicht vom Sim-Kern ab:\n${detail}`);
  assert.equal(report.passed, report.total);
});

test('der Bundle braucht keine Plattform-APIs', () => {
  const source = buildConformanceBundle();

  for (const forbidden of ['node:crypto', 'require(', 'process.', 'Buffer']) {
    assert.ok(!source.includes(forbidden), `Bundle enthält ${forbidden}`);
  }

  assert.ok(!/^import\b/m.test(source), 'Bundle enthält noch import-Anweisungen');
  assert.ok(!/^export\b/m.test(source), 'Bundle enthält noch export-Anweisungen');
});

test('der Bundle ist reproduzierbar', () => {
  assert.equal(buildConformanceBundle(), buildConformanceBundle());
});
