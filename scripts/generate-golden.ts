/**
 * Generator für die Golden Vectors.
 *
 *   node --experimental-strip-types scripts/generate-golden.ts
 *
 * Erzeugt `test/vectors/golden.json`: einen Korpus aus expliziten Command-Logs
 * mit dem jeweils erwarteten Endzustand.
 *
 * WICHTIG — warum explizite Commands und keine Seeds:
 * Die Vektoren sollen von *jeder* Plattform abspielbar sein (iOS, Android,
 * WASM, Server). Ein Seed würde voraussetzen, dass dort derselbe PRNG bitgenau
 * dasselbe liefert — also genau die Annahme, die wir eigentlich prüfen wollen.
 * Deshalb steht jeder Command ausgeschrieben in der Datei.
 *
 * Neu erzeugen ist eine BEWUSSTE Handlung: Ändern sich die Vektoren, ohne dass
 * jemand die Regeln absichtlich geändert hat, ist das ein Determinismus-Bug.
 * Eine echte Regeländerung gehört in eine neue Ruleset-Version (R2), nicht in
 * überschriebene Golden Vectors.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from '../src/server/server.ts';
import { CURRENT_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { hashState } from '../src/sim/hash.ts';
import { mulberry32, playRandomSession } from '../test/helpers/session.ts';
import type { SessionOptions } from '../test/helpers/session.ts';

const T0 = 1_700_000_000_000;

const PROFILES: Array<{ name: string; opts: Omit<SessionOptions, 'fieldCount'>; seeds: number[] }> =
  [
    {
      name: 'busy',
      opts: { steps: 40, maxAdvance: 4000, advanceChance: 0.3, chaosChance: 0.25 },
      seeds: [1, 2, 3, 5, 8, 13, 21, 34, 55, 89],
    },
    {
      name: 'idle',
      opts: { steps: 20, maxAdvance: 20_000, advanceChance: 0.6, chaosChance: 0.1 },
      seeds: [1, 2, 3, 5, 8, 13, 21, 34, 55, 89],
    },
  ];

const vectors = [];

for (const profile of PROFILES) {
  for (const seed of profile.seeds) {
    const rnd = mulberry32(seed);
    const fieldCount = 1 + Math.floor(rnd() * 8);
    const server = new Server(initialState(fieldCount), T0, CURRENT_RULESET_VERSION);
    const client = playRandomSession(server.snapshot, rnd, { ...profile.opts, fieldCount });

    if (client.queue.length === 0) continue;

    vectors.push({
      name: `${profile.name}-${String(seed).padStart(3, '0')}`,
      fieldCount,
      commands: client.queue,
      expectedStateHash: hashState(client.state),
      expectedState: client.state,
    });
  }
}

const doc = {
  $comment:
    'Golden Vectors für den Sim-Kern. Jede Plattform (iOS, Android, WASM, Server) muss ' +
    'diesen Korpus abspielen und exakt dieselben Endzustände liefern. Abweichung = ' +
    'Determinismus-Bug (R1). Nicht von Hand bearbeiten — siehe scripts/generate-golden.ts.',
  rulesetVersion: CURRENT_RULESET_VERSION,
  vectorCount: vectors.length,
  vectors,
};

const outDir = join(import.meta.dirname, '..', 'test', 'vectors');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'golden.json'), JSON.stringify(doc, null, 2) + '\n');

const commandCount = vectors.reduce((n, v) => n + v.commands.length, 0);
console.log(`${vectors.length} Vektoren, ${commandCount} Commands → test/vectors/golden.json`);
