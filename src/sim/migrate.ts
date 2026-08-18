import type { Ruleset } from './rules.ts';
import { getRuleset, levelRecipes } from './rules.ts';
import type { State } from './state.ts';
import { EMPTY_PLOT, cloneState, stored } from './state.ts';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export type MigrationStep = (state: State, from: Ruleset, to: Ruleset) => State;

function rescaleDurations(state: State, from: Ruleset, to: Ruleset): State {
  let changed = false;
  const plots = state.plots.map((p) => {
    if (p.recipe === EMPTY_PLOT) return p;

    const before = from.recipes[p.recipe]?.durationTicks;
    const after = to.recipes[p.recipe]?.durationTicks;
    if (before === undefined || after === undefined || before === after) return p;

    changed = true;
    const elapsed = state.tick - p.startedAt;
    const remaining = Math.max(0, before - elapsed);
    const newRemaining = Math.min(remaining, after);
    return { level: p.level, recipe: p.recipe, startedAt: state.tick - (after - newRemaining) };
  });

  if (!changed) return state;
  const next = cloneState(state);
  next.plots = plots;
  return next;
}

function clampPassives(state: State, _from: Ruleset, to: Ruleset): State {
  let changed = false;
  const passives = state.passives.map((progress, i) => {
    const passive = to.passives[i];
    if (!passive) return progress;
    const interval = to.recipes[passive.recipe]!.durationTicks;
    if (progress < interval) return progress;
    changed = true;
    return interval - 1;
  });

  if (!changed) return state;
  const next = cloneState(state);
  next.passives = passives;
  return next;
}

export const RETIME: MigrationStep = (state, from, to) =>
  clampPassives(rescaleDurations(state, from, to), from, to);

export const GROW: MigrationStep = (state, from, to) => {
  if (
    to.items.length === state.items.length &&
    to.plots.length === state.plots.length &&
    to.passives.length === state.passives.length
  ) {
    return state;
  }
  if (
    to.items.length < state.items.length ||
    to.plots.length < state.plots.length ||
    to.passives.length < state.passives.length
  ) {
    throw new MigrationError(`v${from.version} → v${to.version}: Katalog schrumpft`);
  }

  const next = cloneState(state);

  const items = state.items.slice();
  while (items.length < to.items.length) items.push(0);
  next.items = items;

  const plots = state.plots.slice();

  while (plots.length < to.plots.length) {
    plots.push({ level: to.plots[plots.length]!.startLevel, recipe: EMPTY_PLOT, startedAt: 0 });
  }
  next.plots = plots;

  const passives = state.passives.slice();
  while (passives.length < to.passives.length) passives.push(0);
  next.passives = passives;

  return next;
};

export const GROW_AND_RETIME: MigrationStep = (state, from, to) =>
  RETIME(GROW(state, from, to), from, to);

export const MIGRATIONS: ReadonlyMap<string, MigrationStep> = new Map([
  ['1->2', RETIME],

  ['2->3', GROW_AND_RETIME],
]);

export function assertInvariants(state: State, rules: Ruleset): void {
  const problems: string[] = [];

  if (state.items.length !== rules.items.length) {
    problems.push(`Inventar ${state.items.length} != Katalog ${rules.items.length}`);
  }
  if (state.plots.length !== rules.plots.length) {
    problems.push(`Plätze ${state.plots.length} != Regelwerk ${rules.plots.length}`);
  }
  if (state.passives.length !== rules.passives.length) {
    problems.push(`Passive ${state.passives.length} != Regelwerk ${rules.passives.length}`);
  }

  if (stored(state, rules) > rules.siloCapacity) {
    problems.push(`Lager über Limit: ${stored(state, rules)} > ${rules.siloCapacity}`);
  }

  if (state.orders.length > rules.orderSlots) {
    problems.push(`zu viele Aufträge: ${state.orders.length} > ${rules.orderSlots}`);
  }
  if (state.mail.length > rules.mailCapacity) {
    problems.push(`Postfach über Limit: ${state.mail.length} > ${rules.mailCapacity}`);
  }
  for (const o of state.orders) {
    if (o.amount <= 0) problems.push(`Auftrag ${o.id} ohne Ware`);
    if (o.listedAt > state.tick) problems.push(`Auftrag ${o.id} aus der Zukunft`);
    if (o.id >= state.nextOrderId) problems.push(`Auftrags-ID ${o.id} nicht vergeben`);
    if (!rules.items[o.item]) problems.push(`Auftrag ${o.id}: Gegenstand ${o.item} unbekannt`);
  }
  for (const m of state.mail) {
    if (m.amount <= 0) problems.push('Postfach-Eintrag ohne Inhalt');
    if (!rules.items[m.item]) problems.push(`Postfach: Gegenstand ${m.item} unbekannt`);
  }

  if (state.offers.length > rules.offerSlots) {
    problems.push(`Auslage über Limit: ${state.offers.length} > ${rules.offerSlots}`);
  }
  const offerIds = new Set<number>();
  for (const o of state.offers) {
    if (offerIds.has(o.id)) problems.push(`Angebot ${o.id} doppelt in der Auslage`);
    offerIds.add(o.id);
    if (o.amount <= 0) problems.push(`Angebot ${o.id} ohne Ware`);
    if (o.price <= 0) problems.push(`Angebot ${o.id} ohne Preis`);
    if (!rules.items[o.item]) problems.push(`Angebot ${o.id}: Gegenstand ${o.item} unbekannt`);
  }

  if (state.requests.length > rules.requestQueueMax) {
    problems.push(`Auftragsvorrat über Limit: ${state.requests.length} > ${rules.requestQueueMax}`);
  }
  const requestIds = new Set<number>();
  for (const r of state.requests) {
    if (requestIds.has(r.id)) problems.push(`Auftrags-Nummer ${r.id} doppelt vergeben`);
    requestIds.add(r.id);
    if (r.wants.length === 0) problems.push(`Auftrag ${r.id} verlangt nichts`);
    if (!Number.isSafeInteger(r.xp) || r.xp < 0) problems.push(`Auftrag ${r.id}: XP ungültig`);
    if (r.reward.length === 0) problems.push(`Auftrag ${r.id} gibt nichts`);
    for (const stack of [...r.wants, ...r.reward]) {
      if (!rules.items[stack.item]) problems.push(`Auftrag ${r.id}: Gegenstand unbekannt`);
      if (stack.amount <= 0) problems.push(`Auftrag ${r.id}: Menge <= 0`);
    }
  }

  for (const [i, progress] of state.passives.entries()) {
    const passive = rules.passives[i];
    if (!passive) continue;
    const interval = rules.recipes[passive.recipe]!.durationTicks;
    if (progress < 0 || progress >= interval) {
      problems.push(`Fortschritt ${passive.id} außerhalb [0, ${interval}): ${progress}`);
    }
  }

  for (const [i, value] of state.items.entries()) {
    if (value < 0) problems.push(`negativer Bestand bei ${rules.items[i]?.id ?? i}`);
    if (!Number.isSafeInteger(value)) problems.push(`kein sicherer Integer: ${value}`);
  }
  if (!Number.isSafeInteger(state.tick)) problems.push(`tick kein sicherer Integer: ${state.tick}`);
  if (!Number.isSafeInteger(state.xp) || state.xp < 0) {
    problems.push(`Erfahrung ungültig: ${state.xp}`);
  }

  for (const [i, p] of state.plots.entries()) {
    const def = rules.plots[i];
    if (!def) continue;
    if (!Number.isInteger(p.level) || p.level < 0 || p.level > def.levels.length) {
      problems.push(`Platz ${i}: Stufe ${p.level} außerhalb von [0, ${def.levels.length}]`);
    }

    if (p.recipe === EMPTY_PLOT) continue;
    if (!rules.recipes[p.recipe]) {
      problems.push(`Platz ${i}: Rezept ${p.recipe} gibt es nicht`);
    } else if (!levelRecipes(rules, i, p.level).includes(p.recipe)) {
      problems.push(`Platz ${i}: Rezept ${p.recipe} ist auf Stufe ${p.level} nicht erlaubt`);
    }
    if (p.startedAt > state.tick) {
      problems.push(`Platz ${i} in der Zukunft gestartet: ${p.startedAt} > ${state.tick}`);
    }
    if (!Number.isSafeInteger(p.startedAt)) problems.push(`startedAt kein Integer: ${p.startedAt}`);
  }

  if (problems.length > 0) {
    throw new MigrationError(`ungültiger Zustand: ${problems.join('; ')}`);
  }
}

export function migrateState(state: State, fromVersion: number, toVersion: number): State {
  if (toVersion === fromVersion) return state;
  if (toVersion < fromVersion) {
    throw new MigrationError(`Downgrade ${fromVersion} → ${toVersion} wird nicht unterstützt`);
  }

  let current = state;
  for (let v = fromVersion; v < toVersion; v++) {
    const step = MIGRATIONS.get(`${v}->${v + 1}`);
    if (!step) throw new MigrationError(`keine Migration für ${v} → ${v + 1}`);

    const from = getRuleset(v);
    const to = getRuleset(v + 1);
    current = step(current, from, to);
    assertInvariants(current, to);
  }

  return current;
}
