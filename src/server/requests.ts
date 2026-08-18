import type { Ruleset } from '../sim/rules.ts';
import { levelRecipes } from '../sim/rules.ts';
import type { Request, State } from '../sim/state.ts';

export function reachableItems(state: State, rules: Ruleset): Set<number> {
  const reachable = new Set<number>();

  rules.items.forEach((item, i) => {
    if (item.npcBuyPrice > 0) reachable.add(i);
    else if ((state.items[i] ?? 0) > 0) reachable.add(i);
  });

  const available: number[] = [];
  state.plots.forEach((plot, i) => {
    for (const recipe of levelRecipes(rules, i, plot.level)) {
      if (!available.includes(recipe)) available.push(recipe);
    }
  });
  for (const passive of rules.passives) {
    if (!available.includes(passive.recipe)) available.push(passive.recipe);
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const index of available) {
      const recipe = rules.recipes[index]!;
      if (reachable.has(recipe.output.item)) continue;
      if (recipe.inputs.every((input) => reachable.has(input.item))) {
        reachable.add(recipe.output.item);
        grew = true;
      }
    }
  }

  return reachable;
}

export function topUpRequests(
  state: State,
  rules: Ruleset,
  nextId: number,
  rnd: () => number = Math.random,
): { requests: Request[]; nextId: number } {
  const requests = [...state.requests];
  if (requests.length >= rules.requestQueueMax) return { requests, nextId };

  const reachable = reachableItems(state, rules);
  const usable = rules.requestTemplates.filter((t) =>
    t.wants.every((w) => reachable.has(w.item)),
  );

  if (usable.length === 0) return { requests, nextId };

  let id = nextId;
  while (requests.length < rules.requestQueueMax) {
    const template = usable[Math.floor(rnd() * usable.length)]!;
    requests.push({
      id,
      wants: template.wants.map((w) => ({ item: w.item, amount: w.amount })),
      reward: template.reward.map((r) => ({ item: r.item, amount: r.amount })),
      xp: template.xp,
    });
    id++;
  }

  return { requests, nextId: id };
}
