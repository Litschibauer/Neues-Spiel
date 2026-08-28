import type { Db } from './db.ts';
import { tagVon } from './sozial.ts';

export type BonusStufe = { gold: number; xp: number };

// Tag 1..7 der Serie, danach bleibt es auf der letzten Stufe stehen.
export const TAGESBONUS: readonly BonusStufe[] = [
  { gold: 50, xp: 0 },
  { gold: 100, xp: 5 },
  { gold: 150, xp: 8 },
  { gold: 250, xp: 12 },
  { gold: 400, xp: 16 },
  { gold: 600, xp: 20 },
  { gold: 1000, xp: 30 },
];

export function stufeFuer(streak: number): BonusStufe {
  const i = Math.min(Math.max(streak, 1), TAGESBONUS.length) - 1;
  return TAGESBONUS[i]!;
}

export type BonusStatus = {
  verfuegbar: boolean;
  streak: number;
  heute: BonusStufe;
  stufen: readonly BonusStufe[];
  laenge: number;
};

export class Tagesbonus {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private zeile(id: string): { day: number; streak: number } {
    const row = this.db
      .prepare('select bonus_day as day, bonus_streak as streak from accounts where id = ?')
      .get(id) as { day: number | null; streak: number | null } | undefined;
    return { day: row?.day ?? 0, streak: row?.streak ?? 0 };
  }

  private naechsterStreak(day: number, streak: number, heute: number): number {
    if (day === heute) return streak;
    return day === heute - 1 ? streak + 1 : 1;
  }

  status(id: string, nowMs: number): BonusStatus {
    const heute = tagVon(nowMs);
    const { day, streak } = this.zeile(id);
    const anzeige = this.naechsterStreak(day, streak, heute);
    return {
      verfuegbar: day !== heute,
      streak: anzeige,
      heute: stufeFuer(anzeige),
      stufen: TAGESBONUS,
      laenge: TAGESBONUS.length,
    };
  }

  hole(id: string, nowMs: number): { streak: number; lohn: BonusStufe } | null {
    const heute = tagVon(nowMs);
    const { day, streak } = this.zeile(id);
    if (day === heute) return null;
    const neu = this.naechsterStreak(day, streak, heute);
    this.db
      .prepare('update accounts set bonus_day = ?, bonus_streak = ? where id = ?')
      .run(heute, neu, id);
    return { streak: neu, lohn: stufeFuer(neu) };
  }
}
