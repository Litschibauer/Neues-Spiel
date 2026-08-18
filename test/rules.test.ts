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

  const danglingOutput = {
    ...base,
    recipes: [{ id: 'ghost', inputs: [], output: { item: 99, amount: 1 }, durationTicks: 10 }],
    plots: [{ id: 'f', startLevel: 1, levels: [{ label: 'F', cost: [], recipes: [0] }] }],
    passives: [],
  };
  assert.ok(validateRuleset(danglingOutput).length > 0, 'unbekannte Ausgabe nicht erkannt');

  const danglingRecipe = {
    ...base,
    plots: [{ id: 'f', startLevel: 1, levels: [{ label: 'F', cost: [], recipes: [42] }] }],
  };
  assert.ok(validateRuleset(danglingRecipe).length > 0, 'unbekanntes Rezept nicht erkannt');

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

  const tooHigh = {
    ...base,
    plots: [{ id: 'f', startLevel: 5, levels: [{ label: 'F', cost: [], recipes: [0] }] }],
  };
  assert.ok(validateRuleset(tooHigh).length > 0, 'Startstufe außerhalb nicht erkannt');

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

  const batchPassive = {
    ...base,
    recipes: [
      ...base.recipes,
      { id: 'batch', inputs: [], output: { item: 3, amount: 5 }, durationTicks: 100 },
    ],
    passives: [{ id: 'coop', recipe: base.recipes.length }],
  };
  assert.ok(validateRuleset(batchPassive).length > 0, 'Stapel-Passive nicht erkannt');

  const heavyMoney = {
    ...base,
    items: base.items.map((i, idx) => (idx === 0 ? { ...i, storable: true } : i)),
  };
  assert.ok(validateRuleset(heavyMoney).length > 0, 'lagerpflichtige Währung nicht erkannt');
});

test('Kataloge wachsen nur hinten — sonst verschiebt sich die Bedeutung aller Indizes', () => {
  for (let i = 1; i < PRODUCTION_VERSIONS.length; i++) {
    const from = getRuleset(PRODUCTION_VERSIONS[i - 1]!);
    const to = getRuleset(PRODUCTION_VERSIONS[i]!);
    const label = `v${from.version} → v${to.version}`;

    assert.ok(to.items.length >= from.items.length, `${label}: Gegenstände verschwunden`);
    assert.ok(to.recipes.length >= from.recipes.length, `${label}: Rezepte verschwunden`);
    assert.ok(to.plots.length >= from.plots.length, `${label}: Plätze verschwunden`);
    assert.ok(to.passives.length >= from.passives.length, `${label}: Passive verschwunden`);

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

  assert.equal(isTradable(v1, v1.currency), false, 'Münzen sind nicht handelbar');
  assert.equal(isTradable(v1, 1), true, 'Weizen ist handelbar');
  assert.equal(isTradable(v1, 999), false, 'unbekannter Index ist nicht handelbar');

  assert.deepEqual([...levelRecipes(v1, 0, 0)], []);
  assert.deepEqual([...levelRecipes(v1, 0, 1)], [0]);
  assert.equal(nextLevel(v1, 0, 1), null, 'ein Feld hat nur eine Stufe');
});

test('DER KERNKREISLAUF steht als Tabelle da — Feld, Mühle, Gehege', () => {
  const v1 = getRuleset(1);
  const id = (i: number) => v1.items[i]!.id;

  const wheat = v1.recipes.find((r) => r.id === 'wheat')!;
  assert.equal(wheat.inputs.length, 1, 'Weizen wächst nicht aus dem Nichts');
  assert.equal(id(wheat.inputs[0]!.item), 'wheat', 'gesät wird Weizen');
  assert.equal(id(wheat.output.item), 'wheat');
  assert.ok(wheat.output.amount > wheat.inputs[0]!.amount, 'Aussaat lohnt sich nicht');

  const feed = v1.recipes.find((r) => r.id === 'feed')!;
  assert.equal(id(feed.inputs[0]!.item), 'wheat');
  assert.equal(id(feed.output.item), 'feed');

  const eggs = v1.recipes.find((r) => r.id === 'eggs')!;
  assert.equal(id(eggs.inputs[0]!.item), 'feed');
  assert.equal(id(eggs.output.item), 'eggs');

  const coop = v1.plots.find((p) => p.id === 'coop-1')!;
  assert.equal(coop.startLevel, 0, 'muss erst gekauft werden');
  assert.equal(coop.levels.length, 2);
  assert.deepEqual([...coop.levels[0]!.recipes], [], 'leeres Gehege legt nichts');
  assert.ok(coop.levels[1]!.recipes.length > 0, 'mit Hühnern legt es Eier');
});

test('der Einstieg ist bespielbar, ohne dass etwas gekauft werden muss', () => {
  const v1 = getRuleset(1);
  const free = v1.plots.filter((p) => p.startLevel > 0);
  assert.ok(free.length >= 3, `zu wenige Startplätze: ${free.length}`);

  const startStock = new Map<number, number>();
  for (const stack of v1.startingItems) {
    startStock.set(stack.item, (startStock.get(stack.item) ?? 0) + stack.amount);
  }

  for (const plot of free) {
    for (const recipe of plot.levels[plot.startLevel - 1]!.recipes) {
      for (const input of v1.recipes[recipe]!.inputs) {
        assert.ok(
          (startStock.get(input.item) ?? 0) >= input.amount,
          `Startplatz ${plot.id} braucht ${v1.items[input.item]!.id}, das nicht im Startvorrat liegt`,
        );
      }
    }
  }

  const need = new Map<number, number>();
  for (const plot of free) {
    const recipe = plot.levels[plot.startLevel - 1]!.recipes[0];
    if (recipe === undefined) continue;
    for (const input of v1.recipes[recipe]!.inputs) {
      need.set(input.item, (need.get(input.item) ?? 0) + input.amount);
    }
  }
  for (const [item, amount] of need) {
    assert.ok(
      (startStock.get(item) ?? 0) >= amount,
      `Startvorrat an ${v1.items[item]!.id} reicht nicht für alle Startplätze`,
    );
  }
});

test('kein Sackgassen-Zustand: verbrauchte Zutaten sind nachkaufbar und lohnen sich', () => {
  for (const version of [...RULESETS.keys()]) {
    const rules = getRuleset(version);
    const free = rules.plots.filter((p) => p.startLevel > 0);

    for (const plot of free) {
      for (const recipe of plot.levels[plot.startLevel - 1]!.recipes) {
        const def = rules.recipes[recipe]!;
        for (const input of def.inputs) {
          assert.ok(
            rules.items[input.item]!.npcBuyPrice > 0,
            `v${version}: ${rules.items[input.item]!.id} ist verbraucht, aber nicht nachkaufbar`,
          );
        }

        const cost = def.inputs.reduce(
          (sum, i) => sum + i.amount * rules.items[i.item]!.npcBuyPrice,
          0,
        );
        const worth = def.output.amount * rules.items[def.output.item]!.npcPrice;
        assert.ok(worth > cost, `v${version}: Rezept ${def.id} verliert Geld (${worth} ≤ ${cost})`);
      }
    }
  }
});
