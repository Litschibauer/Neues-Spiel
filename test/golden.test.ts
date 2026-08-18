import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RULESETS, getRuleset } from '../src/sim/rules.ts';
import { simulateAll } from '../src/sim/sim.ts';
import { hashState } from '../src/sim/hash.ts';
import type { State } from '../src/sim/state.ts';
import type { Command } from '../src/sim/commands.ts';

type Vector = {
  name: string;
  rulesetVersion: number;
  startState: State;
  commands: Command[];
  expectedStateHash: string;
  expectedState: State;
};

type GoldenDoc = {
  rulesetVersions: number[];
  vectorCount: number;
  vectors: Vector[];
};

const golden = JSON.parse(
  readFileSync(join(import.meta.dirname, 'vectors', 'golden.json'), 'utf8'),
) as GoldenDoc;

test('der Korpus ist substanziell — sonst beweist er nichts', () => {
  assert.equal(golden.vectors.length, golden.vectorCount);
  assert.ok(golden.vectors.length >= 20, `zu wenige Vektoren: ${golden.vectors.length}`);

  const commands = golden.vectors.reduce((n, v) => n + v.commands.length, 0);
  assert.ok(commands >= 100, `zu wenige Commands im Korpus: ${commands}`);

  const types = new Set(golden.vectors.flatMap((v) => v.commands.map((c) => c.type)));
  assert.deepEqual(
    [...types].sort(),
    [
      'BUY',
      'BUY_NPC',
      'BUY_OFFER',
      'CANCEL_ORDER',
      'COLLECT',
      'COLLECT_MAIL',
      'FILL_REQUEST',
      'LIST_ORDER',
      'LOAD_TRUCK',
      'SELL_NPC',
      'SEND_SLIP',
      'SEND_TRUCK',
      'SKIP_REQUEST',
      'START',
    ],
    'Korpus deckt nicht alle Command-Typen ab',
  );

  const versions = [...new Set(golden.vectors.map((v) => v.rulesetVersion))];
  assert.deepEqual(
    versions.sort((a, b) => a - b),
    [...RULESETS.keys()].sort((a, b) => a - b),
  );

  const withInputs = golden.vectors.some((v) =>
    v.commands.some((c) => {
      if (c.type !== 'START') return false;
      return getRuleset(v.rulesetVersion).recipes[c.recipe]!.inputs.length > 0;
    }),
  );
  assert.ok(withInputs, 'kein Vektor benutzt ein Rezept mit Eingaben');

  for (const version of RULESETS.keys()) {
    assert.ok(
      golden.vectors.some((v) => v.name === `core-loop-v${version}`),
      `Kernkreislauf-Vektor für v${version} fehlt`,
    );
  }
});

test('jeder Golden Vector reproduziert exakt seinen erwarteten Endzustand', () => {
  for (const v of golden.vectors) {
    const rules = getRuleset(v.rulesetVersion);
    const final = simulateAll(v.startState, v.commands, rules);

    assert.deepEqual(final, v.expectedState, `Vektor ${v.name}: Zustand weicht ab`);

    assert.equal(hashState(final), v.expectedStateHash, `Vektor ${v.name}: Hash weicht ab`);
  }
});

test('Vektoren sind selbsttragend: keine Seeds, nur explizite Commands', () => {
  for (const v of golden.vectors) {
    assert.ok(Array.isArray(v.commands) && v.commands.length > 0, `${v.name}: keine Commands`);
    for (const c of v.commands) {
      assert.ok(Number.isInteger(c.seq), `${v.name}: seq fehlt`);
      assert.ok(Number.isInteger(c.tick), `${v.name}: tick fehlt`);
      assert.ok(typeof c.type === 'string', `${v.name}: type fehlt`);
    }
  }
  const raw = readFileSync(join(import.meta.dirname, 'vectors', 'golden.json'), 'utf8');
  assert.ok(!/"seed"/.test(raw), 'Korpus enthält Seeds statt expliziter Commands');
});
