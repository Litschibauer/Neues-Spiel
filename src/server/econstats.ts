import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Dauerhaft gezählte Economy-Senken. Wird bei jeder Änderung sofort in eine
// kleine JSON-Datei geschrieben, damit die Zahl einen Serverneustart übersteht.
export class EconStats {
  private readonly path: string;
  itemsDiscarded = 0;

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, 'utf8')) as { itemsDiscarded?: number };
        if (Number.isFinite(data.itemsDiscarded)) this.itemsDiscarded = data.itemsDiscarded!;
      } catch {
        /* unlesbar → bei 0 anfangen */
      }
    }
  }

  addDiscarded(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.itemsDiscarded += amount;
    this.persist();
  }

  private persist(): void {
    try {
      writeFileSync(this.path, JSON.stringify({ itemsDiscarded: this.itemsDiscarded }));
    } catch {
      /* Schreibfehler ignorieren — Statistik ist nicht kritisch */
    }
  }
}
