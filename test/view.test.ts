/**
 * Das Anzeigemodell (`view.ts`).
 *
 * Bis hierhin hatte die Oberfläche keine einzige Prüfung — sie steckte in einer
 * HTML-Datei und ließ sich nur im Browser anfassen. Genau dort saßen aber
 * Entscheidungen mit Spielwirkung: Ist das bezahlbar? Passt das ins Lager? Was
 * passiert bei einem Tipp?
 *
 * Solche Fragen doppelt zu beantworten — einmal in der Sim, einmal in der
 * Anzeige — ist der sichere Weg zu zwei Wahrheiten. Diese Tests halten fest,
 * dass es nur eine gibt, und sie laufen ohne Browser.
 */

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

  // Alles andere ist gesperrt — und sagt AUS WELCHEM Grund. Der Unterschied
  // zwischen „zu teuer" und „Stufe fehlt" ist der zwischen „gleich" und
  // „später", und den muss eine Oberfläche zeigen können.
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
  // Genug Erfahrung für die Mühle (Stufe 2), aber kein Gold.
  const level2 = rules.levelThresholds[0]!;
  const broke = farmView({ ...initialState(rules), xp: level2 }, rules);
  const mill = broke.plots.find((p) => p.id === 'mill')!;
  assert.equal(mill.upgrade?.unlocked, true, 'Stufe reicht nicht');
  assert.equal(mill.upgrade?.affordable, false);
  assert.equal(mill.blocked, 'cost');

  // Mit Gold wird derselbe Platz kaufbar — ohne dass sich sonst etwas ändert.
  const rich = farmView({ ...withItems({ [GOLD]: 1000 }), xp: level2 }, rules);
  const affordable = rich.plots.find((p) => p.id === 'mill')!;
  assert.equal(affordable.blocked, null);
  assert.equal(affordable.tap, 'buy');
});

test('fehlende Zutaten sperren die Mühle, ohne sie zu verstecken', () => {
  // Mühle gekauft, aber kein Weizen im Lager — das Startsaatgut ist längst
  // in der Erde.
  const base = withItems({ [GOLD]: 0, [WHEAT]: 0 });
  const plots = base.plots.slice();
  plots[MILL] = { level: 1, recipe: EMPTY_PLOT, startedAt: 0 };
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
      { id: 1, item: EGGS, amount: 10, price: 5 }, // 50 — geht
      { id: 2, item: EGGS, amount: 10, price: 30 }, // 300 — zu teuer
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
  // Sonst müsste jede Oberfläche selbst daran denken (§6), und die erste, die
  // es vergisst, verspricht dem Spieler etwas, das der Server ablehnt.
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
    requests: [0, 1, 2, 3, 4].map((n) => ({ id: n + 1, wants, reward, xp: 3 })),
  };
  const view = farmView(state, rules);

  const active = view.requests.filter((r) => !r.waiting);
  assert.equal(active.length, rules.requestSlots);
  assert.ok(active.every((r) => r.deliverable), 'Ware ist da, aber nicht lieferbar');
  // Der Vorrat ist sichtbar, aber nicht anklickbar — sonst wäre die Schlange
  // ein Regal, aus dem man sich den besten Auftrag heraussucht.
  assert.ok(view.requests.some((r) => r.waiting));
  assert.ok(view.requests.filter((r) => r.waiting).every((r) => !r.deliverable));
});

test('das Modell enthält keinen einzigen Anzeigetext', () => {
  // Die Bedingung dafür, dass ein eigenes Design oder eine zweite Sprache
  // billig bleibt. Erlaubt sind nur Katalog-Kennungen und Ausbau-Bezeichner
  // aus dem Regelwerk — beides Daten, keine Sätze.
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
  // Gegenprobe zum vorigen Test: Was das Modell über Kosten und Stufen sagt,
  // muss aus dem Regelwerk kommen — sonst hätte man zwei Wahrheiten.
  const view = farmView(farm({ xp: 10_000 }), rules);
  view.plots.forEach((p, i) => {
    const def = rules.plots[i]!;
    const next = def.levels[p.level] ?? null;
    assert.equal(p.upgrade?.label ?? null, next?.label ?? null);
    assert.deepEqual(p.upgrade?.cost ?? null, next?.cost ?? null);
  });
});

// ── Wegschicken (M6) ───────────────────────────────────────────────────────

test('Wegschicken ist erlaubt, solange die Wartezeit abgelaufen ist', () => {
  const base = initialState(rules);
  const withRequests = {
    ...base,
    requests: [1, 2, 3, 4, 5].map((id) => ({
      id,
      wants: [{ item: WHEAT, amount: 99 }],
      reward: [{ item: GOLD, amount: 10 }],
      xp: 1,
    })),
  };

  const v = farmView(withRequests, rules);
  assert.equal(v.skip.enabled, true);
  assert.equal(v.skip.ready, true);
  assert.equal(v.skip.readyIn, 0);
  assert.equal(v.skip.cooldownTicks, rules.requestSkipCooldownTicks);

  // Nur die vorderen Plätze — hinten ist Vorrat, kein Regal zum Aussuchen.
  const skippable = v.requests.filter((r) => r.skippable);
  assert.equal(skippable.length, rules.requestSlots);
  assert.ok(v.requests.filter((r) => r.waiting).every((r) => !r.skippable));
});

test('während der Wartezeit sagt das Modell, WIE LANGE noch', () => {
  // Ein grauer Knopf ohne Zahl sieht aus wie ein kaputter Knopf.
  const base = initialState(rules);
  const wartend = {
    ...base,
    tick: 100,
    skipReadyAt: 400,
    requests: [{ id: 1, wants: [{ item: WHEAT, amount: 1 }], reward: [], xp: 1 }],
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
    requests: [{ id: 1, wants: [{ item: WHEAT, amount: 1 }], reward: [], xp: 1 }],
  };

  const v = farmView(state, ohne);
  assert.equal(v.skip.enabled, false);
  assert.equal(v.skip.ready, false);
  assert.ok(v.requests.every((r) => !r.skippable));
});

// ── Mengen und Preise beim Verkaufen ───────────────────────────────────────

test('das Modell liefert die Grenzen, die eine Mengen- und Preiswahl braucht', () => {
  // Die Oberfläche darf das Preisband nicht selbst ausrechnen — sonst gäbe es
  // zwei Wahrheiten, und die Sim lehnte ab, was die Anzeige erlaubt hat.
  const v = farmView(withItems({ [WHEAT]: 12 }), rules);
  const wheat = v.stock.find((s) => s.item === WHEAT)!;

  assert.equal(wheat.amount, 12, 'die Obergrenze der Menge steht im Modell');
  assert.ok(wheat.bandMin >= 1, 'ein Mindestpreis unter 1 wäre kein Preis');
  assert.ok(wheat.bandMax >= wheat.bandMin);
  assert.ok(wheat.npcPrice > 0, 'der Festpreis des Händlers fehlt');

  // Und jeder Preis im Band muss von der Sim akzeptiert werden — genau das ist
  // die Zusage, auf die sich der Preiswähler stützt.
  for (let price = wheat.bandMin; price <= wheat.bandMax; price++) {
    const state = withItems({ [WHEAT]: 12, [GOLD]: 1000 });
    const cmd = { seq: 1, tick: 0, type: 'LIST_ORDER' as const, item: WHEAT, amount: 1, price };
    assert.doesNotThrow(() => simulate(state, cmd, rules), `Preis ${price} wurde abgelehnt`);
  }

  // Einen darüber lehnt sie ab — die Grenze ist also echt und nicht nur Zierde.
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
