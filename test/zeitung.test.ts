import test from 'node:test';
import assert from 'node:assert/strict';
import { Market, ZEITUNG_HOEFE, hofNummer } from '../src/server/market.ts';
import type { Order } from '../src/sim/state.ts';
import { farmView } from '../src/client/view.ts';
import { getRuleset, LATEST_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';

const T0 = 1_700_000_000_000;

function auftrag(id: number, item: number, amount: number, price: number): Order {
  return { id, item, amount, price, listedAt: 0, verkauft: 0 };
}

function markt(hoefe: Record<string, Order[]>): Market {
  const market = new Market(null);
  let t = T0;
  for (const [wer, orders] of Object.entries(hoefe)) market.reconcile(wer, orders, (t += 1000));
  return market;
}

test('die Zeitung hängt von jedem Hof genau ein Stück aus', () => {
  const market = markt({
    anna: [auftrag(1, 1, 5, 4), auftrag(2, 3, 2, 30), auftrag(3, 4, 7, 6)],
    ben: [auftrag(1, 5, 3, 40), auftrag(2, 8, 1, 500)],
    clara: [auftrag(1, 2, 9, 10)],
  });

  const shelf = market.browse('dora', 60);
  const hoefe = new Set(shelf.map((o) => o.seller));
  assert.equal(hoefe.size, 3);

  for (const hof of hoefe) {
    const meins = shelf.filter((o) => o.seller === hof);
    assert.equal(
      meins.filter((o) => o.headline).length,
      1,
      `Hof ${hof} hängt nicht genau ein Stück aus`,
    );
  }

  assert.equal(shelf.length, 6, 'im Laden steht alles, nicht nur der Aushang');
});

test('der eigene Hof steht nie in der eigenen Zeitung', () => {
  const market = markt({
    anna: [auftrag(1, 1, 5, 4)],
    ben: [auftrag(1, 5, 3, 40)],
  });

  const annasBlatt = market.browse('anna', 60);
  assert.equal(annasBlatt.length, 1);
  assert.notEqual(annasBlatt[0]!.seller, hofNummer('anna'));
  assert.equal(annasBlatt[0]!.seller, hofNummer('ben'));
});

test('innerhalb einer Ausgabe bleibt der Aushang stehen — beim Aufschlagen wechselt er', () => {
  const viele: Order[] = [];
  for (let i = 1; i <= 6; i++) viele.push(auftrag(i, i, i, 10 + i));
  const market = markt({ anna: viele });

  const aushang = () => market.browse('ben', 60).find((o) => o.headline)!.id;

  const erste = aushang();
  assert.equal(aushang(), erste, 'derselbe Blick, anderer Aushang');
  assert.equal(aushang(), erste);

  let gewechselt = false;
  for (let n = 1; n <= 40 && !gewechselt; n++) {
    market.neueAusgabe('ben');
    if (aushang() !== erste) gewechselt = true;
  }
  assert.ok(gewechselt, 'der Aushang wechselt nie — dann ist es keine Zeitung');
});

test('das Blatt zeigt höchstens sechs Höfe, egal wie viele es gibt', () => {
  const hoefe: Record<string, Order[]> = {};
  for (let i = 0; i < 30; i++) hoefe[`hof-${i}`] = [auftrag(1, 1, 2, 3), auftrag(2, 4, 1, 8)];
  const market = markt(hoefe);

  const blatt = market.browse('ich', 200);
  assert.equal(new Set(blatt.map((o) => o.seller)).size, ZEITUNG_HOEFE);
  assert.equal(blatt.length, ZEITUNG_HOEFE * 2, 'hinter jeder Anzeige steht der ganze Laden');
});

test('jeder Hof kommt dran, bevor einer zum zweiten Mal drankommt', () => {
  const hoefe: Record<string, Order[]> = {};
  for (let i = 0; i < 24; i++) hoefe[`hof-${i}`] = [auftrag(1, 1, 2, 3)];
  const market = markt(hoefe);

  const gesehen = new Map<number, number>();
  for (let ausgabe = 0; ausgabe < 4; ausgabe++) {
    market.neueAusgabe('ich');
    for (const seller of new Set(market.browse('ich', 200).map((o) => o.seller))) {
      gesehen.set(seller, (gesehen.get(seller) ?? 0) + 1);
    }
  }

  assert.equal(gesehen.size, 24, `nach vier Ausgaben fehlen Höfe: ${gesehen.size}/24`);
  for (const [hof, wie] of gesehen) {
    assert.equal(wie, 1, `Hof ${hof} war ${wie}× dran, während andere warteten`);
  }
});

test('zwei Leser bekommen unterschiedliche Blätter', () => {
  const hoefe: Record<string, Order[]> = {};
  for (let i = 0; i < 20; i++) hoefe[`hof-${i}`] = [auftrag(1, 1, 2, 3)];
  const market = markt(hoefe);

  const a = market.browse('anna', 200).map((o) => o.seller);
  const b = market.browse('ben', 200).map((o) => o.seller);
  assert.notDeepEqual(a, b, 'alle lesen dasselbe Blatt');
});

test('solange die Höfe stehen, bleibt das Blatt beim Nachladen gleich', () => {
  const hoefe: Record<string, Order[]> = {};
  for (let i = 0; i < 20; i++) hoefe[`hof-${i}`] = [auftrag(1, 1, 2, 3)];
  const market = markt(hoefe);

  const erst = market.browse('ich', 200).map((o) => o.id);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(market.browse('ich', 200).map((o) => o.id), erst);
  }
});

test('zwei Höfe bekommen nie dieselbe Nummer im selben Blatt', () => {
  const hoefe: Record<string, Order[]> = {};
  for (let i = 0; i < 200; i++) hoefe[`hof-${i}`] = [auftrag(1, 1, 1, 2)];
  const market = markt(hoefe);

  let nummern: number[] = [];
  for (let ausgabe = 0; ausgabe < 40; ausgabe++) {
    market.neueAusgabe('ich');
    nummern = market.browse('ich', 200).map((o) => o.seller);
    assert.equal(new Set(nummern).size, nummern.length, 'zwei Höfe teilen sich eine Nummer');
  }
});

test('das Ansichtsmodell macht aus dem Regal eine Zeitung', () => {
  const rules = getRuleset(LATEST_RULESET_VERSION);
  const market = markt({
    anna: [auftrag(1, 1, 5, 4), auftrag(2, 4, 3, 6)],
    ben: [auftrag(1, 2, 2, 9)],
  });
  const shelf = market.browse('ich', rules.offerSlots);

  const base = initialState(rules);
  const v = farmView({ ...base, offers: shelf }, rules);

  assert.equal(v.zeitung.length, 2);
  const annasSeite = v.zeitung.find((z) => z.seller === hofNummer('anna'))!;
  assert.equal(annasSeite.offers.length, 2);
  assert.ok(annasSeite.offers.some((o) => o.id === annasSeite.aushang.id));
  assert.equal(annasSeite.aushang.headline, true);

  assert.equal(
    v.zeitung.reduce((n, z) => n + z.offers.length, 0),
    v.offers.length,
    'jedes Angebot liegt in genau einem Laden',
  );
});

test('das Regal fasst mehr Höfe, seit es eine Zeitung gibt', () => {
  assert.ok(getRuleset(LATEST_RULESET_VERSION).offerSlots > getRuleset(14).offerSlots);
});
