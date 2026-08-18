import test from 'node:test';
import assert from 'node:assert/strict';
import { farmView } from '../src/client/view.ts';
import { CURRENT_RULESET_VERSION, getRuleset } from '../src/sim/rules.ts';
import { EMPTY_PLOT, initialState } from '../src/sim/state.ts';
import type { State } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';

const rules = getRuleset(CURRENT_RULESET_VERSION);
const GOLD = rules.currency;
const WHEAT = 1;
const EGGS = 3;
const R_WHEAT = 0;
const MILL = 6;
const START_WHEAT = rules.startingItems.find((x) => x.item === WHEAT)?.amount ?? 0;

function farm(patch: Partial<State> = {}): State {
  return { ...initialState(rules), ...patch };
}

function withItems(changes: Record<number, number>): State {
  const base = initialState(rules);
  const items = base.items.slice();
  for (const [i, n] of Object.entries(changes)) items[Number(i)] = n;
  return { ...base, items };
}

test('ein frischer Hof: drei Felder bespielbar, der Rest wartet auf Stufen', () => {
  const view = farmView(initialState(rules), rules);

  assert.equal(view.level, 1);
  assert.equal(view.silo.used, START_WHEAT, 'das Startsaatgut liegt im Lager');
  assert.equal(view.currency.amount, 0);

  const playable = view.plots.filter((p) => p.tap === 'start');
  assert.equal(playable.length, 3, 'nicht genau die drei Startfelder sind bespielbar');
  assert.deepEqual(
    playable.map((p) => p.id),
    ['field-1', 'field-2', 'field-3'],
  );

  const mill = view.plots.find((p) => p.id === 'mill')!;
  assert.equal(mill.tap, 'buy');
  assert.equal(mill.blocked, 'level');
  assert.equal(mill.upgrade?.unlocked, false);
});

test('ein laufendes Feld meldet Fortschritt, ein fertiges meldet Ernte', () => {
  const duration = rules.recipes[R_WHEAT]!.durationTicks;
  let state = simulate(initialState(rules), { seq: 1, tick: 0, type: 'START', plot: 0, recipe: R_WHEAT }, rules);

  const half = farmView({ ...state, tick: Math.floor(duration / 2) }, rules).plots[0]!;
  assert.equal(half.busy, true);
  assert.equal(half.done, false);
  assert.equal(half.tap, 'none', 'ein laufendes Feld darf nicht anklickbar sein');
  assert.ok(half.progress > 0.4 && half.progress < 0.6, `Fortschritt ${half.progress}`);
  assert.equal(half.remaining, duration - Math.floor(duration / 2));
  assert.equal(half.producing, 'wheat');

  const ripe = farmView({ ...state, tick: duration }, rules).plots[0]!;
  assert.equal(ripe.done, true);
  assert.equal(ripe.progress, 1);
  assert.equal(ripe.remaining, 0);
  assert.equal(ripe.tap, 'collect');
  assert.deepEqual(ripe.output, { item: WHEAT, amount: rules.recipes[R_WHEAT]!.output.amount });
});

test('„zu teuer" und „Stufe fehlt" werden nicht verwechselt', () => {
  const level2 = rules.levelThresholds[0]!;
  const broke = farmView({ ...initialState(rules), xp: level2 }, rules);
  const mill = broke.plots.find((p) => p.id === 'mill')!;
  assert.equal(mill.upgrade?.unlocked, true, 'Stufe reicht nicht');
  assert.equal(mill.upgrade?.affordable, false);
  assert.equal(mill.blocked, 'cost');

  const rich = farmView({ ...withItems({ [GOLD]: 1000 }), xp: level2 }, rules);
  const affordable = rich.plots.find((p) => p.id === 'mill')!;
  assert.equal(affordable.blocked, null);
  assert.equal(affordable.tap, 'buy');
});

test('fehlende Zutaten sperren die Mühle, ohne sie zu verstecken', () => {
  const base = withItems({ [GOLD]: 0, [WHEAT]: 0 });
  const plots = base.plots.slice();
  plots[MILL] = { level: 1, slots: [{ recipe: EMPTY_PLOT, startedAt: 0 }] };
  const view = farmView({ ...base, plots }, rules);

  const mill = view.plots[MILL]!;
  assert.equal(mill.idle, false, 'die Mühle kann etwas, sie hat nur nichts');
  assert.equal(mill.tap, 'none');
  assert.equal(mill.blocked, 'inputs');
});

test('ein Angebot, das man sich nicht leisten kann, sagt genau das', () => {
  const state = {
    ...withItems({ [GOLD]: 100 }),
    offers: [
      { id: 1, item: EGGS, amount: 10, price: 5 },
      { id: 2, item: EGGS, amount: 10, price: 30 },
    ],
  };
  const view = farmView(state, rules);

  assert.equal(view.offers[0]!.total, 50);
  assert.equal(view.offers[0]!.affordable, true);
  assert.equal(view.offers[1]!.affordable, false);
  assert.equal(view.buyable, 1);
});

test('ein volles Lager macht Angebote unkaufbar, nicht unsichtbar', () => {
  const state = {
    ...withItems({ [GOLD]: 10_000, [WHEAT]: rules.siloCapacity }),
    offers: [{ id: 1, item: EGGS, amount: 5, price: 5 }],
  };
  const view = farmView(state, rules);

  assert.equal(view.silo.full, true);
  assert.equal(view.offers.length, 1, 'das Angebot ist verschwunden statt gesperrt');
  assert.equal(view.offers[0]!.affordable, true, 'Geld hätte er ja');
  assert.equal(view.offers[0]!.fits, false);
  assert.equal(view.buyable, 0);
});

test('OHNE NETZ ist nichts kaufbar — die Regel steht im Modell, nicht in der Anzeige', () => {
  const state = {
    ...withItems({ [GOLD]: 10_000 }),
    offers: [{ id: 1, item: EGGS, amount: 5, price: 5 }],
  };
  assert.equal(farmView(state, rules, true).buyable, 1);
  assert.equal(farmView(state, rules, false).buyable, 0);
});

test('nur die vorderen Kundenaufträge sind lieferbar, der Rest ist Vorrat', () => {
  const wants = [{ item: WHEAT, amount: 5 }];
  const reward = [{ item: GOLD, amount: 40 }];
  const state = {
    ...withItems({ [WHEAT]: 50 }),
    requests: [0, 1, 2, 3, 4].map((n) => ({ id: n + 1, wants, reward, xp: 3, dest: 0 })),
  };
  const view = farmView(state, rules);

  const active = view.requests.filter((r) => !r.waiting);
  assert.equal(active.length, rules.requestSlots);
  assert.ok(active.every((r) => r.deliverable), 'Ware ist da, aber nicht lieferbar');

  assert.ok(view.requests.some((r) => r.waiting));
  assert.ok(view.requests.filter((r) => r.waiting).every((r) => !r.deliverable));
});

test('das Modell enthält keinen einzigen Anzeigetext', () => {
  const state = {
    ...withItems({ [GOLD]: 500, [WHEAT]: 20 }),
    offers: [{ id: 1, item: EGGS, amount: 4, price: 20 }],
    orders: [{ id: 1, item: WHEAT, amount: 5, price: 4, listedAt: 0 }],
    mail: [{ item: GOLD, amount: 30, arrivedAt: 0 }],
  };
  const view = farmView(state, rules);

  const allowed = new Set<string>([
    ...rules.items.map((i) => i.id),
    ...rules.plots.map((p) => p.id),
    ...rules.plots.flatMap((p) => p.levels.map((l) => l.label)),
    ...rules.recipes.map((r) => r.id),
    'collect', 'start', 'buy', 'none',
    'level', 'cost', 'inputs', 'space', 'slots', 'offline',
  ]);

  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(view);

  const stray = strings.filter((s) => !allowed.has(s));
  assert.deepEqual(stray, [], `Anzeigetext im Modell: ${stray.join(', ')}`);
});

test('das Modell rechnet keine Regel nach, es liest sie ab', () => {
  const view = farmView(farm({ xp: 10_000 }), rules);
  view.plots.forEach((p, i) => {
    const def = rules.plots[i]!;
    const next = def.levels[p.level] ?? null;
    assert.equal(p.upgrade?.label ?? null, next?.label ?? null);
    assert.deepEqual(p.upgrade?.cost ?? null, next?.cost ?? null);
  });
});

test('Wegschicken ist erlaubt, solange die Wartezeit abgelaufen ist', () => {
  const base = initialState(rules);
  const withRequests = {
    ...base,
    requests: [1, 2, 3, 4, 5].map((id) => ({
      id,
      wants: [{ item: WHEAT, amount: 99 }],
      reward: [{ item: GOLD, amount: 10 }],
      xp: 1,
      dest: 0,
    })),
  };

  const v = farmView(withRequests, rules);
  assert.equal(v.skip.enabled, true);
  assert.equal(v.skip.ready, true);
  assert.equal(v.skip.readyIn, 0);
  assert.equal(v.skip.cooldownTicks, rules.requestSkipCooldownTicks);

  const skippable = v.requests.filter((r) => r.skippable);
  assert.equal(skippable.length, rules.requestSlots);
  assert.ok(v.requests.filter((r) => r.waiting).every((r) => !r.skippable));
});

test('während der Wartezeit sagt das Modell, WIE LANGE noch', () => {
  const base = initialState(rules);
  const wartend = {
    ...base,
    tick: 100,
    skipReadyAt: 400,
    requests: [{ id: 1, wants: [{ item: WHEAT, amount: 1 }], reward: [], xp: 1, dest: 0 }],
  };

  const v = farmView(wartend, rules);
  assert.equal(v.skip.ready, false);
  assert.equal(v.skip.readyIn, 300);
  assert.ok(v.requests.every((r) => !r.skippable));
});

test('kennt ein Regelwerk das Wegschicken nicht, taucht es gar nicht erst auf', () => {
  const ohne = { ...rules, requestSkipCooldownTicks: 0 };
  const state = {
    ...initialState(rules),
    requests: [{ id: 1, wants: [{ item: WHEAT, amount: 1 }], reward: [], xp: 1, dest: 0 }],
  };

  const v = farmView(state, ohne);
  assert.equal(v.skip.enabled, false);
  assert.equal(v.skip.ready, false);
  assert.ok(v.requests.every((r) => !r.skippable));
});

test('das Modell liefert die Grenzen, die eine Mengen- und Preiswahl braucht', () => {
  const v = farmView(withItems({ [WHEAT]: 12 }), rules);
  const wheat = v.stock.find((s) => s.item === WHEAT)!;

  assert.equal(wheat.amount, 12, 'die Obergrenze der Menge steht im Modell');
  assert.ok(wheat.bandMin >= 1, 'ein Mindestpreis unter 1 wäre kein Preis');
  assert.ok(wheat.bandMax >= wheat.bandMin);
  assert.ok(wheat.npcPrice > 0, 'der Festpreis des Händlers fehlt');

  for (let price = wheat.bandMin; price <= wheat.bandMax; price++) {
    const state = withItems({ [WHEAT]: 12, [GOLD]: 1000 });
    const cmd = { seq: 1, tick: 0, type: 'LIST_ORDER' as const, item: WHEAT, amount: 1, price };
    assert.doesNotThrow(() => simulate(state, cmd, rules), `Preis ${price} wurde abgelehnt`);
  }

  assert.throws(
    () =>
      simulate(
        withItems({ [WHEAT]: 12, [GOLD]: 1000 }),
        { seq: 1, tick: 0, type: 'LIST_ORDER', item: WHEAT, amount: 1, price: wheat.bandMax + 1 },
        rules,
      ),
    { code: 'PRICE_OUT_OF_BAND' },
  );
});

test('ein Feld mit zwei Früchten bietet BEIDE an — auch die, die gerade nicht geht', () => {
  const v3 = getRuleset(3);
  const CORN = v3.items.findIndex((i) => i.id === 'corn');
  const base = initialState(v3);
  const items = base.items.slice();
  items[CORN] = 0;

  const field = farmView({ ...base, items }, v3).plots[0]!;
  assert.equal(field.options.length, 2, 'das Feld bietet nicht beide Früchte an');
  assert.deepEqual(
    field.options.map((o) => o.id),
    ['wheat', 'corn'],
  );
  assert.equal(field.options[0]!.affordable, true);
  assert.equal(field.options[1]!.affordable, false, 'Mais ohne Saatgut gilt als machbar');

  assert.equal(field.next?.id, 'wheat');
  assert.equal(field.tap, 'start');
});

test('ein Platz mit genau einem Rezept braucht keine Auswahl', () => {
  const v3 = getRuleset(3);
  const MILL = v3.plots.findIndex((p) => p.id === 'mill');
  const base = initialState(v3);
  const plots = base.plots.slice();
  plots[MILL] = { level: 1, slots: [{ recipe: EMPTY_PLOT, startedAt: 0 }] };

  const mill = farmView({ ...base, plots }, v3).plots[MILL]!;
  assert.equal(mill.options.length, 1);
  assert.equal(mill.options[0]!.id, 'feed');
});

test('ein laufender Platz bietet nichts an — er ist beschäftigt', () => {
  const v3 = getRuleset(3);
  const running = simulate(
    initialState(v3),
    { seq: 1, tick: 0, type: 'START', plot: 0, recipe: 0 },
    v3,
  );
  assert.deepEqual(farmView(running, v3).plots[0]!.options, []);
});

test('die Auswahl nennt Kosten, Dauer und Ertrag — alles aus dem Regelwerk', () => {
  const v3 = getRuleset(3);
  const corn = farmView(initialState(v3), v3).plots[0]!.options.find((o) => o.id === 'corn')!;
  const def = v3.recipes.find((r) => r.id === 'corn')!;

  assert.deepEqual(corn.inputs, def.inputs);
  assert.deepEqual(corn.output, def.output);
  assert.equal(corn.durationTicks, def.durationTicks);

  assert.equal(corn.inputs[0]!.item, corn.output.item);
  assert.ok(corn.output.amount > corn.inputs[0]!.amount);
});

test('ein gesperrtes Rezept steht sichtbar in der Auswahl, statt zu fehlen', () => {
  // Sonst rätselt der Spieler, wo die Butter geblieben ist — oder ob es sie
  // überhaupt gibt.
  const v4 = getRuleset(4);
  const DAIRY = v4.plots.findIndex((p) => p.id === 'dairy');
  const base = initialState(v4);
  const plots = base.plots.slice();
  plots[DAIRY] = { level: 1, slots: [{ recipe: EMPTY_PLOT, startedAt: 0 }] };

  const jung = farmView({ ...base, xp: v4.levelThresholds[4]!, plots }, v4).plots[DAIRY]!;
  assert.equal(jung.options.length, 3, 'die Molkerei zeigt nicht alle drei Rezepte');
  assert.deepEqual(
    jung.options.map((o) => o.id),
    ['cream', 'butter', 'cheese'],
  );
  assert.deepEqual(
    jung.options.map((o) => o.unlocked),
    [true, false, false],
  );
  assert.deepEqual(
    jung.options.map((o) => o.minPlayerLevel),
    [6, 8, 10],
  );

  // Und was gesperrt ist, gilt nie als startbar — auch mit allen Zutaten.
  const items = base.items.slice();
  items[v4.items.findIndex((i) => i.id === 'milk')] = 50;
  const voll = farmView({ ...base, xp: v4.levelThresholds[4]!, items, plots }, v4).plots[DAIRY]!;
  assert.equal(voll.options[1]!.affordable, false, 'Butter gilt als machbar');
  assert.equal(voll.next?.id, 'cream');
});

test('ein Platz, dessen Rezepte alle noch gesperrt sind, sagt „Stufe" statt „Zutaten"', () => {
  const v4 = getRuleset(4);
  const DAIRY = v4.plots.findIndex((p) => p.id === 'dairy');
  const gesperrt = {
    ...v4,
    recipes: v4.recipes.map((r) => (r.id === 'cream' ? { ...r, minPlayerLevel: 12 } : r)),
  };
  const base = initialState(v4);
  const plots = base.plots.slice();
  plots[DAIRY] = { level: 1, slots: [{ recipe: EMPTY_PLOT, startedAt: 0 }] };

  const v = farmView({ ...base, xp: v4.levelThresholds[4]!, plots }, gesperrt).plots[DAIRY]!;
  assert.equal(v.blocked, 'level');
  assert.equal(v.tap, 'none');
});
