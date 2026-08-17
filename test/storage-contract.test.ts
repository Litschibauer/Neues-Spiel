/**
 * Der Speichervertrag.
 *
 * Dieselbe Testreihe läuft gegen **jede** Implementierung von `Storage`. Wer
 * eine neue schreibt — Postgres, MariaDB, was auch immer —, hängt sie unten in
 * `BACKENDS` ein und macht diese Tests grün. Mehr ist nicht zu tun, und weniger
 * reicht nicht.
 *
 * Dieselbe Disziplin wie die Golden Vectors für den Sim-Kern: Eine Behauptung
 * über Austauschbarkeit ist wertlos, solange sie nicht ausgeführt wird. Eine
 * Schnittstelle mit nur einer Implementierung ist meistens nur die Form dieser
 * einen Implementierung — erst die zweite zeigt, ob wirklich nichts
 * durchgesickert ist.
 *
 * Geprüft wird nicht „speichert und liest", sondern das, woran ein Speicher im
 * Betrieb scheitert: Atomarität unter Gleichzeitigkeit, Isolation zwischen
 * Höfen, und dass nichts verloren geht, was Geld ist.
 */

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
  /** Neuer, leerer Speicher. `reopen` schließt und öffnet denselben wieder. */
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
            /* schon zu */
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
      // Ein Neustart ist hier bedeutungslos — der Vertrag verlangt ihn auch
      // nicht von jedem Speicher. Die Dauerhaftigkeitstests überspringen ihn.
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
    // Sonst schriebe ein Aufrufer, der das Geladene verändert, unbemerkt in die
    // Datenbank — und ein abgelehnter Sync hinterließe trotzdem Spuren. Eine
    // echte Datenbank kann das gar nicht; eine Implementierung im Speicher
    // schon, und deshalb steht es im Vertrag.
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

  suite('DER KERNPUNKT: zwei Käufer, ein Angebot — genau einer gewinnt', (store) => {
    store.putOffers([offer(1, 'anna')], []);

    const first = store.claimOffer(1, 'ben', T0);
    const second = store.claimOffer(1, 'cem', T0);

    assert.ok(first, 'der Erste hat nichts bekommen');
    assert.equal(second, null, 'das Angebot wurde zweimal verkauft');
    assert.equal(store.loadBook().length, 0);
  });

  suite('ein Verkauf hinterlegt die Abrechnung im selben Griff', (store) => {
    // Getrennt wäre die Lücke dazwischen genau der Fall, in dem der Käufer
    // bezahlt hat und der Verkäufer nichts bekommt.
    store.putOffers([offer(1, 'anna', 10, 3)], []);
    store.claimOffer(1, 'ben', T0 + 50);

    const due = store.takeSettlements('anna');
    assert.equal(due.length, 1);
    assert.equal(due[0]!.gold, 30);
    assert.equal(due[0]!.orderId, 1);
    assert.equal(due[0]!.soldMs, T0 + 50);

    // Entnommen heißt entnommen — sonst bekäme er sein Geld zweimal.
    assert.deepEqual(store.takeSettlements('anna'), []);
  });

  suite('niemand kauft bei sich selbst', (store) => {
    // Sonst wäre es eine Geldpresse: Gold zurück, Ware zurück, Auftrag weg.
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
    // Ohne das hätten zwei Serverprozesse zwei Kopien desselben Hofes im
    // Speicher — und jeder Sync des einen wäre für den anderen ein Fork (R3).
    store.putFarms([{ account: account('a1'), game: game(1) }]);
    const until = Date.now() + 60_000;

    assert.equal(store.claimFarm('a1', 'prozess-1', until), true);
    assert.equal(store.claimFarm('a1', 'prozess-2', until), false, 'zwei Besitzer gleichzeitig');
    // Derselbe Prozess darf jederzeit verlängern.
    assert.equal(store.claimFarm('a1', 'prozess-1', until + 1000), true);

    store.releaseFarm('a1', 'prozess-1');
    assert.equal(store.claimFarm('a1', 'prozess-2', until), true, 'nach Freigabe blockiert');
  });

  suite('ein abgestürzter Prozess blockiert den Hof nicht für immer', (store) => {
    // Freigeben kann nur, wer noch läuft. Ohne Ablauf wäre ein Absturz das
    // dauerhafte Ende dieses Hofes — der teuerste denkbare Bug.
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

/**
 * Dauerhaftigkeit — nur für Speicher, die eine Platte haben.
 *
 * Bewusst getrennt: „nur im Speicher" ist eine gültige Implementierung des
 * Vertrags, sie überlebt eben keinen Neustart. Diese Prüfung an alle zu
 * stellen, hieße, eine Anforderung zu erfinden, die es nicht gibt.
 */
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
    // Der wichtigste Teil: Bertas Erlös. Ben hat bezahlt.
    assert.equal(again.loadSettlements().length, 1, 'die Abrechnung ist verloren');
    assert.equal(again.loadSettlements()[0]!.gold, 30);
    assert.equal(again.getMeta('markt.naechsteNummer'), '77');
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
