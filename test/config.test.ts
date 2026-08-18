import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfigError,
  describeConfig,
  isSecureTransport,
  resolveConfig,
} from '../src/server/config.ts';
import { DEV_RULESET_VERSION, LATEST_RULESET_VERSION } from '../src/sim/rules.ts';

const ROOT = '/srv/spiel';

test('die Umgebung muss genannt werden — es gibt keinen Standardwert', () => {
  assert.throws(() => resolveConfig({}, [], ROOT), ConfigError);
  assert.throws(() => resolveConfig({}, ['--env=staging'], ROOT), ConfigError);
  assert.throws(() => resolveConfig({ NEUES_SPIEL_ENV: 'PROD' }, [], ROOT), ConfigError);
});

test('beide Schreibweisen des Flags funktionieren, Umgebungsvariable auch', () => {
  assert.equal(resolveConfig({}, ['--env=dev'], ROOT).env, 'dev');
  assert.equal(resolveConfig({}, ['--env', 'dev'], ROOT).env, 'dev');
  assert.equal(resolveConfig({ NEUES_SPIEL_ENV: 'prod' }, [], ROOT).env, 'prod');

  assert.equal(resolveConfig({ NEUES_SPIEL_ENV: 'prod' }, ['--env=dev'], ROOT).env, 'dev');
});

test('die beiden Umgebungen teilen sich nichts', () => {
  const dev = resolveConfig({}, ['--env=dev'], ROOT);
  const prod = resolveConfig({}, ['--env=prod'], ROOT);

  assert.notEqual(dev.port, prod.port, 'gleicher Port — sie könnten nicht gleichzeitig laufen');
  assert.notEqual(dev.dbPath, prod.dbPath, 'gleiche Spielstände');
  assert.notEqual(dev.savePath, prod.savePath, 'gleicher Alt-Spielstand');
  assert.notEqual(dev.tokenPath, prod.tokenPath, 'gleiches Token');
  assert.notEqual(dev.rulesetVersion, prod.rulesetVersion, 'gleiches Regelwerk');

  assert.equal(dev.rulesetVersion, DEV_RULESET_VERSION);
  assert.equal(prod.rulesetVersion, LATEST_RULESET_VERSION);
});

test('RIEGEL: das Dev-Regelwerk kommt nicht in Produktion', () => {
  assert.throws(
    () => resolveConfig({ NEUES_SPIEL_RULESET: String(DEV_RULESET_VERSION) }, ['--env=prod'], ROOT),
    ConfigError,
  );

  assert.equal(
    resolveConfig({ NEUES_SPIEL_RULESET: String(DEV_RULESET_VERSION) }, ['--env=dev'], ROOT)
      .rulesetVersion,
    DEV_RULESET_VERSION,
  );
});

test('RIEGEL: die Werkbank ist in Produktion aus, in Dev an', () => {
  assert.equal(resolveConfig({}, ['--env=prod'], ROOT).adminEnabled, false);
  assert.equal(resolveConfig({}, ['--env=dev'], ROOT).adminEnabled, true);

  const forced = resolveConfig({ NEUES_SPIEL_ADMIN: '1' }, ['--env=prod'], ROOT);
  assert.equal(forced.adminEnabled, true);
  assert.ok(
    describeConfig(forced).some((l) => l.includes('WERKBANK IN PRODUKTION')),
    'keine Warnung im Startprotokoll',
  );

  assert.equal(resolveConfig({ NEUES_SPIEL_ADMIN: '0' }, ['--env=dev'], ROOT).adminEnabled, false);
});

test('RIEGEL: Produktion geht nicht im Klartext ins Netz', () => {
  assert.throws(
    () => resolveConfig({ NEUES_SPIEL_HOST: '0.0.0.0' }, ['--env=prod'], ROOT),
    ConfigError,
  );

  try {
    resolveConfig({ NEUES_SPIEL_HOST: '0.0.0.0' }, ['--env=prod'], ROOT);
    assert.fail('kein Abbruch');
  } catch (err) {
    const text = (err as Error).message;
    assert.match(text, /NEUES_SPIEL_TLS_CERT/);
    assert.match(text, /NEUES_SPIEL_BEHIND_PROXY/);
    assert.match(text, /127\.0\.0\.1/);
  }

  const proxied = resolveConfig(
    { NEUES_SPIEL_HOST: '0.0.0.0', NEUES_SPIEL_BEHIND_PROXY: '1' },
    ['--env=prod'],
    ROOT,
  );
  const withCert = resolveConfig(
    {
      NEUES_SPIEL_HOST: '0.0.0.0',
      NEUES_SPIEL_TLS_CERT: '/etc/tls/cert.pem',
      NEUES_SPIEL_TLS_KEY: '/etc/tls/key.pem',
    },
    ['--env=prod'],
    ROOT,
  );
  const local = resolveConfig({}, ['--env=prod'], ROOT);

  for (const cfg of [proxied, withCert, local]) assert.equal(isSecureTransport(cfg), true);
  assert.equal(local.host, '127.0.0.1', 'Produktion lauscht standardmäßig nicht nach außen');
  assert.equal(withCert.tls?.certPath, '/etc/tls/cert.pem');
});

test('halb angegebenes TLS ist schlimmer als gar keins', () => {
  for (const env of ['dev', 'prod']) {
    assert.throws(
      () => resolveConfig({ NEUES_SPIEL_TLS_CERT: '/etc/tls/cert.pem' }, [`--env=${env}`], ROOT),
      ConfigError,
      `${env}: Zertifikat ohne Schlüssel durchgelassen`,
    );
    assert.throws(
      () => resolveConfig({ NEUES_SPIEL_TLS_KEY: '/etc/tls/key.pem' }, [`--env=${env}`], ROOT),
      ConfigError,
      `${env}: Schlüssel ohne Zertifikat durchgelassen`,
    );
  }
});

test('Dev darf unverschlüsselt ins LAN — sagt es aber deutlich', () => {
  const dev = resolveConfig({}, ['--env=dev'], ROOT);
  assert.equal(dev.host, '0.0.0.0');
  assert.equal(isSecureTransport(dev), false);

  const text = describeConfig(dev).join('\n');
  assert.match(text, /Unverschlüsselt/);

  assert.match(text, /Service Worker/);
});

test('unbrauchbare Werte brechen den Start ab, statt sie zu raten', () => {
  assert.throws(() => resolveConfig({ PORT: 'achtzig' }, ['--env=dev'], ROOT), ConfigError);
  assert.throws(() => resolveConfig({ PORT: '0' }, ['--env=dev'], ROOT), ConfigError);
  assert.throws(() => resolveConfig({ PORT: '99999' }, ['--env=dev'], ROOT), ConfigError);
  assert.throws(() => resolveConfig({ NEUES_SPIEL_RULESET: '77' }, ['--env=dev'], ROOT), ConfigError);
});

test('alles Wichtige lässt sich überschreiben — ohne die Riegel aufzuweichen', () => {
  const cfg = resolveConfig(
    {
      PORT: '9000',
      NEUES_SPIEL_SAVE: '/var/lib/spiel/save.json',
      NEUES_SPIEL_TOKEN_FILE: '/etc/spiel/token',
      NEUES_SPIEL_VERSION: 'a1b2c3d',
    },
    ['--env=prod'],
    ROOT,
  );

  assert.equal(cfg.port, 9000);
  assert.equal(cfg.savePath, '/var/lib/spiel/save.json');
  assert.equal(
    resolveConfig({ NEUES_SPIEL_DB: '/var/lib/spiel/hoefe.db' }, ['--env=prod'], ROOT).dbPath,
    '/var/lib/spiel/hoefe.db',
  );
  assert.equal(cfg.tokenPath, '/etc/spiel/token');
  assert.equal(cfg.version, 'a1b2c3d');

  assert.equal(cfg.dbPath, '/var/lib/spiel/spiel.db');
});

test('das Startprotokoll verrät, was läuft — sonst rät man beim Deployen', () => {
  const lines = describeConfig(resolveConfig({ NEUES_SPIEL_VERSION: 'abc1234' }, ['--env=dev'], ROOT));
  const text = lines.join('\n');

  assert.match(text, /DEV/);
  assert.match(text, /abc1234/);
  assert.match(text, /8788/);
  assert.match(text, /v1001/);

  assert.match(text, /spiel\.db/);
  assert.doesNotMatch(text, /save\.json/);
});
