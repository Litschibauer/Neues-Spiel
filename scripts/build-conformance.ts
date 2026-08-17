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
 * In Abhängigkeitsreihenfolge. Der Prüfstand vergleicht über die kanonische
 * Form statt über einen Hash — sie ist ohnehin die eigentliche deterministische
 * Größe, und so bleibt der Bundle so klein wie möglich.
 */
const MODULES = ['rules.ts', 'state.ts', 'produce.ts', 'commands.ts', 'canonical.ts', 'sim.ts'];

/** Zusätzlich für den Feldtest: der echte Client, nicht ein nachgebauter. */
const CLIENT_MODULES = [
  'sim/rules.ts',
  'sim/state.ts',
  'sim/produce.ts',
  'sim/commands.ts',
  'sim/canonical.ts',
  'sim/sha256.ts',
  'sim/hash.ts',
  'sim/sim.ts',
  'client/client.ts',
  'client/sync-engine.ts',
  'client/persist.ts',
];

function toPlainJs(relativePath: string): string {
  const source = readFileSync(join(ROOT, 'src', relativePath), 'utf8');
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
    (f) => `// ── src/sim/${f} ${'─'.repeat(Math.max(0, 46 - f.length))}\n${toPlainJs('sim/' + f)}`,
  ).join('\n');

  // Kompakt einbetten: Der Korpus wird auf dem Testgerät gelesen, nicht von
  // Menschen. Die eingerückte Fassung bleibt in test/vectors/golden.json.
  const golden = JSON.stringify(
    JSON.parse(readFileSync(join(ROOT, 'test', 'vectors', 'golden.json'), 'utf8')),
  );

  return `/* Erzeugt von scripts/build-conformance.ts — nicht von Hand bearbeiten. */
(function () {
  'use strict';

${modules}

  var GOLDEN = ${golden};

  /**
   * Spielt jeden Golden Vector ab und vergleicht die kanonische Form des
   * Ergebnisses mit der hinterlegten. Kein Hash nötig: Der kanonische String
   * IST die deterministische Größe.
   *
   * Jeder Vektor bringt seine eigene Regelversion mit — der Korpus deckt alle
   * ausgelieferten Kataloge ab, nicht nur den ältesten.
   */
  function runVectors() {
    var results = [];

    for (var i = 0; i < GOLDEN.vectors.length; i++) {
      var v = GOLDEN.vectors[i];
      var actual, error = null;

      try {
        var rules = getRuleset(v.rulesetVersion);
        actual = canonicalize(simulateAll(v.startState, v.commands, rules));
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
      rulesetVersions: GOLDEN.rulesetVersions,
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

/**
 * Bundle für den Feldtest-Client: Sim-Kern PLUS der echte `Client` und die
 * echte `SyncEngine`. Kein nachgebautes Handy-Gegenstück — sonst prüfte der
 * Feldtest eine andere Implementierung als die, die später ausgeliefert wird.
 */
export function buildClientBundle(): string {
  const modules = CLIENT_MODULES.map(
    (f) => `// ── src/${f} ${'─'.repeat(Math.max(0, 44 - f.length))}\n${toPlainJs(f)}`,
  ).join('\n');

  return `/* Erzeugt von scripts/build-conformance.ts — nicht von Hand bearbeiten. */
(function () {
  'use strict';

${modules}

  globalThis.NeuesSpiel = {
    Client: Client,
    SyncEngine: SyncEngine,
    getRuleset: getRuleset,
    initialState: initialState,
    stored: stored,
    totalGoods: totalGoods,
    count: count,
    EMPTY_PLOT: EMPTY_PLOT,
    spaceLeft: spaceLeft,
    levelOf: levelOf,
    nextLevelAt: nextLevelAt,
    levelStartedAt: levelStartedAt,
    hashState: hashState,
    serializeClient: serializeClient,
    restoreClient: restoreClient,
    storageKeyFor: storageKeyFor,
  };
})();
`;
}

export function buildFieldTestPage(): string {
  return buildPageWithBundle('field-test.template.html');
}

/**
 * Die Spieloberfläche.
 *
 * Sie bekommt exakt dasselbe Bündel wie die Feldtest-Seite — denselben Sim-Kern,
 * denselben Client, dieselbe Sync-Maschine. Der Unterschied ist ausschließlich
 * die Darstellung. Zwei Oberflächen auf einem Kern sind dabei kein Luxus,
 * sondern ein Prüfmittel: Wer beide auf denselben Hof zeigt, sieht sofort, ob
 * die Sim wirklich die einzige Quelle der Wahrheit ist.
 */
export function buildFarmPage(): string {
  return buildPageWithBundle('farm.template.html');
}

function buildPageWithBundle(name: string): string {
  const template = readFileSync(join(ROOT, 'web', name), 'utf8');
  if (!template.includes('<!--BUNDLE-->')) {
    throw new Error(`Platzhalter <!--BUNDLE--> fehlt in ${name}`);
  }
  return template.replace('<!--BUNDLE-->', () => buildClientBundle());
}

/**
 * Das Admin-Panel braucht keinen Sim-Kern: Es ruft nur Serverendpunkte auf.
 * Genau so soll es sein — Eingriffe gehören auf die Serverseite, nicht in eine
 * zweite Simulation, die auseinanderlaufen könnte.
 */
export function buildAdminPage(): string {
  return readFileSync(join(ROOT, 'web', 'admin.template.html'), 'utf8');
}

/** Nur ausführen, wenn direkt gestartet — beim Import aus Tests nicht. */
if (process.argv[1] && process.argv[1].endsWith('build-conformance.ts')) {
  const outDir = join(ROOT, 'dist');
  mkdirSync(outDir, { recursive: true });

  const bundle = buildConformanceBundle();
  writeFileSync(join(outDir, 'conformance.bundle.js'), bundle);

  const page = buildConformancePage();
  writeFileSync(join(outDir, 'conformance.html'), page);

  const field = buildFieldTestPage();
  writeFileSync(join(outDir, 'field-test.html'), field);

  const farm = buildFarmPage();
  writeFileSync(join(outDir, 'farm.html'), farm);

  const admin = buildAdminPage();
  writeFileSync(join(outDir, 'admin.html'), admin);

  console.log(
    `Prüfstand ${(page.length / 1024).toFixed(1)} kB → dist/conformance.html\n` +
      `Spiel      ${(farm.length / 1024).toFixed(1)} kB → dist/farm.html\n` +
      `Feldtest   ${(field.length / 1024).toFixed(1)} kB → dist/field-test.html\n` +
      `Werkbank   ${(admin.length / 1024).toFixed(1)} kB → dist/admin.html`,
  );
}
