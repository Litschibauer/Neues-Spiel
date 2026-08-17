/**
 * Betriebsumgebungen: Entwicklung und Produktion.
 *
 * Zwei Umgebungen sind kein Komfort, sondern eine Sicherheitsmaßnahme. Ohne
 * sie testet man am echten Spielstand — und zwar genau dann, wenn man sich
 * sicher fühlt. Mit ihnen kann man live etwas ausprobieren, während die
 * Spielstände unangetastet nebenan weiterlaufen.
 *
 * Die Trennung ist vollständig: eigener Port, eigener Spielstand, eigenes
 * Token, eigenes Regelwerk. Nichts wird geteilt.
 *
 * ── Die drei Schutzriegel ───────────────────────────────────────────────────
 *
 *  1. **Die Umgebung muss man nennen.** Es gibt keinen Standardwert. Ein
 *     vergessenes Flag darf nie dazu führen, dass Produktion mit Dev-Regeln
 *     läuft — und andersherum genauso wenig.
 *  2. **Kein Dev-Regelwerk in Produktion.** Sekundenuhren auf echten
 *     Spielständen wären nicht rückgängig zu machen: Der Server startet gar
 *     nicht erst.
 *  3. **Kein Admin-Panel in Produktion**, außer man schaltet es ausdrücklich
 *     ein. Es kann Gegenstände verschenken und Zeit gutschreiben — in
 *     Produktion ist das eine offene Tür.
 */

import { join } from 'node:path';
import { DEV_RULESET_VERSION, LATEST_RULESET_VERSION, RULESETS } from '../sim/rules.ts';

export type Env = 'dev' | 'prod';

export type Config = {
  env: Env;
  port: number;
  savePath: string;
  tokenPath: string;
  /** Zielversion des Regelwerks — worauf der Server Snapshots hebt (R2). */
  rulesetVersion: number;
  adminEnabled: boolean;
  /** Welcher Stand hier läuft. Steht in `/health`, damit man es von außen sieht. */
  version: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Vars = Record<string, string | undefined>;

const DEFAULTS: Record<Env, { port: number; ruleset: number; admin: boolean }> = {
  // Dev: schnelle Uhren, Werkbank an, eigener Port.
  dev: { port: 8788, ruleset: DEV_RULESET_VERSION, admin: true },
  // Produktion: echte Zeiten, Werkbank aus.
  prod: { port: 8787, ruleset: LATEST_RULESET_VERSION, admin: false },
};

/** `--env=dev` oder `--env dev` aus der Kommandozeile lesen. */
function envFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--env=')) return arg.slice('--env='.length);
    if (arg === '--env') return argv[i + 1];
  }
  return undefined;
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * Baut die Konfiguration aus Flags und Umgebungsvariablen — ohne Dateizugriff,
 * damit sie sich testen lässt.
 *
 * Reihenfolge: ausdrücklich gesetzte Variable schlägt Umgebungs-Standard.
 */
export function resolveConfig(vars: Vars, argv: readonly string[], root: string): Config {
  const name = envFromArgv(argv) ?? vars.NEUES_SPIEL_ENV;
  if (name !== 'dev' && name !== 'prod') {
    throw new ConfigError(
      name === undefined
        ? 'Keine Umgebung angegeben. Erwartet: --env=dev oder --env=prod ' +
          '(npm run dev / npm run prod).'
        : `Unbekannte Umgebung "${name}". Erlaubt sind "dev" und "prod".`,
    );
  }

  const env: Env = name;
  const preset = DEFAULTS[env];

  const port = vars.PORT ? Number(vars.PORT) : preset.port;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`Ungültiger Port: ${vars.PORT}`);
  }

  const rulesetVersion = vars.NEUES_SPIEL_RULESET
    ? Number(vars.NEUES_SPIEL_RULESET)
    : preset.ruleset;
  if (!RULESETS.has(rulesetVersion)) {
    throw new ConfigError(`Unbekannte Regelversion: ${vars.NEUES_SPIEL_RULESET}`);
  }

  // Riegel 2: Sekundenuhren dürfen echte Spielstände nie erreichen.
  if (env === 'prod' && rulesetVersion === DEV_RULESET_VERSION) {
    throw new ConfigError(
      `Regelwerk v${DEV_RULESET_VERSION} ist das Entwicklungs-Tempo und in Produktion ` +
        'nicht zulässig. Es gibt auch keinen Weg zurück: Ein damit migrierter ' +
        'Spielstand behielte seine Sekundenzeiten.',
    );
  }

  // Riegel 3: Werkbank in Produktion nur auf ausdrücklichen Wunsch.
  const adminEnabled = toBool(vars.NEUES_SPIEL_ADMIN, preset.admin);

  const dataDir = join(root, 'data', env);

  return {
    env,
    port,
    savePath: vars.NEUES_SPIEL_SAVE ?? join(dataDir, 'save.json'),
    tokenPath: vars.NEUES_SPIEL_TOKEN_FILE ?? join(dataDir, 'token'),
    rulesetVersion,
    adminEnabled,
    version: vars.NEUES_SPIEL_VERSION?.trim() || 'unbekannt',
  };
}

/** Was beim Start im Log stehen soll — einmal alles, damit nichts zu raten bleibt. */
export function describeConfig(cfg: Config): string[] {
  const lines = [
    `Umgebung:   ${cfg.env.toUpperCase()}`,
    `Stand:      ${cfg.version}`,
    `Port:       ${cfg.port}`,
    `Spielstand: ${cfg.savePath}`,
    `Regelwerk:  v${cfg.rulesetVersion}`,
    `Werkbank:   ${cfg.adminEnabled ? '/admin' : 'aus'}`,
  ];
  if (cfg.env === 'prod' && cfg.adminEnabled) {
    lines.push('');
    lines.push('  ⚠  WERKBANK IN PRODUKTION AKTIV. Sie kann Gegenstände verschenken');
    lines.push('     und Zeit gutschreiben. Abschalten mit NEUES_SPIEL_ADMIN=0.');
  }
  return lines;
}
