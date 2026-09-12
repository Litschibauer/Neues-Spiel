import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Alle Module der Oberfläche landen in EINER Funktion (page.html bindet sie
// per INCLUDE ein). Zwei Dateien, die dieselbe Funktion oder Variable oben
// deklarieren, überschreiben sich still — die spätere gewinnt. So rief der
// Klang-Abspieler einmal den Musik-Player auf und der lud in Endlosschleife
// /musik/undefined. Dieser Test findet das, bevor es ein Gerät tut.

const DIR = join(import.meta.dirname, '..', 'web', 'farm');

test('kein Name wird in zwei Oberflächen-Modulen oben deklariert', () => {
  const wo = new Map<string, string[]>();
  for (const datei of readdirSync(DIR).filter((d) => d.endsWith('.js')).sort()) {
    const quelle = readFileSync(join(DIR, datei), 'utf8');
    for (const m of quelle.matchAll(/^(?:function|var|let|const)\s+([A-Za-z_$][\w$]*)/gm)) {
      const liste = wo.get(m[1]!) ?? [];
      if (!liste.includes(datei)) liste.push(datei);
      wo.set(m[1]!, liste);
    }
  }
  const doppelt = [...wo].filter(([, dateien]) => dateien.length > 1).map(([name, dateien]) => `${name} (${dateien.join(', ')})`);
  assert.deepEqual(doppelt, [], 'doppelt deklariert');
});
