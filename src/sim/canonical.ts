/**
 * Kanonische Serialisierung von Zustand und Commands.
 *
 * Bewusst OHNE Krypto und ohne jede Plattform-API — reines String-Bauen aus
 * Integern. Damit läuft diese Datei überall: Node, Browser, WASM, Mobile.
 *
 * Genau das macht sie zum Vergleichspunkt für den Plattform-Beweis: Zwei
 * Runtimes müssen für denselben Command-Log denselben kanonischen String
 * erzeugen. Ein Hash darüber ist nur noch Bequemlichkeit.
 */

import type { State } from './state.ts';
import type { Command } from './commands.ts';

/**
 * Feste Schlüsselreihenfolge, Arrays in Indexreihenfolge.
 * Kein `JSON.stringify(obj)` über Objekte — dessen Reihenfolge ist zwar in der
 * Praxis stabil, aber nichts, worauf man einen Konsistenzbeweis stützen will.
 */
export function canonicalize(state: State): string {
  const fields = state.fields.map((f) => `${f.crop ?? '-'}:${f.plantedAt}`).join(',');
  const orders = state.orders
    .map((o) => `${o.id}:${o.item}:${o.amount}:${o.price}:${o.listedAt}`)
    .join(',');
  const mail = state.mail.map((m) => `${m.item}:${m.amount}:${m.arrivedAt}`).join(',');
  return [
    `tick=${state.tick}`,
    `fields=[${fields}]`,
    `wheat=${state.wheat}`,
    `eggs=${state.eggs}`,
    `gold=${state.gold}`,
    `coopProgress=${state.coopProgress}`,
    `orders=[${orders}]`,
    `mail=[${mail}]`,
    `nextOrderId=${state.nextOrderId}`,
  ].join('|');
}

export function canonicalizeCommand(c: Command): string {
  switch (c.type) {
    case 'PLANT':
      return `${c.seq}|${c.tick}|PLANT|${c.field}`;
    case 'HARVEST':
      return `${c.seq}|${c.tick}|HARVEST|${c.field}`;
    case 'SELL_NPC':
      return `${c.seq}|${c.tick}|SELL_NPC|${c.item}|${c.amount}`;
    case 'LIST_ORDER':
      return `${c.seq}|${c.tick}|LIST_ORDER|${c.item}|${c.amount}|${c.price}`;
    case 'CANCEL_ORDER':
      return `${c.seq}|${c.tick}|CANCEL_ORDER|${c.orderId}`;
    case 'COLLECT_MAIL':
      return `${c.seq}|${c.tick}|COLLECT_MAIL`;
    default:
      throw new Error('unknown command type');
  }
}
