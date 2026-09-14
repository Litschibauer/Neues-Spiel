import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOFZEIT_EPOCHE, HOFTAG_S, HOFSTUNDE_S, HOFMONAT_S, HOFJAHRESZEIT_S, HOFJAHR_S, TAGE_JE_JAHR, TAGE_JE_MONAT,
  MONATE, hofzeit, tickVon, dauer, dauerInHofzeit, hofminuten, imFenster, fensterBeginn, ZEITFENSTER,
  hoftagGrenzen, hofmonatGrenzen, jahreszeitGrenzen, hofjahrGrenzen, EREIGNISSE, ereignis, laeuft,
  verbleibendBisBeginn, verbleibendBisEnde,
} from '../src/sim/zeit.ts';
import { wocheVonTag } from '../src/sim/state.ts';
import { wochentagVon } from '../src/sim/rules.ts';

test('die Epoche: Frühfrühling, Jahr 1, Tag 1, 00:00 — Montag, 14. September 2026, UTC', () => {
  assert.equal(new Date(HOFZEIT_EPOCHE * 1000).toISOString(), '2026-09-14T00:00:00.000Z');
  const z = hofzeit(HOFZEIT_EPOCHE);
  assert.equal(z.jahr, 1);
  assert.equal(z.monat, 0);
  assert.equal(z.monatName, 'Frühfrühling');
  assert.equal(z.tag, 1);
  assert.equal(z.stunde, 0);
  assert.equal(z.minute, 0);
  assert.equal(z.jahreszeitName, 'Frühling');
  assert.equal(z.abschnittName, 'früh');
  assert.equal(z.tagesphase, 'nacht', 'um Mitternacht ist Nacht');
});

test('Tempo: ein Hoftag ist eine echte Stunde, eine Hofstunde 150 Sekunden', () => {
  assert.equal(HOFTAG_S, 3600);
  assert.equal(HOFSTUNDE_S, 150);
  assert.equal(hofzeit(HOFZEIT_EPOCHE + 3600).tag, 2);
  assert.equal(hofzeit(HOFZEIT_EPOCHE + 3599).tag, 1);
  assert.equal(hofzeit(HOFZEIT_EPOCHE + 150 * 6).stunde, 6);
  assert.equal(hofzeit(HOFZEIT_EPOCHE + 150 * 6).tagesphase, 'tag', 'um 6 Uhr wird es Tag');
  assert.equal(hofzeit(HOFZEIT_EPOCHE + 150 * 19).tagesphase, 'nacht', 'um 19 Uhr wird es Nacht');
  assert.equal(hofzeit(HOFZEIT_EPOCHE + 150 * 19 - 1).tagesphase, 'tag');
  assert.equal(hofminuten(60), 150, '60 Hofminuten sind eine Hofstunde');
  assert.equal(hofminuten(1), 3, 'eine Hofminute sind 2,5 Sekunden — gerundet auf 3');
  assert.equal(hofminuten(2), 5);
});

test('Monat 31 Tage, Jahreszeit 3 Monate, Jahr 12 Monate = 372 Tage', () => {
  assert.equal(TAGE_JE_MONAT, 31);
  assert.equal(TAGE_JE_JAHR, 372);
  assert.equal(HOFMONAT_S, 31 * 3600);
  assert.equal(HOFJAHRESZEIT_S, 93 * 3600);
  assert.equal(HOFJAHR_S, 372 * 3600);
  assert.equal(MONATE.length, 12);
  const t31 = hofzeit(HOFZEIT_EPOCHE + 30 * HOFTAG_S);
  assert.equal(t31.tag, 31);
  assert.equal(t31.monat, 0);
  const m2 = hofzeit(HOFZEIT_EPOCHE + 31 * HOFTAG_S);
  assert.equal(m2.tag, 1);
  assert.equal(m2.monatName, 'Frühling');
  assert.equal(m2.abschnittName, 'mitte');
  const j2 = hofzeit(HOFZEIT_EPOCHE + HOFJAHR_S);
  assert.equal(j2.jahr, 2);
  assert.equal(j2.monat, 0);
  assert.equal(j2.tag, 1);
  assert.equal(hofzeit(HOFZEIT_EPOCHE + HOFJAHR_S - 1).jahr, 1);
});

test('Jahreszeiten und Abschnitte reihum: früh, mitte, spät je Jahreszeit', () => {
  const folge = [];
  for (let m = 0; m < 12; m++) {
    const z = hofzeit(HOFZEIT_EPOCHE + m * HOFMONAT_S);
    folge.push(z.jahreszeitName + '/' + z.abschnittName);
  }
  assert.deepEqual(folge, [
    'Frühling/früh', 'Frühling/mitte', 'Frühling/spät',
    'Sommer/früh', 'Sommer/mitte', 'Sommer/spät',
    'Herbst/früh', 'Herbst/mitte', 'Herbst/spät',
    'Winter/früh', 'Winter/mitte', 'Winter/spät',
  ]);
  assert.equal(hofzeit(HOFZEIT_EPOCHE + 5 * HOFMONAT_S + 3).monatName, 'Spätsommer');
});

test('vor der Epoche: Jahr 0 und tiefer, Kalender bleibt stimmig', () => {
  const vorher = hofzeit(HOFZEIT_EPOCHE - 1);
  assert.equal(vorher.jahr, 0);
  assert.equal(vorher.monatName, 'Spätwinter');
  assert.equal(vorher.tag, 31);
  assert.equal(vorher.stunde, 23);
  assert.equal(vorher.minute, 59);
  const langVorher = hofzeit(HOFZEIT_EPOCHE - 2 * HOFJAHR_S - HOFTAG_S);
  assert.equal(langVorher.jahr, -2);
  assert.equal(langVorher.tag, 31);
  assert.equal(langVorher.monatName, 'Spätwinter');
});

test('Hin und zurück: Tick → Kalender → Tick ohne Abweichung, auch in fernen Jahren', () => {
  const proben = [HOFZEIT_EPOCHE, HOFZEIT_EPOCHE - 1, HOFZEIT_EPOCHE + 12345 * 150, HOFZEIT_EPOCHE + 1000 * HOFJAHR_S + 5 * HOFMONAT_S + 17 * HOFTAG_S + 13 * HOFSTUNDE_S,
    HOFZEIT_EPOCHE - 77 * HOFJAHR_S - 3 * HOFTAG_S - 150];
  for (const t of proben) {
    const z = hofzeit(t);
    const zurueck = tickVon({ jahr: z.jahr, monat: z.monat, tag: z.tag, stunde: z.stunde, minute: z.minute });
    // Minuten sind auf 2,5 s gerastert: die Abweichung ist höchstens zwei Sekunden.
    assert.ok(Math.abs(zurueck - t) <= 2, `${t} → ${JSON.stringify([z.jahr, z.monat, z.tag, z.stunde, z.minute])} → ${zurueck}`);
    assert.equal(hofzeit(zurueck).minute, z.minute);
  }
  assert.equal(tickVon({ jahr: 1, monat: 0, tag: 1 }), HOFZEIT_EPOCHE);
  assert.equal(tickVon({ jahr: 2, monat: 0, tag: 1 }), HOFZEIT_EPOCHE + HOFJAHR_S);
  assert.equal(tickVon({ jahr: 1, monat: 3, tag: 1 }), HOFZEIT_EPOCHE + HOFJAHRESZEIT_S);
});

test('Dauern: rechnen und zerlegen, ohne Kalender', () => {
  assert.equal(dauer({ tage: 1 }), HOFTAG_S);
  assert.equal(dauer({ jahre: 1 }), HOFJAHR_S);
  assert.equal(dauer({ monate: 2, tage: 3, stunden: 4, minuten: 30 }), 2 * HOFMONAT_S + 3 * HOFTAG_S + 4 * HOFSTUNDE_S + 75);
  const a = dauer({ tage: 2 }) + dauer({ stunden: 5 });
  const b = a - dauer({ stunden: 2 });
  assert.deepEqual(dauerInHofzeit(b), { tage: 2, stunden: 3, minuten: 0 });
  assert.deepEqual(dauerInHofzeit(HOFSTUNDE_S + 75), { tage: 0, stunden: 1, minuten: 30 });
  assert.deepEqual(dauerInHofzeit(-5), { tage: 0, stunden: 0, minuten: 0 });
});

test('Grenzen: Beginn einschließlich, Ende ausschließlich — Tag, Monat, Jahreszeit, Jahr', () => {
  const t = HOFZEIT_EPOCHE + 5 * HOFMONAT_S + 17 * HOFTAG_S + 999;
  const tag = hoftagGrenzen(t);
  assert.equal(tag.beginn, HOFZEIT_EPOCHE + 5 * HOFMONAT_S + 17 * HOFTAG_S);
  assert.equal(tag.ende, tag.beginn + HOFTAG_S);
  assert.equal(hofmonatGrenzen(t).beginn, HOFZEIT_EPOCHE + 5 * HOFMONAT_S);
  assert.equal(jahreszeitGrenzen(t).beginn, HOFZEIT_EPOCHE + 3 * HOFMONAT_S, 'Sommer beginnt mit Monat 4');
  assert.equal(jahreszeitGrenzen(t).ende, HOFZEIT_EPOCHE + 6 * HOFMONAT_S);
  assert.equal(hofjahrGrenzen(t).beginn, HOFZEIT_EPOCHE);
  assert.equal(hofjahrGrenzen(HOFZEIT_EPOCHE - 1).beginn, HOFZEIT_EPOCHE - HOFJAHR_S, 'auch vor der Epoche');
  assert.equal(hofzeit(hofmonatGrenzen(t).ende).tag, 1);
});

test('Zeitfenster über Mitternacht: 21:00–05:00 gilt um 23 Uhr und um 3 Uhr, nicht um 12', () => {
  const f = ZEITFENSTER.tiefeNacht!;
  assert.equal(imFenster(23 * 60, f), true);
  assert.equal(imFenster(3 * 60, f), true);
  assert.equal(imFenster(21 * 60, f), true, 'Beginn einschließlich');
  assert.equal(imFenster(5 * 60, f), false, 'Ende ausschließlich');
  assert.equal(imFenster(12 * 60, f), false);
  assert.equal(imFenster(6 * 60, ZEITFENSTER.tag!), true);
  assert.equal(imFenster(19 * 60, ZEITFENSTER.tag!), false);
  assert.equal(imFenster(19 * 60, ZEITFENSTER.nacht!), true);
  assert.equal(imFenster(-60, ZEITFENSTER.nacht!), true, 'negative Minuten wickeln um: 23 Uhr');
  // Beginn des Fensters: läuft es, ist es der laufende Beginn — auch von gestern.
  const um3 = HOFZEIT_EPOCHE + 3 * HOFSTUNDE_S;
  assert.equal(fensterBeginn(um3, f), HOFZEIT_EPOCHE - 3 * HOFSTUNDE_S, 'um 3 Uhr begann die tiefe Nacht gestern um 21');
  const um12 = HOFZEIT_EPOCHE + 12 * HOFSTUNDE_S;
  assert.equal(fensterBeginn(um12, f), HOFZEIT_EPOCHE + 21 * HOFSTUNDE_S, 'um 12 kommt sie heute um 21');
});

test('Ereignisse: Nacht, Hoftag, Monat, Jahreszeit nach Hofzeit; Tag und Woche nach Echtzeit', () => {
  const t = HOFZEIT_EPOCHE + 12 * HOFSTUNDE_S; // Tag 1, 12 Uhr
  const nacht = ereignis('nacht')!;
  assert.equal(nacht.quelle, 'hofzeit');
  assert.equal(laeuft(nacht, t), false);
  assert.equal(verbleibendBisBeginn(nacht, t), 7 * HOFSTUNDE_S, 'um 12 Uhr sind es sieben Hofstunden bis 19');
  const inDerNacht = HOFZEIT_EPOCHE + 22 * HOFSTUNDE_S;
  assert.equal(laeuft(nacht, inDerNacht), true);
  assert.equal(verbleibendBisEnde(nacht, inDerNacht), 8 * HOFSTUNDE_S, 'um 22 Uhr sind es acht Stunden bis 6');
  assert.equal(verbleibendBisBeginn(ereignis('jahreszeit')!, t), HOFJAHRESZEIT_S - 12 * HOFSTUNDE_S, 'bis zum Sommer');
  assert.equal(hofzeit(ereignis('hofmonat')!.naechstes(t).beginn).tag, 1, 'der nächste Monatswechsel ist ein Erster');
  assert.equal(laeuft(ereignis('hofjahr')!, t), false, 'ein Wechsel läuft nicht, er kommt');
  assert.equal(verbleibendBisBeginn(ereignis('hoftag')!, HOFZEIT_EPOCHE), HOFTAG_S, 'genau am Wechsel: der nächste ist ein Tag entfernt');

  const woche = ereignis('serverwoche')!;
  assert.equal(woche.quelle, 'echtzeit');
  const a = woche.naechstes(t);
  assert.equal(wochentagVon(Math.floor(a.beginn / 86_400)), 0, 'die Woche beginnt am Montag');
  assert.equal(a.beginn, HOFZEIT_EPOCHE + 7 * 86_400, 'die Epoche ist ein Montag 00:00 UTC — der nächste Wechsel eine Woche später');
  assert.equal(wocheVonTag(Math.floor(a.beginn / 86_400)), wocheVonTag(Math.floor(t / 86_400)) + 1);
  const tag = ereignis('servertag')!;
  assert.equal(tag.naechstes(t).beginn, HOFZEIT_EPOCHE + 86_400);
  assert.ok(EREIGNISSE.every((e) => e.quelle === 'hofzeit' || e.quelle === 'echtzeit'));
});

test('unabhängig von der Zeitzone des Rechners: reine Ganzzahlarithmetik, keine Date-Aufrufe', async () => {
  const { readFileSync } = await import('node:fs');
  const quelle = readFileSync(new URL('../src/sim/zeit.ts', import.meta.url), 'utf8');
  assert.ok(!/new Date|Date\.now|getTimezoneOffset|toLocale/.test(quelle), 'zeit.ts kennt keine Uhr und keine Zeitzone');
});
