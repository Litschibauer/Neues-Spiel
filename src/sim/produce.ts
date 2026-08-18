export type PassiveResult = {
  produced: number[];
  progress: number[];
};

export function advancePassives(
  elapsed: number,
  progress: readonly number[],
  space: number,
  intervals: readonly number[],
): PassiveResult {
  const n = intervals.length;
  const produced: number[] = [];
  const nextProgress: number[] = [];
  for (let i = 0; i < n; i++) {
    produced.push(0);
    nextProgress.push(progress[i] ?? 0);
  }

  if (n === 0 || elapsed <= 0 || space <= 0) return { produced, progress: nextProgress };

  const unitsBy = (tau: number): number => {
    let total = 0;
    for (let i = 0; i < n; i++) {
      total += Math.floor(((progress[i] ?? 0) + tau) / intervals[i]!);
    }
    return total;
  };

  const settle = (i: number, tau: number): void => {
    const accumulated = (progress[i] ?? 0) + tau;
    const interval = intervals[i]!;
    const units = Math.floor(accumulated / interval);
    produced[i] = units;
    nextProgress[i] = accumulated - units * interval;
  };

  if (unitsBy(elapsed) < space) {
    for (let i = 0; i < n; i++) settle(i, elapsed);
    return { produced, progress: nextProgress };
  }

  let lo = 1;
  let hi = elapsed;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (unitsBy(mid) >= space) hi = mid;
    else lo = mid + 1;
  }
  const full = lo;

  let free = space - unitsBy(full - 1);
  let last = n - 1;
  for (let i = 0; i < n; i++) {
    if (((progress[i] ?? 0) + full) % intervals[i]! === 0) {
      free--;
      if (free === 0) {
        last = i;
        break;
      }
    }
  }

  for (let i = 0; i < n; i++) settle(i, i <= last ? full : full - 1);
  return { produced, progress: nextProgress };
}

export function advancePassivesReference(
  elapsed: number,
  progress: readonly number[],
  space: number,
  intervals: readonly number[],
): PassiveResult {
  const n = intervals.length;
  const produced: number[] = [];
  const nextProgress: number[] = [];
  for (let i = 0; i < n; i++) {
    produced.push(0);
    nextProgress.push(progress[i] ?? 0);
  }

  let free = space;
  for (let tick = 0; tick < elapsed; tick++) {
    for (let i = 0; i < n; i++) {
      if (free <= 0) continue;
      nextProgress[i]!++;
      if (nextProgress[i]! >= intervals[i]!) {
        produced[i]!++;
        nextProgress[i] = 0;
        free--;
      }
    }
  }

  return { produced, progress: nextProgress };
}

export function advancePassivesNaive(
  elapsed: number,
  progress: readonly number[],
  space: number,
  intervals: readonly number[],
): PassiveResult {
  const n = intervals.length;
  const produced: number[] = [];
  const nextProgress: number[] = [];
  let free = space;

  for (let i = 0; i < n; i++) {
    const accumulated = (progress[i] ?? 0) + Math.max(0, elapsed);
    const interval = intervals[i]!;
    const units = Math.min(Math.floor(accumulated / interval), Math.max(0, free));
    produced.push(units);
    nextProgress.push(accumulated - Math.floor(accumulated / interval) * interval);
    free -= units;
  }

  return { produced, progress: nextProgress };
}
