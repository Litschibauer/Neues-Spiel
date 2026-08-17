/**
 * Accounts (Phase 4).
 *
 * Ein Account ist ein langer Zufallsschlüssel — kein Benutzername, kein
 * Passwort, keine E-Mail. Warum das für den Anfang die richtige Wahl ist und
 * was es kostet, steht in `accounts.ts`.
 *
 * Geprüft wird hier vor allem eines: **dass Höfe sich nicht vermischen.** Das
 * ist die Eigenschaft, an der ein Mehrspieler-Server steht oder fällt — ein
 * Schlüssel, der den falschen Hof aufmacht, wäre schlimmer als gar keine
 * Accounts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountStore,
  CreateLimiter,
  KEY_PREFIX,
  generateKey,
  keyHashOf,
  normalizeKey,
} from '../src/server/accounts.ts';
import { Server } from '../src/server/server.ts';
import { Client } from '../src/client/client.ts';
import { getRuleset, CURRENT_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState, count } from '../src/sim/state.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);
const R_WHEAT = 0;
const WHEAT = 1;

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-accounts-'));
  return { dir, path: join(dir, 'spiel.db'), store: new AccountStore(join(dir, 'spiel.db')) };
}

function emptyGame() {
  return {
    snapshot: { state: initialState(rules), seq: 0, serverTs: T0, rulesetVersion: 1 },
    appliedLog: [],
    pendingDeliveries: [],
    targetRulesetVersion: 1,
    nextRequestId: 1,
  };
}

test('ein Schlüssel ist lang genug, dass Raten aussichtslos ist', () => {
  const key = generateKey();
  assert.ok(key.startsWith(KEY_PREFIX));

  const body = key.slice(KEY_PREFIX.length).replace(/-/g, '');
  assert.equal(body.length, 24, '24 Base32-Zeichen = 120 Bit');
  // Keine Zeichen, die man beim Abschreiben verwechselt.
  assert.match(body, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/);

  // Und wirklich zufällig: 500 Schlüssel, keine zwei gleich.
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) seen.add(generateKey());
  assert.equal(seen.size, 500);
});

test('Tippfehler beim Abschreiben kosten nicht den Hof', () => {
  const key = 'hof_20EBTP-XACTHM-QK4H7E-D6T9KS';
  const canonical = normalizeKey(key);

  // Kleinbuchstaben, fehlende Bindestriche, Leerzeichen, O statt 0, I statt 1.
  assert.equal(normalizeKey('  20ebtp xacthm qk4h7e d6t9ks '), canonical);
  assert.equal(normalizeKey('HOF_20EBTPXACTHMQK4H7ED6T9KS'), canonical);
  assert.equal(normalizeKey('hof_2OEBTP-XACTHM-QK4H7E-D6T9KS'), canonical, 'O statt 0');
  assert.equal(normalizeKey('hof_20EBTP-XACTHM-QK4H7E-D6T9KS'.replace('1', 'I')), canonical);
});

test('DER KERNPUNKT: zwei Höfe sehen einander nicht', () => {
  const { dir, store } = tempStore();
  try {
    const a = store.create(T0, emptyGame());
    const b = store.create(T0 + 1, emptyGame());

    assert.notEqual(a.key, b.key);
    assert.notEqual(a.account.id, b.account.id);

    // Jeder Schlüssel öffnet genau seinen Hof.
    assert.equal(store.resolve(a.key)?.id, a.account.id);
    assert.equal(store.resolve(b.key)?.id, b.account.id);

    // Und keinen anderen.
    assert.notEqual(store.resolve(a.key)?.id, b.account.id);
    assert.equal(store.resolve('hof_00000-000000-000000-000000'), null);
    assert.equal(store.resolve(''), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Spielstände bleiben getrennt — auch nach echtem Spielen', () => {
  const { dir, store } = tempStore();
  try {
    const a = store.create(T0, emptyGame());
    const b = store.create(T0, emptyGame());

    // Hof A erntet, Hof B nicht.
    const gameA = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
    const client = new Client(gameA.snapshot);
    client.start(0, R_WHEAT);
    client.advanceClock(rules.recipes[R_WHEAT]!.durationTicks);
    client.collect(0);
    gameA.sync(client.buildSyncRequest(), T0 + 200_000);

    store.save(a.account, {
      snapshot: gameA.snapshot,
      appliedLog: gameA.appliedLog,
      pendingDeliveries: gameA.pendingDeliveries,
      targetRulesetVersion: 1,
      nextRequestId: gameA.nextRequestId,
    });

    const loadedA = store.load(a.account.id)!;
    const loadedB = store.load(b.account.id)!;
    assert.equal(count(loadedA.snapshot.state, WHEAT), 10, 'Hof A hat seine Ernte nicht');
    assert.equal(count(loadedB.snapshot.state, WHEAT), 0, 'Hof B hat fremde Ernte');
    assert.equal(loadedB.snapshot.seq, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nach einem Neustart sind alle Höfe wieder da', () => {
  const { dir, path, store } = tempStore();
  try {
    const a = store.create(T0, emptyGame());
    const b = store.create(T0 + 1, emptyGame());
    store.flush();

    // Neuer Store auf derselben Datei — wie ein Serverneustart.
    const again = new AccountStore(path);
    assert.equal(again.count, 2);
    assert.equal(again.resolve(a.key)?.id, a.account.id);
    assert.equal(again.resolve(b.key)?.id, b.account.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auf der Platte liegt nur der Hash, nie der Schlüssel', () => {
  // Ein Backup, eine versehentlich geteilte Datei — nichts davon soll fremde
  // Höfe aufmachen können. Geprüft wird die ROHE Datei, nicht eine Abfrage:
  // Es geht ja gerade darum, was jemand sieht, der sie einfach aufmacht.
  const { dir, path, store } = tempStore();
  try {
    const { key } = store.create(T0, emptyGame());
    store.close();
    const raw = readFileSync(path, 'latin1');

    assert.ok(!raw.includes(key), 'der Schlüssel steht im Klartext in der Datei');
    assert.ok(!raw.includes(normalizeKey(key)), 'der normalisierte Schlüssel steht in der Datei');
    assert.ok(raw.includes(keyHashOf(key)), 'der Hash fehlt — der Schlüssel öffnet nichts mehr');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('beim Umzug alter Stände kostet eine kaputte Datei einen Hof, nicht alle', () => {
  // Der Übergang von „eine JSON-Datei je Hof" auf die Datenbank. Wer so einen
  // Stand liegen hat, soll ihn nicht verlieren — und eine unlesbare Datei
  // darunter darf den Umzug nicht abbrechen.
  const dir = mkdtempSync(join(tmpdir(), 'ns-accounts-'));
  try {
    const legacy = join(dir, 'accounts');
    mkdirSync(legacy, { recursive: true });

    const key = 'hof_20EBTP-XACTHM-QK4H7E-D6T9KS';
    writeFileSync(
      join(legacy, 'a-alt.json'),
      JSON.stringify({
        version: 1,
        account: { id: 'a-alt', keyHash: keyHashOf(key), createdAt: T0, lastSeenMs: T0 },
        ...emptyGame(),
      }),
    );
    writeFileSync(join(legacy, 'kaputt.json'), '{ das ist kein JSON');

    const store = new AccountStore(join(dir, 'spiel.db'), legacy);
    assert.equal(store.count, 1, 'der heile Hof ist mitgerissen worden');
    assert.equal(store.resolve(key)?.id, 'a-alt', 'der alte Schlüssel öffnet den Hof nicht mehr');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gesammeltes Schreiben verliert nichts — auch nicht vor dem Schreiben', () => {
  // Der Server merkt sich Änderungen und schreibt sie im Takt. Ein Lesen
  // dazwischen muss den NEUEN Stand liefern, sonst rechnete der nächste Sync
  // auf einem veralteten Spielstand weiter.
  const { dir, path, store } = tempStore();
  try {
    const { account } = store.create(T0, emptyGame());
    const game = emptyGame();
    game.nextRequestId = 42;
    store.save({ ...account, lastSeenMs: T0 + 5 }, game);

    assert.equal(store.pendingWrites, 1, 'es wurde sofort geschrieben statt gesammelt');
    assert.equal(store.load(account.id)?.nextRequestId, 42, 'das Gemerkte ist nicht sichtbar');

    assert.equal(store.flush(), 1);
    assert.equal(store.pendingWrites, 0);
    store.close();

    // Und nach einem Neustart steht es wirklich in der Datei.
    assert.equal(new AccountStore(path).load(account.id)?.nextRequestId, 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ein Server ohne Bremse ließe sich mit Höfen zumüllen (R4)', () => {
  const limiter = new CreateLimiter(3, 10);
  const now = T0;

  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.allow('1.2.3.4', now, i).ok, true, `Versuch ${i + 1} abgelehnt`);
  }
  const blocked = limiter.allow('1.2.3.4', now, 3);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.reason, 'TOO_MANY_NEW_FARMS');

  // Jemand anders darf trotzdem.
  assert.equal(limiter.allow('5.6.7.8', now, 3).ok, true);

  // Und eine Stunde später geht es wieder.
  assert.equal(limiter.allow('1.2.3.4', now + 3_600_001, 4).ok, true);
});

test('ist der Server voll, wird niemand mehr angelegt', () => {
  const limiter = new CreateLimiter(100, 5);
  const full = limiter.allow('1.2.3.4', T0, 5);
  assert.equal(full.ok, false);
  if (!full.ok) assert.equal(full.reason, 'SERVER_FULL');
});

test('ein alter Einzel-Spielstand lässt sich als Hof übernehmen', () => {
  // Vor den Accounts gab es einen Hof und ein Token. Wer so einen Stand
  // liegen hat, soll ihn nicht verlieren.
  const { dir, store } = tempStore();
  try {
    const oldToken = 'altes-feldtest-token-xyz';
    store.adopt(
      { id: 'a-imported', keyHash: keyHashOf(oldToken), createdAt: T0, lastSeenMs: T0 },
      emptyGame(),
    );
    store.close();

    const again = new AccountStore(join(dir, 'spiel.db'));
    assert.equal(again.resolve(oldToken)?.id, 'a-imported', 'das alte Token öffnet den Hof nicht');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
