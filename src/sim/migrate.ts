import type { Ruleset } from './rules.ts';
import { blockiert, getRuleset, levelRecipes, sizeOf, slotsAt } from './rules.ts';
import type { Slot, State } from './state.ts';
import { EMPTY_PLOT, capacityOf, cloneState, emptySlots, startPlatz, stored } from './state.ts';

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
    let slotChanged = false;
    const slots = p.slots.map((slot) => {
      if (slot.recipe === EMPTY_PLOT) return slot;

      const before = from.recipes[slot.recipe]?.durationTicks;
      const after = to.recipes[slot.recipe]?.durationTicks;
      if (before === undefined || after === undefined || before === after) return slot;

      slotChanged = true;
      const elapsed = state.tick - slot.startedAt;
      const remaining = Math.max(0, before - elapsed);
      const newRemaining = Math.min(remaining, after);
      return { recipe: slot.recipe, startedAt: state.tick - (after - newRemaining) };
    });
    if (!slotChanged) return p;
    changed = true;
    return { level: p.level, slots };
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
  const wanted = state.plots.map((p, i) => slotsAt(to, i, p.level));
  const slotsGrew = state.plots.some((p, i) => p.slots.length !== wanted[i]!);

  if (
    to.items.length === state.items.length &&
    to.plots.length === state.plots.length &&
    to.passives.length === state.passives.length &&
    !slotsGrew
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
  for (const [i, p] of state.plots.entries()) {
    if (wanted[i]! < p.slots.length) {
      throw new MigrationError(`v${from.version} → v${to.version}: Platz ${i} verliert Plätze`);
    }
  }

  const next = cloneState(state);

  const items = state.items.slice();
  while (items.length < to.items.length) items.push(0);
  next.items = items;

  const plots = state.plots.map((p, i) => {
    if (p.slots.length === wanted[i]!) return p;
    const slots: Slot[] = p.slots.slice();
    while (slots.length < wanted[i]!) slots.push({ recipe: EMPTY_PLOT, startedAt: 0 });
    return { level: p.level, slots };
  });

  while (plots.length < to.plots.length) {
    const i = plots.length;
    const level = to.plots[i]!.startLevel;
    plots.push({ level, slots: emptySlots(slotsAt(to, i, level)) });
  }
  next.plots = plots;

  const passives = state.passives.slice();
  while (passives.length < to.passives.length) passives.push(0);
  next.passives = passives;

  return next;
};

export const GROW_AND_RETIME: MigrationStep = (state, from, to) =>
  RETIME(GROW(state, from, to), from, to);

export const AUFS_RASTER: MigrationStep = (state, from, to) => {
  const gewachsen = GROW_AND_RETIME(state, from, to);
  const raster = to.grid;
  if (!raster) return gewachsen;
  const stimmt = gewachsen.plots.every((p, i) => {
    if (p.level <= 0) return true;
    if (p.gx < 0) return false;
    const g = sizeOf(to, i);
    return !blockiert(to, p.gx, p.gy, g.w, g.h, gewachsen.clearedObstacles);
  });
  if (stimmt) return gewachsen;

  const belegt: boolean[][] = [];
  for (let y = 0; y < raster.h; y++) belegt.push(new Array<boolean>(raster.w).fill(false));

  const passt = (gx: number, gy: number, w: number, h: number): boolean => {
    if (gx < 0 || gy < 0 || gx + w > raster.w || gy + h > raster.h) return false;
    if (blockiert(to, gx, gy, w, h, gewachsen.clearedObstacles)) return false;
    for (let y = gy; y < gy + h; y++) {
      for (let x = gx; x < gx + w; x++) if (belegt[y]![x]) return false;
    }
    return true;
  };
  const merken = (gx: number, gy: number, w: number, h: number): void => {
    for (let y = gy; y < gy + h; y++) {
      for (let x = gx; x < gx + w; x++) belegt[y]![x] = true;
    }
  };

  const plots = gewachsen.plots.map((p, i) => {
    if (p.level <= 0) return { ...p, gx: -1, gy: -1 };
    const groesse = sizeOf(to, i);
    if (p.gx >= 0 && passt(p.gx, p.gy, groesse.w, groesse.h)) {
      merken(p.gx, p.gy, groesse.w, groesse.h);
      return p;
    }

    const wunsch = startPlatz(to, i);
    if (passt(wunsch.gx, wunsch.gy, groesse.w, groesse.h)) {
      merken(wunsch.gx, wunsch.gy, groesse.w, groesse.h);
      return { ...p, gx: wunsch.gx, gy: wunsch.gy };
    }

    for (let y = 0; y <= raster.h - groesse.h; y++) {
      for (let x = 0; x <= raster.w - groesse.w; x++) {
        if (!passt(x, y, groesse.w, groesse.h)) continue;
        merken(x, y, groesse.w, groesse.h);
        return { ...p, gx: x, gy: y };
      }
    }
    throw new MigrationError(`kein Platz auf dem Raster für ${to.plots[i]?.id ?? i}`);
  });

  const next = cloneState(gewachsen);
  next.plots = plots;
  return next;
};

export const MIGRATIONS: ReadonlyMap<string, MigrationStep> = new Map([
  ['1->2', RETIME],

  ['2->3', GROW_AND_RETIME],
  ['3->4', GROW_AND_RETIME],
  ['4->5', GROW_AND_RETIME],
  ['5->6', RETIME],
  ['6->7', GROW_AND_RETIME],
  ['7->8', GROW_AND_RETIME],
  ['8->9', GROW_AND_RETIME],
  ['9->10', AUFS_RASTER],
  ['10->11', AUFS_RASTER],
  ['11->12', AUFS_RASTER],
  ['12->13', AUFS_RASTER],
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

  const platz = capacityOf(state, rules);
  if (stored(state, rules) > platz) {
    problems.push(`Lager über Limit: ${stored(state, rules)} > ${platz}`);
  }
  const stufen = rules.siloLevels?.length ?? 1;
  if (!Number.isInteger(state.siloLevel) || state.siloLevel < 0 || state.siloLevel >= stufen) {
    problems.push(`Lagerstufe ${state.siloLevel} gibt es nicht`);
  }
  for (const kiste of state.chests) {
    if (!rules.chestKinds?.[kiste.kind]) problems.push(`Kiste ${kiste.id}: Art unbekannt`);
    if (kiste.id >= state.nextChestId) problems.push(`Kisten-Nummer ${kiste.id} nicht vergeben`);
  }
  for (const art of state.pendingBoxes) {
    if (!rules.chestKinds?.[art]) problems.push(`offene Kiste: Art ${art} unbekannt`);
  }
  for (const i of state.clearedObstacles) {
    if (!rules.obstacles?.[i]) problems.push(`geräumtes Hindernis ${i} gibt es nicht`);
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

  const waybill = state.requests[0];
  if (state.truck.awayUntil < 0 || !Number.isSafeInteger(state.truck.awayUntil)) {
    problems.push(`Wagen-Rückkehr ungültig: ${state.truck.awayUntil}`);
  }
  state.truck.loaded.forEach((menge, i) => {
    if (!Number.isSafeInteger(menge) || menge < 0) {
      problems.push(`Wagen: Ladung ${menge} auf Posten ${i} ungültig`);
    }
    const posten = waybill?.wants[i];
    if (!posten) {
      if (menge > 0) problems.push(`Wagen: Ladung auf Posten ${i}, den es nicht gibt`);
    } else if (menge > posten.amount) {
      problems.push(`Wagen: ${menge} geladen, verlangt sind ${posten.amount}`);
    }
  });

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
    const orte = rules.destinations ?? [];
    if (!Number.isInteger(r.dest) || r.dest < 0 || (orte.length > 0 && r.dest >= orte.length)) {
      problems.push(`Auftrag ${r.id}: Ziel ${r.dest} gibt es nicht`);
    }
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
      continue;
    }
    const raster = rules.grid;
    if (raster && p.gx >= 0) {
      const groesse = sizeOf(rules, i);
      if (p.gx + groesse.w > raster.w || p.gy + groesse.h > raster.h || p.gy < 0) {
        problems.push(`Platz ${i} steht außerhalb des Rasters: ${p.gx},${p.gy}`);
      }
      if (blockiert(rules, p.gx, p.gy, groesse.w, groesse.h, state.clearedObstacles)) {
        problems.push(`Platz ${i} steht auf einem Hindernis`);
      }
      for (const [j, other] of state.plots.entries()) {
        if (j <= i || other.gx < 0) continue;
        const andere = sizeOf(rules, j);
        const frei =
          p.gx + groesse.w <= other.gx ||
          other.gx + andere.w <= p.gx ||
          p.gy + groesse.h <= other.gy ||
          other.gy + andere.h <= p.gy;
        if (!frei) problems.push(`Platz ${i} und ${j} stehen auf demselben Feld`);
      }
    }

    const capacity = slotsAt(rules, i, p.level);
    if (p.slots.length !== capacity) {
      problems.push(`Platz ${i}: ${p.slots.length} Plätze, Stufe ${p.level} hat ${capacity}`);
    }

    for (const [j, slot] of p.slots.entries()) {
      if (slot.recipe === EMPTY_PLOT) continue;
      if (!rules.recipes[slot.recipe]) {
        problems.push(`Platz ${i}/${j}: Rezept ${slot.recipe} gibt es nicht`);
      } else if (!levelRecipes(rules, i, p.level).includes(slot.recipe)) {
        problems.push(
          `Platz ${i}/${j}: Rezept ${slot.recipe} ist auf Stufe ${p.level} nicht erlaubt`,
        );
      }
      if (slot.startedAt > state.tick) {
        problems.push(`Platz ${i}/${j} in der Zukunft gestartet: ${slot.startedAt} > ${state.tick}`);
      }
      if (!Number.isSafeInteger(slot.startedAt)) {
        problems.push(`startedAt kein Integer: ${slot.startedAt}`);
      }
    }
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
