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
  DEV_RULESET_VERSION,
  LATEST_RULESET_VERSION,
  PRODUCTION_VERSIONS,
  RULESETS,
  getRuleset,
  isTradable,
  levelRecipes,
  nextLevel,
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
    plots: [{ id: 'f', startLevel: 1, levels: [{ label: 'F', cost: [], recipes: [0] }] }],
    passives: [],
  };
  assert.ok(validateRuleset(danglingOutput).length > 0, 'unbekannte Ausgabe nicht erkannt');

  // Platz erlaubt ein Rezept, das es nicht gibt.
  const danglingRecipe = {
    ...base,
    plots: [{ id: 'f', startLevel: 1, levels: [{ label: 'F', cost: [], recipes: [42] }] }],
  };
  assert.ok(validateRuleset(danglingRecipe).length > 0, 'unbekanntes Rezept nicht erkannt');

  // Eine Startstufe, für die trotzdem ein Preis eingetragen ist.
  const paidStart = {
    ...base,
    plots: [
      {
        id: 'f',
        startLevel: 1,
        levels: [{ label: 'F', cost: [{ item: 0, amount: 10 }], recipes: [0] }],
      },
    ],
  };
  assert.ok(validateRuleset(paidStart).length > 0, 'bezahlte Startstufe nicht erkannt');

  // Startstufe jenseits der vorhandenen Stufen.
  const tooHigh = {
    ...base,
    plots: [{ id: 'f', startLevel: 5, levels: [{ label: 'F', cost: [], recipes: [0] }] }],
  };
  assert.ok(validateRuleset(tooHigh).length > 0, 'Startstufe außerhalb nicht erkannt');

  // Dieselbe Zutat zweimal — die Bestandsprüfung im Kern zählt sonst doppelt.
  const doubled = {
    ...base,
    recipes: [
      {
        id: 'dup',
        inputs: [
          { item: 1, amount: 2 },
          { item: 1, amount: 2 },
        ],
        output: { item: 1, amount: 1 },
        durationTicks: 10,
      },
    ],
    plots: [{ id: 'f', startLevel: 1, levels: [{ label: 'F', cost: [], recipes: [0] }] }],
    passives: [],
  };
  assert.ok(validateRuleset(doubled).length > 0, 'doppelte Zutat nicht erkannt');

  // Passive mit Eingaben — die geschlossene Form trägt das nicht (produce.ts).
  const hungryPassive = {
    ...base,
    recipes: [
      ...base.recipes,
      {
        id: 'cow',
        inputs: [{ item: 1, amount: 1 }],
        output: { item: 3, amount: 1 },
        durationTicks: 100,
      },
    ],
    passives: [{ id: 'pasture', recipe: base.recipes.length }],
  };
  assert.ok(validateRuleset(hungryPassive).length > 0, 'gefütterte Passive nicht erkannt');

  // Passive mit Ausgabemenge > 1 — dito.
  const batchPassive = {
    ...base,
    recipes: [
      ...base.recipes,
      { id: 'batch', inputs: [], output: { item: 3, amount: 5 }, durationTicks: 100 },
    ],
    passives: [{ id: 'coop', recipe: base.recipes.length }],
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
  // Nur entlang der Produktionsreihe: Das Dev-Regelwerk ist Wegwerfware und
  // steht bewusst außerhalb jeder Migration.
  for (let i = 1; i < PRODUCTION_VERSIONS.length; i++) {
    const from = getRuleset(PRODUCTION_VERSIONS[i - 1]!);
    const to = getRuleset(PRODUCTION_VERSIONS[i]!);
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
      const after = to.plots[index]!;
      assert.equal(after.id, plot.id, `${label}: Platz ${index} umgedeutet`);
      assert.ok(
        after.levels.length >= plot.levels.length,
        `${label}: Platz ${index} hat Stufen verloren`,
      );
      // Stufen dürfen dazukommen (neue Ausbaustufe), nie verschwinden oder
      // ihre Rezepte verlieren — sonst hinge ein gespeicherter Platz plötzlich
      // auf einer Stufe, die es nicht mehr gibt.
      plot.levels.forEach((level, l) => {
        for (const recipe of level.recipes) {
          assert.ok(
            after.levels[l]!.recipes.includes(recipe),
            `${label}: Platz ${index} Stufe ${l + 1} kann Rezept ${recipe} nicht mehr`,
          );
        }
      });
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

test('für jeden Sprung in der Produktionsreihe gibt es eine Migration', () => {
  for (let i = 1; i < PRODUCTION_VERSIONS.length; i++) {
    const key = `${PRODUCTION_VERSIONS[i - 1]}->${PRODUCTION_VERSIONS[i]}`;
    assert.ok(MIGRATIONS.has(key), `Migration ${key} fehlt`);
  }
  // Und ins Dev-Regelwerk führt bewusst keiner.
  assert.ok(
    ![...MIGRATIONS.keys()].some((k) => k.endsWith(`->${DEV_RULESET_VERSION}`)),
    'es gibt einen Migrationspfad ins Dev-Regelwerk',
  );
});

test('die benannten Versionen zeigen auf Regelwerke, die es gibt', () => {
  for (const v of [CURRENT_RULESET_VERSION, LATEST_RULESET_VERSION, DEV_RULESET_VERSION]) {
    assert.ok(RULESETS.has(v), `Version ${v} fehlt im Katalog`);
  }
  assert.ok(LATEST_RULESET_VERSION >= CURRENT_RULESET_VERSION);
  assert.ok(PRODUCTION_VERSIONS.includes(CURRENT_RULESET_VERSION));
  assert.ok(PRODUCTION_VERSIONS.includes(LATEST_RULESET_VERSION));
  assert.ok(!PRODUCTION_VERSIONS.includes(DEV_RULESET_VERSION), 'Dev gehört nicht in die Reihe');
});

test('abgeleitete Abfragen stimmen mit dem Katalog überein', () => {
  const v1 = getRuleset(1);

  // Handelbar ist, was lagerfähig ist und einen Referenzpreis hat.
  assert.equal(isTradable(v1, v1.currency), false, 'Münzen sind nicht handelbar');
  assert.equal(isTradable(v1, 1), true, 'Weizen ist handelbar');
  assert.equal(isTradable(v1, 999), false, 'unbekannter Index ist nicht handelbar');

  // Stufe 0 kann nichts, Stufe 1 des Feldes kann Weizen.
  assert.deepEqual([...levelRecipes(v1, 0, 0)], []);
  assert.deepEqual([...levelRecipes(v1, 0, 1)], [0]);
  assert.equal(nextLevel(v1, 0, 1), null, 'ein Feld hat nur eine Stufe');
});

test('DER KERNKREISLAUF steht als Tabelle da — Feld, Mühle, Gehege', () => {
  const v1 = getRuleset(1);
  const id = (i: number) => v1.items[i]!.id;

  // Feld: keine Eingaben, gibt Weizen.
  const wheat = v1.recipes.find((r) => r.id === 'wheat')!;
  assert.equal(wheat.inputs.length, 0);
  assert.equal(id(wheat.output.item), 'wheat');

  // Mühle: frisst Weizen, gibt Futter.
  const feed = v1.recipes.find((r) => r.id === 'feed')!;
  assert.equal(id(feed.inputs[0]!.item), 'wheat');
  assert.equal(id(feed.output.item), 'feed');

  // Gehege: frisst Futter, gibt Eier. Die Kette entsteht daraus, dass die
  // Ausgabe des einen die Eingabe des anderen ist — niemand hat sie gebaut.
  const eggs = v1.recipes.find((r) => r.id === 'eggs')!;
  assert.equal(id(eggs.inputs[0]!.item), 'feed');
  assert.equal(id(eggs.output.item), 'eggs');

  // Und das Gehege hat genau zwei Kaufschritte: Bau und Hühner.
  const coop = v1.plots.find((p) => p.id === 'coop-1')!;
  assert.equal(coop.startLevel, 0, 'muss erst gekauft werden');
  assert.equal(coop.levels.length, 2);
  assert.deepEqual([...coop.levels[0]!.recipes], [], 'leeres Gehege legt nichts');
  assert.ok(coop.levels[1]!.recipes.length > 0, 'mit Hühnern legt es Eier');
});

test('der Einstieg ist bespielbar, ohne dass etwas gekauft werden muss', () => {
  // Die Leerlauf-Regel aus Architektur §6: Es darf keinen Zustand geben, in dem
  // offline nichts zu tun ist. Ein frischer Hof braucht deshalb Plätze, die
  // ohne Eingaben und ohne Geld laufen.
  const v1 = getRuleset(1);
  const free = v1.plots.filter((p) => p.startLevel > 0);
  assert.ok(free.length >= 3, `zu wenige Startplätze: ${free.length}`);

  for (const plot of free) {
    for (const recipe of plot.levels[plot.startLevel - 1]!.recipes) {
      assert.equal(
        v1.recipes[recipe]!.inputs.length,
        0,
        `Startplatz ${plot.id} braucht Zutaten, die es noch nicht gibt`,
      );
    }
  }
});
