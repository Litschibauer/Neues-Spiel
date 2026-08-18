import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../src/sim/sha256.ts';
import { canonicalize } from '../src/sim/canonical.ts';
import { initialState } from '../src/sim/state.ts';
import { getRuleset, CURRENT_RULESET_VERSION } from '../src/sim/rules.ts';
import { simulateAll } from '../src/sim/sim.ts';
import { mulberry32, playRandomSession } from './helpers/session.ts';

const reference = (s: string) => createHash('sha256').update(s).digest('hex');

test('bekannte Testvektoren', () => {
  assert.equal(
    sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('stimmt mit node:crypto überein — Längen rund um die Blockgrenzen', () => {
  for (let len = 0; len <= 200; len++) {
    const input = 'a'.repeat(len);
    assert.equal(sha256Hex(input), reference(input), `Länge ${len}`);
  }
});

test('stimmt mit node:crypto überein — Zufallseingaben inkl. Mehrbyte-Zeichen', () => {
  const rnd = mulberry32(0x5eed);
  const alphabet = 'abcXYZ0189|=[],:-_äöüß€🌾';

  for (let i = 0; i < 2000; i++) {
    const length = Math.floor(rnd() * 300);
    let input = '';
    for (let j = 0; j < length; j++) {
      input += alphabet[Math.floor(rnd() * alphabet.length)];
    }
    assert.equal(sha256Hex(input), reference(input), `Eingabe: ${JSON.stringify(input)}`);
  }
});

test('stimmt mit node:crypto überein — echte kanonische Spielzustände', () => {
  const rules = getRuleset(CURRENT_RULESET_VERSION);

  for (let seed = 1; seed <= 60; seed++) {
    const rnd = mulberry32(seed);
    const snapshot = {
      state: initialState(rules),
      seq: 0,
      serverTs: 0,
      rulesetVersion: CURRENT_RULESET_VERSION,
    };
    const client = playRandomSession(snapshot, rnd, {
      steps: 25,
      maxAdvance: 9000,
      advanceChance: 0.4,
      chaosChance: 0.15,
    });

    const canonical = canonicalize(simulateAll(initialState(rules), client.queue, rules));
    assert.equal(sha256Hex(canonical), reference(canonical), `seed=${seed}`);
  }
});
