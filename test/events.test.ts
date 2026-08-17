/**
 * Die Live-Leitung (`events.ts`).
 *
 * Was hier geprüft wird, ist nicht „kommt eine Nachricht an" — das wäre ein
 * Test des Transports. Geprüft werden die Eigenschaften, an denen ein
 * Anstoß-Kanal auf einem kleinen Server scheitert:
 *
 *  - Er darf **keine Spieldaten** tragen. Sonst gäbe es einen zweiten Weg in
 *    den Client, der am Sync mit seinem Präfix-Commit vorbeiliefe.
 *  - Er darf **nicht rückkoppeln**. Kauf → Buchänderung → Anstoß an alle →
 *    Sync → Kauf: Ohne Bündelung baut sich das zu einem Dauerfeuer auf.
 *  - Er muss **abgewiesene Verbindungen** verkraften. Ein Server mit 1 GB kann
 *    nicht beliebig viele Leitungen offenhalten, und die Absage muss ehrlich
 *    sein statt eine tote Leitung.
 *  - Er darf **nichts festhalten**. Eine abgerissene Verbindung, die im
 *    Speicher bleibt, ist ein Leck, das erst nach Tagen auffällt.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventHub } from '../src/server/events.ts';
import type { Sink } from '../src/server/events.ts';

/** Eine Leitung zum Mitlesen. `dead` simuliert die abgerissene Gegenstelle. */
function recorder(): Sink & { lines: string[]; dead: boolean; closed: number } {
  const sink = {
    lines: [] as string[],
    dead: false,
    closed: 0,
    write(chunk: string) {
      if (sink.dead) return false;
      sink.lines.push(chunk);
      return true;
    },
    close() {
      sink.closed++;
    },
  };
  return sink;
}

/** Nur die Nutzlast der Anstöße — Herzschläge und Kommentare fallen weg. */
function nudges(sink: { lines: string[] }): string[] {
  return sink.lines
    .filter((l) => l.startsWith('event: nudge'))
    .map((l) => l.split('data: ')[1]!.trim());
}

test('ein Anstoß trägt kein einziges Datum aus dem Spiel', () => {
  const clock = { t: 0 };
  const hub = new EventHub({ minIntervalMs: 0, now: () => clock.t });
  const sink = recorder();
  hub.subscribe('hof-1', sink);

  hub.nudge('hof-1', 'farm');
  hub.broadcast('market');
  clock.t = 100;
  hub.flush();

  // Genau ein Anstoß, und darin steht nur, WAS sich geändert hat — keine
  // Menge, kein Preis, kein Zustand. Wer mitliest, erfährt nichts.
  assert.deepEqual(nudges(sink), ['farm,market']);
  for (const line of sink.lines) {
    assert.ok(!/\d{2,}/.test(line), `Zahl im Anstoß: ${line}`);
  }
});

test('zwanzig Änderungen in einer Sekunde sind ein Anstoß, nicht zwanzig', () => {
  // Die Rückkopplung, um die es geht: Jeder Kauf ändert das Buch, jede
  // Buchänderung stößt alle an, jeder Anstoß ist ein Sync, jeder Sync kann ein
  // Kauf sein. Ohne Bündelung wird daraus Dauerfeuer.
  const clock = { t: 0 };
  const hub = new EventHub({ minIntervalMs: 1000, now: () => clock.t });
  const sink = recorder();
  hub.subscribe('hof-1', sink);

  for (let i = 0; i < 20; i++) {
    hub.broadcast('market');
    clock.t += 10;
    hub.flush();
  }

  assert.deepEqual(nudges(sink), ['market']);

  // Nach dem Mindestabstand geht wieder einer raus — gebremst, nicht verstummt.
  clock.t += 1000;
  hub.broadcast('market');
  hub.flush();
  assert.deepEqual(nudges(sink), ['market', 'market']);
});

test('nichts zu melden heißt: nichts schicken', () => {
  const hub = new EventHub({ minIntervalMs: 0 });
  const sink = recorder();
  hub.subscribe('hof-1', sink);

  hub.flush();
  hub.flush();
  assert.deepEqual(sink.lines, []);
});

test('der Auslöser wird nicht angestoßen — er hält die Antwort schon in der Hand', () => {
  const hub = new EventHub({ minIntervalMs: 0 });
  const buyer = recorder();
  const other = recorder();
  hub.subscribe('kaeufer', buyer);
  hub.subscribe('anderer', other);

  hub.broadcast('market', 'kaeufer');
  hub.flush();

  assert.deepEqual(nudges(buyer), [], 'der Käufer syncte umsonst ein zweites Mal');
  assert.deepEqual(nudges(other), ['market']);
});

test('mehrere Geräte am selben Hof bekommen alle Bescheid', () => {
  // Der Fall, den man beim Bauen vergisst: ein Handy und ein offener Tab.
  const hub = new EventHub({ minIntervalMs: 0 });
  const handy = recorder();
  const tab = recorder();
  hub.subscribe('hof-1', handy);
  hub.subscribe('hof-1', tab);

  assert.equal(hub.countFor('hof-1'), 2);
  hub.nudge('hof-1', 'farm');
  hub.flush();

  assert.deepEqual(nudges(handy), ['farm']);
  assert.deepEqual(nudges(tab), ['farm']);
});

test('ist der Server voll, gibt es eine ehrliche Absage', () => {
  // Keine Leitung, die niemals etwas liefert: Der Client soll wissen, dass er
  // auf seinen Timer angewiesen ist.
  const hub = new EventHub({ maxSubscribers: 2 });
  assert.ok(hub.subscribe('a', recorder()));
  assert.ok(hub.subscribe('b', recorder()));
  assert.equal(hub.subscribe('c', recorder()), null);
  assert.equal(hub.size, 2);
});

test('eine abgerissene Leitung wird vergessen, nicht gehalten', () => {
  const hub = new EventHub({ minIntervalMs: 0 });
  const sink = recorder();
  hub.subscribe('hof-1', sink);

  sink.dead = true;
  hub.broadcast('market');
  hub.flush();

  assert.equal(hub.size, 0, 'tote Leitung hängt noch im Speicher');
  assert.equal(hub.countFor('hof-1'), 0);
});

test('der Herzschlag deckt auf, was längst weg ist', () => {
  // Ohne ihn hält der Server eine Leitung für offen, auf der nie wieder etwas
  // ankommt — und der Client wartet auf Anstöße, die nie kommen.
  const hub = new EventHub();
  const alive = recorder();
  const gone = recorder();
  hub.subscribe('a', alive);
  hub.subscribe('b', gone);
  gone.dead = true;

  hub.heartbeat();

  assert.equal(hub.size, 1);
  assert.deepEqual(alive.lines, [': ping\n\n']);
});

test('Abmelden ist idempotent und macht die Leitung zu', () => {
  const hub = new EventHub();
  const sink = recorder();
  const stop = hub.subscribe('hof-1', sink)!;

  stop();
  stop();
  assert.equal(hub.size, 0);
  assert.equal(sink.closed, 1, 'zweimal abmelden schließt zweimal');

  // Und ein Anstoß auf einen Hof ohne Leitung ist kein Fehler, sondern der
  // Normalfall: Die meisten Spieler sind offline.
  hub.nudge('hof-1', 'farm');
  hub.flush();
});

test('beim Herunterfahren gehen alle Leitungen zu', () => {
  // Sonst wartet `server.close()` auf Verbindungen, die per Konstruktion nie
  // von selbst enden — und systemd killt den Prozess nach dem Timeout.
  const hub = new EventHub();
  const a = recorder();
  const b = recorder();
  hub.subscribe('a', a);
  hub.subscribe('b', b);

  hub.closeAll();

  assert.equal(hub.size, 0);
  assert.equal(a.closed, 1);
  assert.equal(b.closed, 1);
});

test('tausend Leitungen kosten einen Rundlauf, keinen pro Anstoß', () => {
  // Die Zahl, um die es beim Skalieren geht: Ein Verkauf stößt ALLE an. Wenn
  // das teuer ist, ist der Markt bei tausend Spielern nicht mehr benutzbar.
  const hub = new EventHub({ minIntervalMs: 0, maxSubscribers: 4000 });
  const sinks = [];
  for (let i = 0; i < 1000; i++) {
    const sink = recorder();
    sinks.push(sink);
    hub.subscribe(`hof-${i}`, sink);
  }

  const started = process.hrtime.bigint();
  hub.broadcast('market', 'hof-0');
  hub.flush();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(nudges(sinks[0]!).length, 0);
  assert.equal(nudges(sinks[999]!).length, 1);
  assert.ok(ms < 50, `Rundlauf über 1000 Leitungen dauerte ${ms.toFixed(1)} ms`);
});
