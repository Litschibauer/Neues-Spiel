import type { Ruleset } from '../sim/rules.ts';
import type { Chest, MailItem, State } from '../sim/state.ts';

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

  const streuung = rules.chestSpreadTicks ?? 0;
  let id = state.nextChestId;
  let letzte = chests.reduce((max2, c) => Math.max(max2, c.readyAt), state.tick);

  while (chests.length < max) {
    letzte += takt + Math.floor(rnd() * (streuung + 1));
    chests.push({ id, kind: Math.floor(rnd() * arten.length), readyAt: letzte });
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
