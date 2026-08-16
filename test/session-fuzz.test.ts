/**
 * Session-Fuzz (Risiko R1) — Verteidigungslinie 2.
 *
 * `produce.test.ts` prüft eine Funktion. Hier läuft dasselbe Prinzip über
 * ganze Sitzungen: hunderte zufällige Command-Folgen, jede über drei
 * unabhängige Wege gerechnet, alle drei müssen exakt übereinstimmen.
 *
 * Der Unterschied ist wichtig. Der Off-by-one in der Produktion war ein
 * Funktionsbug. Fehler in der *Segmentierung* — falsche Reihenfolge, verpasste
 * Grenze, Zustand zwischen zwei Commands nicht fortgeschrieben — entstehen erst
 * auf Sitzungsebene und wären hier hängen geblieben.
 *
 * Zwei Profile, weil ein einzelnes nicht beides trifft:
 *   „busy" = viele Aktionen, kurze Sprünge  → belastet die Segmentierung
 *   „idle" = wenige Aktionen, lange Sprünge → belastet Lagerlimit und Stall
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Server } from '../src/server/server.ts';
import { CURRENT_RULESET_VERSION, getRuleset } from '../src/sim/rules.ts';
import { initialState, cloneState, stored } from '../src/sim/state.ts';
import { hashState } from '../src/sim/hash.ts';
import type { SessionOptions } from './helpers/session.ts';
import {
  assertAllIntegers,
  mulberry32,
  playRandomSession,
  referenceRun,
  referenceStepMatchesUnit,
} from './helpers/session.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);

const BUSY: Omit<SessionOptions, 'fieldCount'> = {
  steps: 40,
  maxAdvance: 4000,
  advanceChance: 0.3,
  chaosChance: 0.25,
};

const IDLE: Omit<SessionOptions, 'fieldCount'> = {
  steps: 20,
  maxAdvance: 20_000,
  advanceChance: 0.6,
  chaosChance: 0.1,
};

type Stats = {
  sessions: number;
  commands: number;
  rejections: number;
  siloFull: number;
  maxStored: number;
};

function runProfile(profile: Omit<SessionOptions, 'fieldCount'>, sessions: number): Stats {
  const stats: Stats = { sessions: 0, commands: 0, rejections: 0, siloFull: 0, maxStored: 0 };

  for (let seed = 1; seed <= sessions; seed++) {
    const rnd = mulberry32(seed);
    const fieldCount = 1 + Math.floor(rnd() * 8);

    const server = new Server(initialState(fieldCount), T0, CURRENT_RULESET_VERSION);
    const start = cloneState(server.snapshot.state);
    const client = playRandomSession(server.snapshot, rnd, { ...profile, fieldCount });

    if (client.queue.length === 0) continue;

    stats.sessions++;
    stats.commands += client.queue.length;
    stats.rejections += profile.steps - client.queue.length;

    // ── Weg 1 vs. Weg 3: geschlossene Form gegen Tick-für-Tick-Grundwahrheit ──
    const reference = referenceRun(start, client.queue);
    assert.deepEqual(
      client.state,
      reference,
      `seed=${seed}: Client weicht von der Grundwahrheit ab`,
    );

    // Kein Float hat sich eingeschlichen (§2.2).
    assertAllIntegers(client.state);

    // ── Weg 2: Server-Re-Simulation aus dem Log ──
    const res = server.sync(client.buildSyncRequest(), T0 + client.localTick * 1000);
    assert.equal(res.ok, true, `seed=${seed}: Server lehnt legalen Log ab`);
    if (!res.ok) return stats;
    assert.equal(res.divergence, false, `seed=${seed}: Kanarienvogel schlägt an`);
    assert.equal(hashState(reference), hashState(client.state));

    // Peak über die ganze Sitzung, nicht nur am Ende.
    let peak = 0;
    let s = cloneState(start);
    for (const cmd of client.queue) {
      s = referenceRun(s, [cmd]);
      peak = Math.max(peak, stored(s));
    }
    stats.maxStored = Math.max(stats.maxStored, peak);
    if (peak >= rules.siloCapacity) stats.siloFull++;
  }

  return stats;
}

test('die ausgeschriebene Referenz-Schleife stimmt mit der Einzelfunktion überein', () => {
  assert.ok(referenceStepMatchesUnit());
});

test('Profil „busy": 200 Sitzungen — Client == Referenz == Server', () => {
  const s = runProfile(BUSY, 200);

  assert.ok(s.sessions > 180, `zu wenige Sitzungen mit Commands: ${s.sessions}`);
  assert.ok(s.commands > 2000, `zu wenige Commands: ${s.commands}`);
  // Der Ablehnpfad muss mitlaufen, sonst testet der Fuzz nur den Sonnenschein.
  assert.ok(s.rejections > 500, `zu wenige abgelehnte Aktionen: ${s.rejections}`);
});

test('Profil „idle": 150 Sitzungen — läuft bis ans Lagerlimit', () => {
  const s = runProfile(IDLE, 150);

  assert.ok(s.sessions > 130, `zu wenige Sitzungen mit Commands: ${s.sessions}`);
  // Entscheidend: Der Fuzz muss den vollen Stall wirklich erreichen, sonst
  // beweist er über die kritische Ecke aus §7 genau nichts.
  assert.ok(s.siloFull > 10, `Lager zu selten voll: ${s.siloFull} (max ${s.maxStored})`);
});
