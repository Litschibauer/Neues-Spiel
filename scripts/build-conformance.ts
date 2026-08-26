import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = join(import.meta.dirname, '..');
const SIM = join(ROOT, 'src', 'sim');

const MODULES = ['rules.ts', 'state.ts', 'produce.ts', 'commands.ts', 'canonical.ts', 'sim.ts'];

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
  'client/view.ts',
];

function toPlainJs(relativePath: string): string {
  const source = readFileSync(join(ROOT, 'src', relativePath), 'utf8');
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' });

  return (
    stripped

      .replace(/^import\b[\s\S]*?;[ \t]*$/gm, '')

      .replace(/^export\s+(?=(?:function|const|let|var|class|async)\b)/gm, '')
      .replace(/^export\s*\{[^}]*\}\s*;?[ \t]*$/gm, '')
  );
}

export function buildConformanceBundle(): string {
  const modules = MODULES.map(
    (f) => `// ── src/sim/${f} ${'─'.repeat(Math.max(0, 46 - f.length))}\n${toPlainJs('sim/' + f)}`,
  ).join('\n');

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

export function buildConformancePage(): string {
  const template = readFileSync(join(ROOT, 'web', 'conformance.template.html'), 'utf8');
  if (!template.includes('<!--BUNDLE-->')) {
    throw new Error('Platzhalter <!--BUNDLE--> fehlt in der Vorlage');
  }

  return template.replace('<!--BUNDLE-->', () => buildConformanceBundle());
}

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
    // Die Einstellgebühr rechnet die Oberfläche mit derselben Funktion wie die
    // Sim — sonst wäre der angezeigte Preis irgendwann ein anderer als der
    // bezahlte.
    listingFee: listingFee,
    serializeClient: serializeClient,
    restoreClient: restoreClient,
    storageKeyFor: storageKeyFor,
    farmView: farmView,
    sizeOf: sizeOf,
    freischaltungenAb: freischaltungenAb,
  };
})();
`;
}

export function buildFieldTestPage(): string {
  return buildPageWithBundle('field-test.template.html');
}

export function buildFarmPage(): string {
  return buildPageWithBundle('farm/page.html');
}

const ICON_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export function buildIcons(): string {
  const dir = join(ROOT, 'web', 'farm', 'icons');
  if (!existsSync(dir)) return 'var ICONS = {};';

  const eintraege: string[] = [];
  for (const datei of readdirSync(dir).sort()) {
    const punkt = datei.lastIndexOf('.');
    if (punkt <= 0) continue;
    const endung = datei.slice(punkt).toLowerCase();
    const mime = ICON_MIME[endung];
    if (!mime) continue;

    const name = datei.slice(0, punkt);
    const daten = readFileSync(join(dir, datei)).toString('base64');
    eintraege.push(`  ${JSON.stringify(name)}: 'data:${mime};base64,${daten}'`);
  }

  return `var ICONS = {\n${eintraege.join(',\n')}\n};`;
}

function resolveIncludes(template: string, depth = 0): string {
  if (depth > 5) throw new Error('INCLUDE zu tief verschachtelt');
  return template.replace(/^([ \t]*)<!--INCLUDE:([^>]+?)-->[ \t]*$/gm, (_all, indent, file) => {
    const path = join(ROOT, 'web', String(file).trim());
    if (!existsSync(path)) throw new Error(`INCLUDE nicht gefunden: ${file}`);
    const body = readFileSync(path, 'utf8').replace(/\n+$/, '');
    return resolveIncludes(
      body
        .split('\n')
        .map((line) => (line === '' ? '' : indent + line))
        .join('\n'),
      depth + 1,
    );
  });
}

function buildPageWithBundle(name: string): string {
  const template = resolveIncludes(readFileSync(join(ROOT, 'web', name), 'utf8'));
  if (!template.includes('<!--BUNDLE-->')) {
    throw new Error(`Platzhalter <!--BUNDLE--> fehlt in ${name}`);
  }
  return template
    .replace('<!--BUNDLE-->', () => buildClientBundle())
    .replace('<!--ICONS-->', () => buildIcons());
}

export function buildAdminPage(): string {
  return readFileSync(join(ROOT, 'web', 'admin.template.html'), 'utf8');
}

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
