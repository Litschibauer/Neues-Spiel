/**
 * Sicherung der Spielstände — bei laufendem Server.
 *
 *   node --experimental-strip-types scripts/backup.ts --env=prod [ziel]
 *
 * ── Warum nicht einfach `cp` ────────────────────────────────────────────────
 *
 * Weil die Datenbank im WAL-Modus läuft. Ein `cp` der `.db`-Datei erwischt
 * einen Stand OHNE die Änderungen, die noch im `-wal` stehen — und wer beide
 * kopiert, erwischt sie zu verschiedenen Zeitpunkten. Das Ergebnis sieht heil
 * aus und ist es nicht; auffallen würde es erst beim Zurückspielen, also im
 * denkbar schlechtesten Moment.
 *
 * `VACUUM INTO` schreibt dagegen einen in sich stimmigen Stand in eine neue
 * Datei, während der Server weiterläuft. Kein Anhalten, kein Wartungsfenster.
 *
 * ── Warum kein `sqlite3` ────────────────────────────────────────────────────
 *
 * Das wäre der übliche Weg — aber es ist ein Werkzeug, das auf einem frischen
 * Server nicht liegt, und eine Sicherung, die an einer fehlenden Installation
 * scheitert, ist keine. Node bringt SQLite mit; damit läuft das hier überall,
 * wo auch der Server läuft.
 *
 * ── Was hier NICHT passiert ─────────────────────────────────────────────────
 *
 * Keine Kopie außer Haus. Eine Sicherung auf derselben Platte hilft gegen einen
 * Bedienfehler, nicht gegen einen kaputten Server. Der Weg nach außen —
 * `rsync`, ein Objektspeicher, was auch immer — gehört hinter diesen Aufruf und
 * hängt davon ab, wohin.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig, ConfigError } from '../src/server/config.ts';

const ROOT = join(import.meta.dirname, '..');

/** Wie viele Sicherungen aufgehoben werden. Ältere fliegen raus. */
const KEEP = Number(process.env.NEUES_SPIEL_BACKUP_KEEP ?? 14);

let config;
try {
  config = resolveConfig(process.env, process.argv.slice(2), ROOT);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`\nSicherung abgebrochen: ${err.message}\n`);
  process.exit(1);
}

if (!existsSync(config.dbPath)) {
  console.error(`Keine Datenbank unter ${config.dbPath} — nichts zu sichern.`);
  process.exit(1);
}

const targetDir =
  process.argv.find((a) => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]) ??
  process.env.NEUES_SPIEL_BACKUP_DIR ??
  join(ROOT, 'backups', config.env);
mkdirSync(targetDir, { recursive: true });

// Zeitstempel als Dateiname: sortiert sich von allein richtig, und man sieht
// auf einen Blick, wie alt der Stand ist.
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = join(targetDir, `spiel-${config.env}-${stamp}.db`);

const started = Date.now();
const db = new DatabaseSync(config.dbPath, { readOnly: true });
try {
  // Der eigentliche Vorgang. Ein Aufruf, konsistent, ohne den Server anzuhalten.
  db.exec(`vacuum into '${target.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

const bytes = statSync(target).size;
console.log(
  `Gesichert: ${target} (${(bytes / 1024 / 1024).toFixed(1)} MB, ${Date.now() - started} ms)`,
);

/**
 * Nachprüfen, statt zu hoffen.
 *
 * Eine Sicherung, die niemand je geöffnet hat, ist eine Vermutung. Der
 * Integritätstest kostet Sekundenbruchteile und ist der Unterschied zwischen
 * „wir haben Sicherungen" und „wir haben Sicherungen, die funktionieren".
 */
const check = new DatabaseSync(target, { readOnly: true });
try {
  const result = check.prepare('pragma integrity_check').get() as { integrity_check?: string };
  if (result.integrity_check !== 'ok') {
    console.error(`Sicherung ist beschädigt: ${result.integrity_check}`);
    process.exit(1);
  }
  const farms = (check.prepare('select count(*) as n from accounts').get() as { n: number }).n;
  console.log(`Geprüft: in Ordnung, ${farms} Höfe enthalten.`);
  if (farms === 0) {
    // Kein Fehler — ein frischer Server hat eben keine. Sagen sollte man es
    // trotzdem, sonst sichert jemand monatelang beruhigt eine leere Datei.
    console.warn('Hinweis: Die Sicherung enthält keine Höfe.');
  }
} finally {
  check.close();
}

// ── Aufräumen ────────────────────────────────────────────────────────────
const older = readdirSync(targetDir)
  .filter((n) => n.startsWith(`spiel-${config.env}-`) && n.endsWith('.db'))
  .sort()
  .reverse()
  .slice(KEEP);

for (const name of older) rmSync(join(targetDir, name), { force: true });
if (older.length > 0) console.log(`${older.length} alte Sicherung(en) entfernt, ${KEEP} behalten.`);
