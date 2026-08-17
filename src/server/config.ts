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
 *  4. **Produktion nicht im Klartext ins Netz.** Der Hof-Schlüssel reist in
 *     jedem einzelnen Aufruf mit. Über einfaches HTTP liest ihn jedes Netz
 *     dazwischen mit — und wer ihn hat, hat den Hof, denn es gibt kein
 *     Passwort daneben. Also: entweder eigenes Zertifikat, oder ausdrücklich
 *     gesagt, dass etwas anderes TLS beendet, oder nur auf localhost lauschen.
 */

import { dirname, join } from 'node:path';
import { DEV_RULESET_VERSION, LATEST_RULESET_VERSION, RULESETS } from '../sim/rules.ts';

export type Env = 'dev' | 'prod';

/** Zertifikat und Schlüssel — Pfade, nicht Inhalte: gelesen wird erst beim Start. */
export type TlsConfig = {
  certPath: string;
  keyPath: string;
  /** Zwischenzertifikate, falls der Aussteller welche mitgibt. */
  caPath: string | null;
};

export type Config = {
  env: Env;
  host: string;
  port: number;
  /** Wo die Spielstände wirklich liegen (SQLite, siehe `db.ts`). */
  dbPath: string;
  /**
   * Der alte Ein-Datei-Spielstand.
   *
   * Nur noch für den einmaligen Umzug da: Danach liegt alles in `dbPath`. Er
   * steht bewusst nicht mehr im Startprotokoll — dort zu lesen, wo nichts mehr
   * hingeschrieben wird, hat schon einmal jemanden an der falschen Stelle
   * suchen lassen.
   */
  savePath: string;
  tokenPath: string;
  /** Zielversion des Regelwerks — worauf der Server Snapshots hebt (R2). */
  rulesetVersion: number;
  adminEnabled: boolean;
  /** Gesetzt, wenn der Server selbst TLS beendet. */
  tls: TlsConfig | null;
  /**
   * Vor dem Server steht ein TLS-Endpunkt (Tailscale Serve, Caddy, nginx).
   *
   * Zwei Dinge hängen daran: Riegel 4 ist damit erfüllt — und `x-forwarded-for`
   * wird erst dann geglaubt. Ohne einen Proxy davor kann diesen Kopf jeder
   * selbst setzen, und die Anlege-Bremse wäre eine Zeile Arbeit wert.
   */
  behindProxy: boolean;
  /** Welcher Stand hier läuft. Steht in `/health`, damit man es von außen sieht. */
  version: string;
};

/** Lauscht der Server nur auf der eigenen Maschine? Dann verlässt nichts das Blech. */
export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '[::1]';
}

/** Kommt bei den Spielern eine verschlüsselte Verbindung an? */
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
  // Dev: schnelle Uhren, Werkbank an, eigener Port — und im Netz erreichbar,
  // weil man vom Handy aus testet.
  dev: { port: 8788, ruleset: DEV_RULESET_VERSION, admin: true, host: '0.0.0.0' },
  // Produktion: echte Zeiten, Werkbank aus — und standardmäßig **nur lokal**.
  // Nach außen kommt sie über einen TLS-Endpunkt davor. Wer sie direkt ins
  // Netz stellen will, muss `NEUES_SPIEL_HOST` setzen und stößt dann auf
  // Riegel 4.
  prod: { port: 8787, ruleset: LATEST_RULESET_VERSION, admin: false, host: '127.0.0.1' },
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

  // ── TLS ─────────────────────────────────────────────────────────────
  const certPath = vars.NEUES_SPIEL_TLS_CERT?.trim() || undefined;
  const keyPath = vars.NEUES_SPIEL_TLS_KEY?.trim() || undefined;
  if (Boolean(certPath) !== Boolean(keyPath)) {
    // Halb konfiguriertes TLS ist der schlimmste Fall: Man glaubt, es läuft
    // verschlüsselt, und es läuft im Klartext.
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

  // Riegel 4: kein Klartext-Produktionsserver im Netz.
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
    /**
     * Ohne eigene Angabe liegt die Datenbank **neben** dem Spielstandpfad.
     *
     * Nicht einfach im Standardverzeichnis: Wer `NEUES_SPIEL_SAVE` woandershin
     * zeigen lässt, meint sein Datenverzeichnis — und bekäme sonst still eine
     * Datenbank an einer ganz anderen Stelle. Genau das ist einmal passiert:
     * Der Browser-Test schrieb in ein temporäres Verzeichnis, die Datenbank
     * aber ins Repo, und sammelte über Läufe hinweg Höfe an.
     */
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

/** Was beim Start im Log stehen soll — einmal alles, damit nichts zu raten bleibt. */
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
  // Dev fällt nicht unter Riegel 4 — man entwickelt im eigenen Netz. Gesagt
  // werden muss es trotzdem, denn ohne sicheren Kontext registriert sich der
  // Service Worker nicht, und dann startet die App eben doch nicht ohne Netz.
  if (!isSecureTransport(cfg)) {
    lines.push('');
    lines.push('  ⚠  Unverschlüsselt. Der Hof-Schlüssel reist im Klartext mit, und der');
    lines.push('     Service Worker registriert sich nicht — die App startet dann');
    lines.push('     nicht ohne Netz. Siehe docs/deploy.md, Abschnitt HTTPS.');
  }
  return lines;
}
