import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountStore,
  Bremse,
  hashWort,
  pruefeWort,
  saubereWort,
  WORT_MIN,
} from '../src/server/accounts.ts';
import type { GameBlob } from '../src/server/storage.ts';

const T0 = 1_700_000_000_000;

function leererHof(): GameBlob {
  return {
    snapshot: { state: {}, seq: 0, serverTs: T0, rulesetVersion: 1 } as GameBlob['snapshot'],
    appliedLog: [],
    logStartSeq: 1,
    pendingDeliveries: [],
    targetRulesetVersion: 1,
    nextRequestId: 1,
  };
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-konto-'));
  const path = join(dir, 'spiel.db');
  return { dir, path, store: new AccountStore(path) };
}

test('das Wiederherstellungswort: Länge geprüft, nur als Hash gespeichert, prüfbar', () => {
  assert.equal(saubereWort('kurz'), null, 'zu kurz');
  assert.equal(saubereWort('  '.padEnd(WORT_MIN + 2, ' ')), null, 'nur Leerzeichen');
  assert.equal(saubereWort('x'.repeat(65)), null, 'zu lang');
  assert.equal(saubereWort('  Apfelbaum am Hof  '), 'Apfelbaum am Hof');

  const h = hashWort('Apfelbaum am Hof');
  assert.ok(h.startsWith('s1$'), 'Format mit Versionskennung');
  assert.ok(!h.includes('Apfelbaum'), 'das Wort steht nicht im Klartext');
  assert.notEqual(hashWort('Apfelbaum am Hof'), h, 'jedes Mal ein eigenes Salz');
  assert.equal(pruefeWort('Apfelbaum am Hof', h), true);
  assert.equal(pruefeWort('apfelbaum am hof', h), false, 'Groß/klein zählt');
  assert.equal(pruefeWort('Apfelbaum am Hof', null), false);
  assert.equal(pruefeWort('Apfelbaum am Hof', 'kaputt'), false);
});

test('der Weg zurück: Wort setzen, Schlüssel verlieren, mit dem Wort einen neuen bekommen', () => {
  const { dir, path, store } = tempStore();
  try {
    const { account, key } = store.create(T0, leererHof());
    assert.equal(store.hatWort(account.id), false);

    assert.equal(store.stelleWieder(account.id, 'Apfelbaum am Hof'), null, 'ohne Wort geht nichts');
    assert.ok(store.setzeWort(account.id, 'Apfelbaum am Hof'));
    assert.equal(store.hatWort(account.id), true);

    assert.equal(store.stelleWieder(account.id, 'falsches Wort!'), null, 'falsches Wort');
    assert.ok(store.resolve(key), 'ein Fehlversuch entwertet den alten Schlüssel nicht');

    const neu = store.stelleWieder(account.id, 'Apfelbaum am Hof');
    assert.ok(neu, 'richtiges Wort');
    assert.notEqual(neu.key, key);
    assert.equal(store.resolve(key), null, 'der alte Schlüssel gilt nicht mehr');
    assert.equal(store.resolve(neu.key)?.id, account.id, 'der neue führt zum selben Hof');
    assert.equal(store.hatWort(account.id), true, 'das Wort bleibt gesetzt');

    // Alles überlebt einen Neustart.
    store.close();
    const wieder = new AccountStore(path);
    assert.equal(wieder.resolve(key), null);
    assert.equal(wieder.resolve(neu.key)?.id, account.id);
    assert.equal(wieder.hatWort(account.id), true);
    assert.ok(wieder.stelleWieder(account.id, 'Apfelbaum am Hof'), 'auch nach dem Neustart prüfbar');
    wieder.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ein Hof lässt sich löschen — danach kennt der Server ihn nicht mehr', () => {
  const { dir, path, store } = tempStore();
  try {
    const a = store.create(T0, leererHof());
    const b = store.create(T0 + 1, leererHof());
    assert.equal(store.count, 2);

    assert.ok(store.loesche(a.account.id));
    assert.equal(store.count, 1);
    assert.equal(store.resolve(a.key), null, 'der Schlüssel öffnet nichts mehr');
    assert.equal(store.load(a.account.id), null);
    assert.equal(store.loesche(a.account.id), false, 'zweimal löschen geht nicht');
    assert.ok(store.resolve(b.key), 'der andere Hof bleibt');

    store.close();
    const wieder = new AccountStore(path);
    assert.equal(wieder.count, 1);
    assert.equal(wieder.resolve(a.key), null);
    wieder.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('die Bremse: so viele Versuche je Fenster, dann Warten — und Vergessen nach Erfolg', () => {
  const b = new Bremse(3, 1000);
  assert.ok(b.zaehle('k', T0).ok);
  assert.ok(b.zaehle('k', T0 + 10).ok);
  assert.ok(b.zaehle('k', T0 + 20).ok);
  const zu = b.zaehle('k', T0 + 30);
  assert.equal(zu.ok, false);
  assert.equal(!zu.ok && zu.warteMs, 970, 'wartet bis der älteste Treffer aus dem Fenster fällt');
  assert.ok(b.zaehle('anderer', T0 + 30).ok, 'ein anderer Schlüssel ist nicht betroffen');

  assert.ok(b.zaehle('k', T0 + 1001).ok, 'nach dem Fenster geht es wieder');

  b.vergiss('k');
  assert.ok(b.zaehle('k', T0 + 1002).ok);
  assert.ok(b.zaehle('k', T0 + 1003).ok);
  assert.ok(b.zaehle('k', T0 + 1004).ok, 'Vergessen hat den Zähler geleert');
});
