/**
 * Verteidigungslinie 3 gegen R1: Golden Vectors.
 *
 * Das Kernproblem beim Plattform-Determinismus ist, dass man iOS, Android und
 * Server nicht in einem Prozess vergleichen kann. Golden Vectors lösen das wie
 * Testvektoren in der Kryptografie: ein festgeschriebener Korpus aus Eingaben
 * mit erwarteten Ergebnissen, den jede Implementierung abspielen muss.
 *
 * Damit ist der Plattform-Beweis vorbereitet, ohne dass hier ein Handy stehen
 * muss — der Mobile-Port führt an Tag eins denselben Korpus aus.
 *
 * In dieser Node-Runtime prüft der Test zusätzlich, dass der Sim-Kern über die
 * Zeit stabil bleibt: Wandert ein Hash, ohne dass jemand die Regeln bewusst
 * geändert hat, ist genau das der Determinismus-Bug, den wir suchen.
 */

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
  /**
   * Der vollständige Ausgangszustand.
   *
   * Steht bewusst ausgeschrieben in der Datei, statt aus Parametern
   * rekonstruiert zu werden: Ein Vektor muss seine Eingabe komplett
   * mitbringen, sonst prüft eine fremde Plattform am Ende die
   * Rekonstruktionslogik mit statt nur den Sim-Kern.
   */
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

  // Jeder Command-Typ muss vorkommen, sonst bleiben Regeln ungeprüft — und der
  // Mobile-Port hätte für sie keinen Abgleich.
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
      'SELL_NPC',
      'START',
    ],
    'Korpus deckt nicht alle Command-Typen ab',
  );

  // Und jede ausgelieferte Regelversion muss vorkommen. Sonst bliebe ein
  // ganzer Katalog — samt seiner Rezepte und Plätze — ohne Plattform-Beweis.
  const versions = [...new Set(golden.vectors.map((v) => v.rulesetVersion))];
  assert.deepEqual(
    versions.sort((a, b) => a - b),
    [...RULESETS.keys()].sort((a, b) => a - b),
  );

  // Der Kernkreislauf muss wirklich durchlaufen sein: Rezepte MIT Eingaben
  // (Mühle, Gehege) sind der Pfad, an dem sich datengetriebener Inhalt beweist.
  const withInputs = golden.vectors.some((v) =>
    v.commands.some((c) => {
      if (c.type !== 'START') return false;
      return getRuleset(v.rulesetVersion).recipes[c.recipe]!.inputs.length > 0;
    }),
  );
  assert.ok(withInputs, 'kein Vektor benutzt ein Rezept mit Eingaben');

  // Der handgeschriebene Kernkreislauf muss dabei sein: Er ist der einzige
  // Vektor, dem man ansieht, WAS er prüft.
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

    // Erst der volle Zustand — der zeigt bei einem Fehlschlag, WAS abweicht.
    assert.deepEqual(final, v.expectedState, `Vektor ${v.name}: Zustand weicht ab`);
    // Dann der Hash — das ist der Wert, den fremde Plattformen vergleichen.
    assert.equal(hashState(final), v.expectedStateHash, `Vektor ${v.name}: Hash weicht ab`);
  }
});

test('Vektoren sind selbsttragend: keine Seeds, nur explizite Commands', () => {
  // Ein Seed würde voraussetzen, dass fremde Plattformen denselben PRNG haben —
  // also genau die Annahme, die der Korpus eigentlich prüfen soll.
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
