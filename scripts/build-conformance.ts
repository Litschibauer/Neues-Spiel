/**
 * Baut den Konformitäts-Bundle für den Plattform-Beweis.
 *
 *   node --experimental-strip-types scripts/build-conformance.ts
 *
 * Erzeugt eine einzelne JS-Datei, die den Sim-Kern und die Golden Vectors
 * enthält und in JEDER JS-Runtime läuft — insbesondere in Safari auf iPhone
 * und iPad, das mit JavaScriptCore eine völlig andere Engine benutzt als das
 * V8 hier. Genau dieser Engine-Wechsel ist der Test.
 *
 * Wichtig: Der Bundle wird NICHT von Hand nachgebaut, sondern aus denselben
 * Quelldateien erzeugt, die auch Client und Server benutzen. Ein nachgebauter
 * Sim-Kern würde exakt das Risiko einführen, das hier geprüft werden soll.
 *
 * Die Typen entfernt Nodes eigener Stripper — derselbe, der die Dateien auch
 * zur Laufzeit verarbeitet.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = join(import.meta.dirname, '..');
const SIM = join(ROOT, 'src', 'sim');

/**
 * In Abhängigkeitsreihenfolge. `hash.ts` fehlt bewusst: Es braucht
 * `node:crypto`. Verglichen wird deshalb über die kanonische Form aus
 * `canonical.ts`, die ohne jede Plattform-API auskommt — und die ohnehin die
 * eigentliche deterministische Größe ist.
 */
const MODULES = ['rules.ts', 'state.ts', 'produce.ts', 'commands.ts', 'canonical.ts', 'sim.ts'];

function toPlainJs(file: string): string {
  const source = readFileSync(join(SIM, file), 'utf8');
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' });

  return (
    stripped
      // Alles liegt gleich in einem Scope — Importe sind damit gegenstandslos.
      .replace(/^import\b[\s\S]*?;[ \t]*$/gm, '')
      // `export` vor Deklarationen entfernen, Deklaration behalten.
      .replace(/^export\s+(?=(?:function|const|let|var|class|async)\b)/gm, '')
      .replace(/^export\s*\{[^}]*\}\s*;?[ \t]*$/gm, '')
  );
}

export function buildConformanceBundle(): string {
  const modules = MODULES.map(
    (f) => `// ── src/sim/${f} ${'─'.repeat(Math.max(0, 46 - f.length))}\n${toPlainJs(f)}`,
  ).join('\n');

  const golden = readFileSync(join(ROOT, 'test', 'vectors', 'golden.json'), 'utf8');

  return `/* Erzeugt von scripts/build-conformance.ts — nicht von Hand bearbeiten. */
(function () {
  'use strict';

${modules}

  var GOLDEN = ${golden.trim()};

  /**
   * Spielt jeden Golden Vector ab und vergleicht die kanonische Form des
   * Ergebnisses mit der hinterlegten. Kein Hash nötig: Der kanonische String
   * IST die deterministische Größe.
   */
  function runVectors() {
    var rules = getRuleset(GOLDEN.rulesetVersion);
    var results = [];

    for (var i = 0; i < GOLDEN.vectors.length; i++) {
      var v = GOLDEN.vectors[i];
      var actual, error = null;

      try {
        actual = canonicalize(simulateAll(initialState(v.fieldCount), v.commands, rules));
      } catch (e) {
        error = String((e && e.message) || e);
      }

      var expected = canonicalize(v.expectedState);
      results.push({
        name: v.name,
        commands: v.commands.length,
        pass: error === null && actual === expected,
        error: error,
        actual: actual,
        expected: expected,
      });
    }

    return {
      rulesetVersion: GOLDEN.rulesetVersion,
      total: results.length,
      passed: results.filter(function (r) { return r.pass; }).length,
      results: results,
    };
  }

  globalThis.NeuesSpielConformance = { runVectors: runVectors, golden: GOLDEN };
})();
`;
}

/**
 * Setzt den Bundle in die Prüfstand-Seite ein.
 *
 * Die Seite ist bewusst vollständig eigenständig: Sim-Kern und Vektoren stecken
 * darin, es gibt keinen einzigen Netzwerkzugriff. Nur so ist sichergestellt,
 * dass auf dem Testgerät wirklich dieser Code lief.
 */
export function buildConformancePage(): string {
  const template = readFileSync(join(ROOT, 'web', 'conformance.template.html'), 'utf8');
  if (!template.includes('<!--BUNDLE-->')) {
    throw new Error('Platzhalter <!--BUNDLE--> fehlt in der Vorlage');
  }
  // Kein String-Replace mit Sonderzeichen-Fallen: Der Bundle enthält `$&`-artige
  // Zeichenfolgen nicht, aber die Funktionsform ist ohnehin die sichere.
  return template.replace('<!--BUNDLE-->', () => buildConformanceBundle());
}

/** Nur ausführen, wenn direkt gestartet — beim Import aus Tests nicht. */
if (process.argv[1] && process.argv[1].endsWith('build-conformance.ts')) {
  const outDir = join(ROOT, 'dist');
  mkdirSync(outDir, { recursive: true });

  const bundle = buildConformanceBundle();
  writeFileSync(join(outDir, 'conformance.bundle.js'), bundle);

  const page = buildConformancePage();
  writeFileSync(join(outDir, 'conformance.html'), page);

  console.log(
    `Bundle ${(bundle.length / 1024).toFixed(1)} kB · Seite ${(page.length / 1024).toFixed(1)} kB ` +
      `→ dist/conformance.html`,
  );
}
