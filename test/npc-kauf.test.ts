import test from 'node:test';
import assert from 'node:assert/strict';
import { Market } from '../src/server/market.ts';
import type { Order } from '../src/sim/state.ts';

function order(id: number, amount = 1, price = 10): Order {
  return { id, item: 1, amount, price, listedAt: 0, verkauft: 0 };
}

const OPTS = {
  chance: 1,
  maxProRunde: 10,
  minBuch: 1,
  minAlterMs: 0,
  behaltenProStand: 1,
};

test('NPC kauft nichts, wenn der Markt zu klein ist', () => {
  const m = new Market(null);
  m.reconcile('a', [order(1), order(2)], 0);
  const r = m.npcKauf({ ...OPTS, minBuch: 8 }, 1000);
  assert.deepEqual(r, []);
  assert.equal(m.size, 2, 'nichts gekauft');
});

test('Wahrscheinlichkeit 0 kauft nie', () => {
  const m = new Market(null);
  for (let s = 0; s < 5; s++) m.reconcile('s' + s, [order(s * 10 + 1), order(s * 10 + 2), order(s * 10 + 3)], 0);
  const vorher = m.size;
  const r = m.npcKauf({ ...OPTS, chance: 0 }, 1000);
  assert.deepEqual(r, []);
  assert.equal(m.size, vorher);
});

test('der NPC leert keinen Stand — jeder behält mindestens ein Angebot', () => {
  const m = new Market(null);
  for (let s = 0; s < 4; s++) m.reconcile('s' + s, [order(s * 10 + 1), order(s * 10 + 2)], 0);
  const start = m.size;
  for (let i = 0; i < 300; i++) m.npcKauf(OPTS, 1000);

  const proStand: Record<string, number> = {};
  for (const e of m.entries()) proStand[e.sellerId] = (proStand[e.sellerId] ?? 0) + 1;
  for (let s = 0; s < 4; s++) {
    assert.ok((proStand['s' + s] ?? 0) >= 1, 'Stand s' + s + ' wurde leer gekauft');
  }
  assert.ok(m.size < start, 'es wurde überhaupt etwas gekauft');
});

test('einen Stand mit nur einem Angebot rührt der NPC nie an', () => {
  const m = new Market(null);
  m.reconcile('einzeln', [order(1)], 0);
  for (let s = 0; s < 5; s++) m.reconcile('voll' + s, [order(s * 10 + 100), order(s * 10 + 101)], 0);
  for (let i = 0; i < 200; i++) m.npcKauf(OPTS, 1000);
  const hat = m.entries().some((e) => e.sellerId === 'einzeln');
  assert.ok(hat, 'das einzelne Angebot blieb erhalten');
});

test('frisch eingestellte Ware wird nicht gekauft (Mindestalter)', () => {
  const m = new Market(null);
  for (let s = 0; s < 4; s++) m.reconcile('s' + s, [order(s * 10 + 1), order(s * 10 + 2)], 1000);
  const r = m.npcKauf({ ...OPTS, minAlterMs: 60_000 }, 2000); // Alter 1000 ms < 60 s
  assert.deepEqual(r, []);
});

test('betroffene Verkäufer werden gemeldet und bekommen eine Abrechnung', () => {
  const m = new Market(null);
  for (let s = 0; s < 4; s++) m.reconcile('s' + s, [order(s * 10 + 1), order(s * 10 + 2), order(s * 10 + 3)], 0);
  let betroffen: string[] = [];
  for (let i = 0; i < 100 && betroffen.length === 0; i++) betroffen = m.npcKauf({ ...OPTS, maxProRunde: 1 }, 1000);
  assert.ok(betroffen.length >= 1, 'irgendwann kauft der NPC');
  assert.ok(m.peekSettlements(betroffen[0]!).length >= 1, 'der Verkäufer hat eine Abrechnung offen');
});

test('höchstens maxProRunde Käufe je Runde', () => {
  const m = new Market(null);
  for (let s = 0; s < 8; s++) m.reconcile('s' + s, [order(s * 10 + 1), order(s * 10 + 2), order(s * 10 + 3)], 0);
  const vorher = m.size;
  m.npcKauf({ ...OPTS, maxProRunde: 1 }, 1000);
  assert.ok(vorher - m.size <= 1, 'nicht mehr als ein Kauf bei maxProRunde 1');
});
