import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig, ConfigError } from '../src/server/config.ts';

const ROOT = join(import.meta.dirname, '..');

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

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = join(targetDir, `spiel-${config.env}-${stamp}.db`);

const started = Date.now();
const db = new DatabaseSync(config.dbPath, { readOnly: true });
try {
  db.exec(`vacuum into '${target.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

const bytes = statSync(target).size;
console.log(
  `Gesichert: ${target} (${(bytes / 1024 / 1024).toFixed(1)} MB, ${Date.now() - started} ms)`,
);

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
    console.warn('Hinweis: Die Sicherung enthält keine Höfe.');
  }
} finally {
  check.close();
}

const older = readdirSync(targetDir)
  .filter((n) => n.startsWith(`spiel-${config.env}-`) && n.endsWith('.db'))
  .sort()
  .reverse()
  .slice(KEEP);

for (const name of older) rmSync(join(targetDir, name), { force: true });
if (older.length > 0) console.log(`${older.length} alte Sicherung(en) entfernt, ${KEEP} behalten.`);
