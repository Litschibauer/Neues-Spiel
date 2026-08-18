import { dirname, join } from 'node:path';
import { DEV_RULESET_VERSION, LATEST_RULESET_VERSION, RULESETS } from '../sim/rules.ts';

export type Env = 'dev' | 'prod';

export type TlsConfig = {
  certPath: string;
  keyPath: string;
  caPath: string | null;
};

export type Config = {
  env: Env;
  host: string;
  port: number;
  dbPath: string;
  savePath: string;
  tokenPath: string;
  rulesetVersion: number;
  adminEnabled: boolean;
  tls: TlsConfig | null;
  behindProxy: boolean;
  version: string;
};

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '[::1]';
}

export function isSecureTransport(cfg: Config): boolean {
  return cfg.tls !== null || cfg.behindProxy || isLoopback(cfg.host);
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Vars = Record<string, string | undefined>;

const DEFAULTS: Record<Env, { port: number; ruleset: number; admin: boolean; host: string }> = {
  dev: { port: 8788, ruleset: DEV_RULESET_VERSION, admin: true, host: '0.0.0.0' },
  prod: { port: 8787, ruleset: LATEST_RULESET_VERSION, admin: false, host: '127.0.0.1' },
};

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

  if (env === 'prod' && rulesetVersion === DEV_RULESET_VERSION) {
    throw new ConfigError(
      `Regelwerk v${DEV_RULESET_VERSION} ist das Entwicklungs-Tempo und in Produktion ` +
        'nicht zulässig. Es gibt auch keinen Weg zurück: Ein damit migrierter ' +
        'Spielstand behielte seine Sekundenzeiten.',
    );
  }

  const adminEnabled = toBool(vars.NEUES_SPIEL_ADMIN, preset.admin);

  const certPath = vars.NEUES_SPIEL_TLS_CERT?.trim() || undefined;
  const keyPath = vars.NEUES_SPIEL_TLS_KEY?.trim() || undefined;
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new ConfigError(
      'TLS ist nur halb angegeben. NEUES_SPIEL_TLS_CERT und NEUES_SPIEL_TLS_KEY ' +
        'gehören zusammen — beide setzen oder keins.',
    );
  }
  const tls: TlsConfig | null = certPath && keyPath
    ? { certPath, keyPath, caPath: vars.NEUES_SPIEL_TLS_CA?.trim() || null }
    : null;

  const host = vars.NEUES_SPIEL_HOST?.trim() || preset.host;
  const behindProxy = toBool(vars.NEUES_SPIEL_BEHIND_PROXY, false);

  if (env === 'prod' && !tls && !behindProxy && !isLoopback(host)) {
    throw new ConfigError(
      `Produktion würde auf ${host}:${port} im Klartext lauschen. Der Hof-Schlüssel ` +
        'reist in jedem Aufruf mit; wer ihn unterwegs mitliest, hat den Hof.\n' +
        '  Drei Wege:\n' +
        '    a) TLS-Endpunkt davor (Tailscale Serve, Caddy, nginx):\n' +
        '       NEUES_SPIEL_HOST=127.0.0.1 — oder NEUES_SPIEL_BEHIND_PROXY=1\n' +
        '    b) eigenes Zertifikat: NEUES_SPIEL_TLS_CERT=… NEUES_SPIEL_TLS_KEY=…\n' +
        '    c) nur lokal ausprobieren: NEUES_SPIEL_HOST=127.0.0.1',
    );
  }

  const dataDir = join(root, 'data', env);
  const savePath = vars.NEUES_SPIEL_SAVE ?? join(dataDir, 'save.json');

  return {
    env,
    host,
    port,

    dbPath: vars.NEUES_SPIEL_DB ?? join(dirname(savePath), 'spiel.db'),
    savePath,
    tokenPath: vars.NEUES_SPIEL_TOKEN_FILE ?? join(dataDir, 'token'),
    rulesetVersion,
    adminEnabled,
    tls,
    behindProxy,
    version: vars.NEUES_SPIEL_VERSION?.trim() || 'unbekannt',
  };
}

export function describeConfig(cfg: Config): string[] {
  const transport = cfg.tls
    ? `https://${cfg.host}:${cfg.port}  (eigenes Zertifikat)`
    : cfg.behindProxy
      ? `http://${cfg.host}:${cfg.port}  (hinter einem TLS-Endpunkt)`
      : `http://${cfg.host}:${cfg.port}`;

  const lines = [
    `Umgebung:    ${cfg.env.toUpperCase()}`,
    `Stand:       ${cfg.version}`,
    `Adresse:     ${transport}`,
    `Spielstände: ${cfg.dbPath}`,
    `Regelwerk:   v${cfg.rulesetVersion}`,
    `Werkbank:    ${cfg.adminEnabled ? '/admin' : 'aus'}`,
  ];
  if (cfg.env === 'prod' && cfg.adminEnabled) {
    lines.push('');
    lines.push('  ⚠  WERKBANK IN PRODUKTION AKTIV. Sie kann Gegenstände verschenken');
    lines.push('     und Zeit gutschreiben. Abschalten mit NEUES_SPIEL_ADMIN=0.');
  }

  if (!isSecureTransport(cfg)) {
    lines.push('');
    lines.push('  ⚠  Unverschlüsselt. Der Hof-Schlüssel reist im Klartext mit, und der');
    lines.push('     Service Worker registriert sich nicht — die App startet dann');
    lines.push('     nicht ohne Netz. Siehe docs/deploy.md, Abschnitt HTTPS.');
  }
  return lines;
}
