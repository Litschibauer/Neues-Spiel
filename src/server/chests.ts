import type { Ruleset } from '../sim/rules.ts';
import { blockiert, sizeOf } from '../sim/rules.ts';
import type { Chest, MailItem, State } from '../sim/state.ts';

function freieFelder(state: State, rules: Ruleset, schon: readonly Chest[]): Array<[number, number]> {
  const raster = rules.grid;
  if (!raster) return [];

  const frei: Array<[number, number]> = [];
  for (let gy = 0; gy < raster.h; gy++) {
    for (let gx = 0; gx < raster.w; gx++) {
      if (blockiert(rules, gx, gy, 1, 1, state.clearedObstacles)) continue;

      const belegt = state.plots.some((p, i) => {
        if (p.gx < 0) return false;
        const g = sizeOf(rules, i);
        return gx >= p.gx && gx < p.gx + g.w && gy >= p.gy && gy < p.gy + g.h;
      });
      if (belegt) continue;
      if (schon.some((k) => k.gx === gx && k.gy === gy)) continue;

      frei.push([gx, gy]);
    }
  }
  return frei;
}

export function topUpChests(
  state: State,
  rules: Ruleset,
  rnd: () => number,
): { chests: Chest[]; nextChestId: number } {
  const chests = [...state.chests];
  const arten = rules.chestKinds ?? [];
  const takt = rules.chestEveryTicks ?? 0;
  const max = rules.chestQueueMax ?? 0;

  if (arten.length === 0 || takt <= 0 || max <= 0) {
    return { chests, nextChestId: state.nextChestId };
  }

  let id = state.nextChestId;

  if (chests.length > 0) {
    const erste = chests[0]!;
    const belegt =
      erste.gx < 0 ||
      freieFelder(state, rules, chests.slice(1)).every(
        ([gx, gy]) => gx !== erste.gx || gy !== erste.gy,
      );
    if (belegt) {
      const frei = freieFelder(state, rules, chests.slice(1));
      if (frei.length > 0) {
        const stelle = frei[Math.floor(rnd() * frei.length)]!;
        chests[0] = { ...erste, gx: stelle[0]!, gy: stelle[1]! };
      }
    }
  }

  while (chests.length < max) {
    const frei = freieFelder(state, rules, chests);
    const stelle = frei.length > 0 ? frei[Math.floor(rnd() * frei.length)]! : [-1, -1];
    chests.push({
      id,
      kind: Math.floor(rnd() * arten.length),
      readyAt: 0,
      gx: stelle[0]!,
      gy: stelle[1]!,
    });
    id++;
  }

  return { chests, nextChestId: id };
}

export function rollChest(kind: number, rules: Ruleset, rnd: () => number): MailItem[] {
  const art = rules.chestKinds?.[kind];
  if (!art) return [];

  const beute: MailItem[] = [];
  const genommen = new Set<number>();

  for (let n = 0; n < art.picks; n++) {
    const offen = art.drops.filter((d) => !genommen.has(d.item));
    if (offen.length === 0) break;

    const gesamt = offen.reduce((sum, d) => sum + d.weight, 0);
    let los = Math.floor(rnd() * gesamt);
    let treffer = offen[offen.length - 1]!;
    for (const drop of offen) {
      if (los < drop.weight) {
        treffer = drop;
        break;
      }
      los -= drop.weight;
    }

    genommen.add(treffer.item);
    const spanne = treffer.max - treffer.min + 1;
    beute.push({
      item: treffer.item,
      amount: treffer.min + Math.floor(rnd() * spanne),
      arrivedAt: 0,
    });
  }

  return beute;
}
