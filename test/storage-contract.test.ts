import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStorage, SqliteStorage } from '../src/server/storage.ts';
import type { AccountRecord, BookEntry, GameBlob, Storage } from '../src/server/storage.ts';

const T0 = 1_700_000_000_000;

type Backend = {
  name: string;
  open: () => { store: Storage; reopen: () => Storage; done: () => void };
};

const BACKENDS: Backend[] = [
  {
    name: 'SQLite',
    open: () => {
      const dir = mkdtempSync(join(tmpdir(), 'ns-contract-'));
      const path = join(dir, 'spiel.db');
      let store = new SqliteStorage(path);
      return {
        store,
        reopen: () => {
          store.close();
          store = new SqliteStorage(path);
          return store;
        },
        done: () => {
          try {
            store.close();
          } catch {
          }
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: 'nur im Speicher',
    open: () => {
      const store = new MemoryStorage();

      return { store, reopen: () => store, done: () => store.close() };
    },
  },
];

function account(id: string, at = T0): AccountRecord {
  return { id, keyHash: `hash-${id}`, createdAt: at, lastSeenMs: at };
}

function game(nextRequestId: number): GameBlob {
  return {
    snapshot: { state: {}, seq: 0, serverTs: T0, rulesetVersion: 1 } as GameBlob['snapshot'],
    appliedLog: [],
    logStartSeq: 1,
    pendingDeliveries: [],
    targetRulesetVersion: 1,
    nextRequestId,
  };
}

function offer(id: number, sellerId: string, amount = 10, price = 3): BookEntry {
  return { id, sellerId, orderId: id, item: 1, amount, price, listedMs: T0 };
}

for (const backend of BACKENDS) {
  const suite = (name: string, body: (s: Storage, ctx: ReturnType<Backend['open']>) => void) =>
    test(`[${backend.name}] ${name}`, () => {
      const ctx = backend.open();
      try {
        body(ctx.store, ctx);
      } finally {
        ctx.done();
      }
    });

  suite('Höfe kommen so zurück, wie sie hineingingen', (store) => {
    store.putFarms([
      { account: account('a1'), game: game(7) },
      { account: account('a2'), game: game(9) },
    ]);

    assert.equal(store.listAccounts().length, 2);
    assert.equal(store.loadFarm('a1')?.nextRequestId, 7);
    assert.equal(store.loadFarm('a2')?.nextRequestId, 9);
    assert.equal(store.loadFarm('gibtsnicht'), null);
  });

  suite('ein geladener Spielstand ist eine KOPIE, keine Leitung in den Speicher', (store) => {
    store.putFarms([{ account: account('a1'), game: game(1) }]);
    const loaded = store.loadFarm('a1')!;
    loaded.nextRequestId = 999;
    assert.equal(store.loadFarm('a1')?.nextRequestId, 1, 'die Änderung ist durchgeschlagen');
  });

  suite('Schreiben ist ein Ersetzen, kein Anhängen', (store) => {
    store.putFarms([{ account: account('a1'), game: game(1) }]);
    store.putFarms([{ account: { ...account('a1'), lastSeenMs: T0 + 500 }, game: game(2) }]);

    assert.equal(store.listAccounts().length, 1, 'derselbe Hof steht doppelt drin');
    assert.equal(store.loadFarm('a1')?.nextRequestId, 2);
    assert.equal(store.listAccounts()[0]!.lastSeenMs, T0 + 500);
  });

  suite('das Wiederherstellungswort reist als Hash mit dem Konto', (store, ctx) => {
    store.putFarms([{ account: { ...account('a1'), recoveryHash: 's1$aa$bb' }, game: game(1) }]);
    store.putFarms([{ account: account('a2'), game: game(1) }]);
    const wieder = ctx.reopen();
    const a1 = wieder.listAccounts().find((a) => a.id === 'a1');
    const a2 = wieder.listAccounts().find((a) => a.id === 'a2');
    assert.equal(a1?.recoveryHash, 's1$aa$bb');
    assert.equal(a2?.recoveryHash ?? null, null);
  });

  suite('Löschen nimmt Konto, Angebote, Abrechnungen und Push-Abos mit', (store) => {
    store.putFarms([{ account: account('a1'), game: game(1) }, { account: account('a2'), game: game(2) }]);
    store.putOffers([offer(1, 'a1'), offer(2, 'a2')], []);
    store.claimOffer(2, 'a1', T0);
    store.putPushAbo({ endpoint: 'e1', konto: 'a1', art: 'web', p256dh: 'p', auth: 'a', seitMs: T0, zuletztMs: 0 });
    store.putPushAbo({ endpoint: 'e2', konto: 'a2', art: 'web', p256dh: 'p', auth: 'a', seitMs: T0, zuletztMs: 0 });
    store.putRueckmeldung({ konto: 'a1', code: 'ABC', art: 'idee', text: 'mehr Kühe', version: 'v', huelle: 'h', regelwerk: 1, geraet: 'g', zeitMs: T0 });

    assert.equal(store.deleteAccount('a1'), true);
    assert.equal(store.deleteAccount('a1'), false);
    assert.equal(store.loadFarm('a1'), null);
    assert.deepEqual(store.listAccounts().map((a) => a.id), ['a2']);
    assert.equal(store.loadBook().some((o) => o.sellerId === 'a1'), false, 'Angebote des Hofs sind weg');
    assert.deepEqual(store.listPushAbos().map((a) => a.endpoint), ['e2']);
    assert.equal(store.listRueckmeldungen(10, false).length, 0, 'Rückmeldungen des Hofs sind weg');
    assert.equal(store.takeSettlements('a2').length, 1, 'a2 bekommt sein Gold aus a1s Kauf trotzdem');
  });

  suite('Rückmeldungen: neueste zuerst, erledigte ausblendbar', (store) => {
    const r = (t: string, zeit: number) => ({ konto: 'a1', code: 'ABC', art: 'fehler' as const, text: t, version: 'v1', huelle: 'h1', regelwerk: 51, geraet: 'iPhone', zeitMs: zeit });
    const eins = store.putRueckmeldung(r('eins', T0));
    store.putRueckmeldung(r('zwei', T0 + 5));
    assert.deepEqual(store.listRueckmeldungen(10, true).map((x) => x.text), ['zwei', 'eins']);
    assert.ok(store.erledigeRueckmeldung(eins, true));
    assert.deepEqual(store.listRueckmeldungen(10, true).map((x) => x.text), ['zwei']);
    assert.deepEqual(store.listRueckmeldungen(10, false).map((x) => [x.text, x.erledigt]), [['zwei', false], ['eins', true]]);
    assert.equal(store.erledigeRueckmeldung(999, true), false);
    const z = store.listRueckmeldungen(1, false)[0]!;
    assert.equal(z.regelwerk, 51);
    assert.equal(z.geraet, 'iPhone');
  });

  suite('Fehlerberichte: derselbe Fehler wird gezählt, nicht gestapelt', (store) => {
    const f = (t: string, zeit: number, konto = '') => ({ schluessel: 'k-' + t, konto, text: t, stapel: 'at x', ort: '/', version: 'v1', huelle: 'h1', regelwerk: 51, geraet: 'g', zuletztMs: zeit });
    store.putFehler(f('boom', T0));
    store.putFehler(f('boom', T0 + 10, 'a1'));
    store.putFehler(f('peng', T0 + 5));
    const liste = store.listFehler(10);
    assert.deepEqual(liste.map((x) => [x.text, x.anzahl]), [['boom', 2], ['peng', 1]]);
    assert.equal(liste[0]!.zuerstMs, T0);
    assert.equal(liste[0]!.zuletztMs, T0 + 10);
    assert.equal(liste[0]!.konto, 'a1', 'ein später bekanntes Konto wird nachgetragen');
    assert.equal(store.dropFehler(liste[1]!.id), 1);
    assert.equal(store.listFehler(10).length, 1);
    assert.equal(store.dropFehler('alle'), 1);
    assert.equal(store.listFehler(10).length, 0);
  });

  suite('wipe(): danach ist die Welt leer — und bleibt es nach dem Neuöffnen', (store, ctx) => {
    store.putFarms([{ account: account('a1'), game: game(1) }]);
    store.putOffers([offer(1, 'a1')], []);
    store.putPushAbo({ endpoint: 'e1', konto: 'a1', art: 'web', p256dh: 'p', auth: 'a', seitMs: T0, zuletztMs: 0 });
    store.putRueckmeldung({ konto: 'a1', code: 'ABC', art: 'lob', text: 'schön', version: 'v', huelle: 'h', regelwerk: 1, geraet: 'g', zeitMs: T0 });
    store.putFehler({ schluessel: 'k', konto: '', text: 'x', stapel: '', ort: '/', version: '', huelle: '', regelwerk: 0, geraet: '', zuletztMs: T0 });
    store.setMeta('market.nextOfferId', '99');
    store.wipe();
    const wieder = ctx.reopen();
    assert.deepEqual(wieder.listAccounts(), []);
    assert.deepEqual(wieder.loadBook(), []);
    assert.deepEqual(wieder.listPushAbos(), []);
    assert.deepEqual(wieder.listRueckmeldungen(10, false), []);
    assert.deepEqual(wieder.listFehler(10), []);
    assert.equal(wieder.getMeta('market.nextOfferId'), null);
    const neu = wieder.putRueckmeldung({ konto: 'b', code: 'DEF', art: 'idee', text: 'neu', version: 'v', huelle: 'h', regelwerk: 1, geraet: 'g', zeitMs: T0 });
    assert.equal(neu, 1, 'die laufenden Nummern fangen wieder bei 1 an');
  });

  suite('DER KERNPUNKT: zwei Käufer, ein Angebot — genau einer gewinnt', (store) => {
    store.putOffers([offer(1, 'anna')], []);

    const first = store.claimOffer(1, 'ben', T0);
    const second = store.claimOffer(1, 'cem', T0);

    assert.ok(first, 'der Erste hat nichts bekommen');
    assert.equal(second, null, 'das Angebot wurde zweimal verkauft');
    assert.equal(store.loadBook().length, 0);
  });

  suite('ein Verkauf hinterlegt die Abrechnung im selben Griff', (store) => {
    store.putOffers([offer(1, 'anna', 10, 3)], []);
    store.claimOffer(1, 'ben', T0 + 50);

    const due = store.takeSettlements('anna');
    assert.equal(due.length, 1);
    assert.equal(due[0]!.gold, 30);
    assert.equal(due[0]!.orderId, 1);
    assert.equal(due[0]!.soldMs, T0 + 50);

    assert.deepEqual(store.takeSettlements('anna'), []);
  });

  suite('niemand kauft bei sich selbst', (store) => {
    store.putOffers([offer(1, 'anna')], []);
    assert.equal(store.claimOffer(1, 'anna', T0), null);
    assert.equal(store.loadBook().length, 1, 'das Angebot ist trotz Ablehnung weg');
  });

  suite('Abrechnungen bleiben zwischen Verkäufern getrennt', (store) => {
    store.putOffers([offer(1, 'anna'), offer(2, 'berta')], []);
    store.claimOffer(1, 'ben', T0);
    store.claimOffer(2, 'ben', T0);

    assert.equal(store.takeSettlements('anna').length, 1);
    assert.equal(store.takeSettlements('berta').length, 1, 'fremdes Geld mitgenommen');
  });

  suite('Angebote lassen sich anlegen, ändern und entfernen', (store) => {
    store.putOffers([offer(1, 'anna', 10, 3), offer(2, 'anna', 5, 4)], []);
    assert.equal(store.loadBook().length, 2);

    store.putOffers([offer(1, 'anna', 8, 3)], [2]);
    const book = store.loadBook();
    assert.equal(book.length, 1);
    assert.equal(book[0]!.amount, 8, 'die Änderung kam nicht an');
  });

  suite('einen Hof vergessen räumt Angebote UND Abrechnungen weg', (store) => {
    store.putOffers([offer(1, 'anna'), offer(2, 'berta')], []);
    store.claimOffer(1, 'ben', T0);

    store.forgetSeller('anna');
    assert.deepEqual(store.takeSettlements('anna'), []);
    assert.equal(store.loadBook().length, 1, 'fremde Angebote mitgerissen');
    assert.equal(store.loadBook()[0]!.sellerId, 'berta');
  });

  suite('DER ZWEITE KERNPUNKT: ein Hof gehört immer nur einem Prozess', (store) => {
    store.putFarms([{ account: account('a1'), game: game(1) }]);
    const until = Date.now() + 60_000;

    assert.equal(store.claimFarm('a1', 'prozess-1', until), true);
    assert.equal(store.claimFarm('a1', 'prozess-2', until), false, 'zwei Besitzer gleichzeitig');

    assert.equal(store.claimFarm('a1', 'prozess-1', until + 1000), true);

    store.releaseFarm('a1', 'prozess-1');
    assert.equal(store.claimFarm('a1', 'prozess-2', until), true, 'nach Freigabe blockiert');
  });

  suite('ein abgestürzter Prozess blockiert den Hof nicht für immer', (store) => {
    store.putFarms([{ account: account('a1'), game: game(1) }]);
    assert.equal(store.claimFarm('a1', 'abgestuerzt', Date.now() - 1), true);
    assert.equal(store.claimFarm('a1', 'der-neue', Date.now() + 60_000), true, 'Hof bleibt verwaist');
  });

  suite('fremde Freigaben werden ignoriert', (store) => {
    store.putFarms([{ account: account('a1'), game: game(1) }]);
    const until = Date.now() + 60_000;
    store.claimFarm('a1', 'prozess-1', until);

    store.releaseFarm('a1', 'prozess-2');
    assert.equal(store.claimFarm('a1', 'prozess-2', until), false, 'fremde Freigabe hat gegriffen');
  });

  suite('Kleinkram bleibt Kleinkram', (store) => {
    assert.equal(store.getMeta('nichts'), null);
    store.setMeta('markt.naechsteNummer', '42');
    assert.equal(store.getMeta('markt.naechsteNummer'), '42');
    store.setMeta('markt.naechsteNummer', '43');
    assert.equal(store.getMeta('markt.naechsteNummer'), '43');
  });
}

test('[SQLite] alles überlebt einen Neustart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-contract-'));
  const path = join(dir, 'spiel.db');
  try {
    const first = new SqliteStorage(path);
    first.putFarms([{ account: account('a1'), game: game(11) }]);
    first.putOffers([offer(1, 'anna'), offer(2, 'berta')], []);
    first.claimOffer(2, 'ben', T0);
    first.setMeta('markt.naechsteNummer', '77');
    first.close();

    const again = new SqliteStorage(path);
    assert.equal(again.loadFarm('a1')?.nextRequestId, 11, 'Spielstand weg');
    assert.equal(again.loadBook().length, 1, 'Buch stimmt nicht');
    assert.equal(again.loadBook()[0]!.sellerId, 'anna');

    assert.equal(again.loadSettlements().length, 1, 'die Abrechnung ist verloren');
    assert.equal(again.loadSettlements()[0]!.gold, 30);
    assert.equal(again.getMeta('markt.naechsteNummer'), '77');
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
