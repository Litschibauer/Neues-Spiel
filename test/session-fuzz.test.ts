import test from 'node:test';
import assert from 'node:assert/strict';
import { Server } from '../src/server/server.ts';
import { RULESETS, getRuleset } from '../src/sim/rules.ts';
import { cloneState, stored } from '../src/sim/state.ts';
import { hashState } from '../src/sim/hash.ts';
import type { SessionOptions } from './helpers/session.ts';
import {
  assertAllIntegers,
  fuzzStart,
  mulberry32,
  playRandomSession,
  referenceRun,
  referenceStepMatchesUnit,
} from './helpers/session.ts';

const T0 = 1_700_000_000_000;

const VERSIONS = [...RULESETS.keys()].sort((a, b) => a - b);

const BUSY: SessionOptions = {
  steps: 40,
  maxAdvance: 4000,
  advanceChance: 0.3,
  chaosChance: 0.25,
};

const IDLE: SessionOptions = {
  steps: 20,
  maxAdvance: 20_000,
  advanceChance: 0.6,
  chaosChance: 0.1,
};

const HOARD: SessionOptions = {
  steps: 120,
  maxAdvance: 1500,
  advanceChance: 0.45,
  chaosChance: 0.05,
  hoard: true,
};

type Stats = {
  sessions: number;
  commands: number;
  rejections: number;
  siloFull: number;
  maxStored: number;
  perVersion: Map<number, number>;
};

function runProfile(profile: SessionOptions, sessions: number): Stats {
  const stats: Stats = {
    sessions: 0,
    commands: 0,
    rejections: 0,
    siloFull: 0,
    maxStored: 0,
    perVersion: new Map(),
  };

  for (let seed = 1; seed <= sessions; seed++) {
    const rnd = mulberry32(seed);
    const version = VERSIONS[seed % VERSIONS.length]!;
    const rules = getRuleset(version);

    const server = new Server(
      fuzzStart(rules, seed % 2 === 0 ? 4000 : 0, mulberry32(seed * 31)),
      T0,
      version,
    );
    const start = cloneState(server.snapshot.state);
    const client = playRandomSession(server.snapshot, rnd, profile);

    if (client.queue.length === 0) continue;

    stats.sessions++;
    stats.commands += client.queue.length;
    stats.rejections += profile.steps - client.queue.length;
    stats.perVersion.set(version, (stats.perVersion.get(version) ?? 0) + client.queue.length);

    const reference = referenceRun(start, client.queue, rules);
    assert.deepEqual(
      client.state,
      reference,
      `seed=${seed} v${version}: Client weicht von der Grundwahrheit ab`,
    );

    assertAllIntegers(client.state);

    const res = server.sync(client.buildSyncRequest(), T0 + client.localTick * 1000);
    assert.equal(res.ok, true, `seed=${seed} v${version}: Server lehnt legalen Log ab`);
    if (!res.ok) return stats;
    assert.equal(res.divergence, false, `seed=${seed} v${version}: Kanarienvogel schlägt an`);
    assert.equal(hashState(reference), hashState(client.state));

    let peak = 0;
    let s = cloneState(start);
    for (const cmd of client.queue) {
      s = referenceRun(s, [cmd], rules);
      peak = Math.max(peak, stored(s, rules));
    }
    stats.maxStored = Math.max(stats.maxStored, peak);
    if (peak >= rules.siloCapacity) stats.siloFull++;
  }

  return stats;
}

test('die ausgeschriebene Referenz-Schleife stimmt mit der Einzelfunktion überein', () => {
  assert.ok(referenceStepMatchesUnit());
});

test('Profil „busy": jede Version mehrfach — Client == Referenz == Server', () => {
  const laeufe = VERSIONS.length * 20;
  const s = runProfile(BUSY, laeufe);

  assert.ok(s.sessions > laeufe * 0.9, `zu wenige Sitzungen mit Commands: ${s.sessions}`);
  assert.ok(s.commands > laeufe * 10, `zu wenige Commands: ${s.commands}`);

  assert.ok(s.rejections > laeufe * 2.5, `zu wenige abgelehnte Aktionen: ${s.rejections}`);

  for (const v of VERSIONS) {
    assert.ok(
      (s.perVersion.get(v) ?? 0) > 150,
      `v${v} zu selten gefuzzt: ${s.perVersion.get(v)}`,
    );
  }
});

test('Profil „idle": jede Version mehrfach mit langen Offline-Sprüngen', () => {
  const laeufe = Math.max(150, VERSIONS.length * 10);
  const s = runProfile(IDLE, laeufe);
  assert.ok(s.sessions > laeufe * 0.8, `zu wenige Sitzungen mit Commands: ${s.sessions}`);
});

test('Profil „hoard": jede Version mehrfach — läuft bis ans Lagerlimit', () => {
  const laeufe = Math.max(150, VERSIONS.length * 10);
  const s = runProfile(HOARD, laeufe);

  assert.ok(s.sessions > laeufe * 0.8, `zu wenige Sitzungen mit Commands: ${s.sessions}`);

  assert.ok(s.siloFull >= 6, `Lager zu selten voll: ${s.siloFull} (max ${s.maxStored})`);
});
