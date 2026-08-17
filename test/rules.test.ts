/**
 * Der Katalog ist jetzt der Inhalt des Spiels — und Daten haben keinen Compiler.
 *
 * Solange Weizen und Eier fest im Code standen, konnte ein Rezept gar nicht auf
 * etwas zeigen, das es nicht gibt. Seit Inhalt eine Tabelle ist, kann es das
 * sehr wohl — und der Fehler fiele erst bei einem Spieler auf, offline, ohne
 * Netz für einen Hotfix.
 *
 * Zwei Eigenschaften werden hier geprüft, und die zweite ist die teurere:
 *
 *  1. Jedes ausgelieferte Regelwerk ist in sich widerspruchsfrei.
 *  2. **Kataloge sind append-only.** Zustände speichern Indizes. Wer einen
 *     Eintrag einschiebt oder entfernt, verschiebt die Bedeutung aller
 *     gespeicherten Spielstände — aus Weizen wird stillschweigend Mehl.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_RULESET_VERSION,
  FIELD_TEST_RULESET_VERSION,
  LATEST_RULESET_VERSION,
  RULESETS,
  getRuleset,
  isTradable,
  passiveInterval,
  validateRuleset,
} from '../src/sim/rules.ts';
import { MIGRATIONS } from '../src/sim/migrate.ts';

const VERSIONS = [...RULESETS.keys()].sort((a, b) => a - b);

test('jedes ausgelieferte Regelwerk ist widerspruchsfrei', () => {
  for (const version of VERSIONS) {
    const problems = validateRuleset(getRuleset(version));
    assert.deepEqual(problems, [], `v${version}: ${problems.join('; ')}`);
  }
});

test('die Prüfung hat Zähne — sie findet die Fehler, die man wirklich macht', () => {
  const base = getRuleset(1);

  // Rezept zeigt auf einen Gegenstand, den es nicht gibt.
  const danglingOutput = {
    ...base,
    recipes: [{ id: 'ghost', inputs: [], output: { item: 99, amount: 1 }, durationTicks: 10 }],
    plots: [{ id: 'field', recipes: [0] }],
    passives: [],
  };
  assert.ok(validateRuleset(danglingOutput).length > 0, 'unbekannte Ausgabe nicht erkannt');

  // Platz erlaubt ein Rezept, das es nicht gibt.
  const danglingRecipe = { ...base, plots: [{ id: 'field', recipes: [42] }] };
  assert.ok(validateRuleset(danglingRecipe).length > 0, 'unbekanntes Rezept nicht erkannt');

  // Passive mit Eingaben — die geschlossene Form trägt das nicht (produce.ts).
  const hungryPassive = {
    ...base,
    recipes: [
      ...base.recipes,
      {
        id: 'cow',
        inputs: [{ item: 1, amount: 1 }],
        output: { item: 2, amount: 1 },
        durationTicks: 100,
      },
    ],
    passives: [{ id: 'pasture', recipe: 2 }],
  };
  assert.ok(validateRuleset(hungryPassive).length > 0, 'gefütterte Passive nicht erkannt');

  // Passive mit Ausgabemenge > 1 — dito.
  const batchPassive = {
    ...base,
    recipes: [
      ...base.recipes,
      { id: 'batch', inputs: [], output: { item: 2, amount: 5 }, durationTicks: 100 },
    ],
    passives: [{ id: 'coop', recipe: 2 }],
  };
  assert.ok(validateRuleset(batchPassive).length > 0, 'Stapel-Passive nicht erkannt');

  // Währung, die Lagerplatz kostet.
  const heavyMoney = {
    ...base,
    items: base.items.map((i, idx) => (idx === 0 ? { ...i, storable: true } : i)),
  };
  assert.ok(validateRuleset(heavyMoney).length > 0, 'lagerpflichtige Währung nicht erkannt');
});

test('Kataloge wachsen nur hinten — sonst verschiebt sich die Bedeutung aller Indizes', () => {
  for (let i = 1; i < VERSIONS.length; i++) {
    const from = getRuleset(VERSIONS[i - 1]!);
    const to = getRuleset(VERSIONS[i]!);
    const label = `v${from.version} → v${to.version}`;

    assert.ok(to.items.length >= from.items.length, `${label}: Gegenstände verschwunden`);
    assert.ok(to.recipes.length >= from.recipes.length, `${label}: Rezepte verschwunden`);
    assert.ok(to.plots.length >= from.plots.length, `${label}: Plätze verschwunden`);
    assert.ok(to.passives.length >= from.passives.length, `${label}: Passive verschwunden`);

    // Und das Präfix muss dasselbe MEINEN. Preise und Zeiten dürfen sich
    // ändern (das ist ein Balance-Patch), die Identität nicht.
    from.items.forEach((item, index) => {
      assert.equal(to.items[index]!.id, item.id, `${label}: Gegenstand ${index} umgedeutet`);
      assert.equal(
        to.items[index]!.storable,
        item.storable,
        `${label}: Lagerpflicht von ${item.id} gedreht`,
      );
    });
    from.recipes.forEach((recipe, index) => {
      assert.equal(to.recipes[index]!.id, recipe.id, `${label}: Rezept ${index} umgedeutet`);
      assert.equal(
        to.recipes[index]!.output.item,
        recipe.output.item,
        `${label}: Rezept ${recipe.id} gibt plötzlich etwas anderes aus`,
      );
    });
    from.plots.forEach((plot, index) => {
      assert.deepEqual(
        [...to.plots[index]!.recipes],
        [...plot.recipes],
        `${label}: Platz ${index} nimmt plötzlich andere Rezepte`,
      );
    });
    from.passives.forEach((passive, index) => {
      assert.equal(
        to.passives[index]!.recipe,
        passive.recipe,
        `${label}: Passive ${index} produziert plötzlich etwas anderes`,
      );
    });

    assert.equal(from.currency, to.currency, `${label}: Währung verschoben`);
  }
});

test('für jeden Versionssprung gibt es eine Migration', () => {
  for (let i = 1; i < VERSIONS.length; i++) {
    const key = `${VERSIONS[i - 1]}->${VERSIONS[i]}`;
    assert.ok(MIGRATIONS.has(key), `Migration ${key} fehlt`);
  }
});

test('die benannten Versionen zeigen auf Regelwerke, die es gibt', () => {
  for (const v of [CURRENT_RULESET_VERSION, LATEST_RULESET_VERSION, FIELD_TEST_RULESET_VERSION]) {
    assert.ok(RULESETS.has(v), `Version ${v} fehlt im Katalog`);
  }
  assert.ok(LATEST_RULESET_VERSION >= CURRENT_RULESET_VERSION);
});

test('abgeleitete Abfragen stimmen mit dem Katalog überein', () => {
  const v3 = getRuleset(3);

  // Taktung ist die Rezeptdauer — eine Zahl, eine Wahrheit.
  v3.passives.forEach((passive, i) => {
    assert.equal(passiveInterval(v3, i), v3.recipes[passive.recipe]!.durationTicks);
  });

  // Handelbar ist, was lagerfähig ist und einen Referenzpreis hat.
  assert.equal(isTradable(v3, v3.currency), false, 'Münzen sind nicht handelbar');
  assert.equal(isTradable(v3, 1), true, 'Weizen ist handelbar');
  assert.equal(isTradable(v3, 999), false, 'unbekannter Index ist nicht handelbar');
});

test('Inhalt ist wirklich gewachsen — sonst prüft der Rest nichts', () => {
  const v1 = getRuleset(1);
  const v3 = getRuleset(3);

  assert.equal(v1.items.length, 3, 'v1: Gold, Weizen, Eier');
  assert.equal(v3.items.length, 6, 'v3: dazu Milch, Mehl, Brot');
  assert.equal(v1.plots.length, 6);
  assert.equal(v3.plots.length, 8, 'dazu Mühle und Bäckerei');

  // Und die Kette existiert wirklich: Die Ausgabe des einen ist die Eingabe
  // des anderen. Genau daraus entsteht sie — niemand hat sie gebaut.
  const flour = v3.recipes.find((r) => r.id === 'flour')!;
  const bread = v3.recipes.find((r) => r.id === 'bread')!;
  assert.ok(bread.inputs.some((i) => i.item === flour.output.item), 'Brot braucht kein Mehl');
});
