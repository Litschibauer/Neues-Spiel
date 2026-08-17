/**
 * Die Trennung von Entwicklung und Produktion (siehe `config.ts`).
 *
 * Diese Tests prüfen keine Spielregel, sondern eine **Betriebsregel** — und die
 * sind es, die im Ernstfall wehtun. Ein Server, der versehentlich mit
 * Sekundenuhren auf echten Spielständen läuft, lässt sich nicht zurückdrehen:
 * Die Migration hat die Zeiten dann bereits umgerechnet.
 *
 * Deshalb steht die Konfiguration in einer eigenen, reinen Funktion — damit
 * genau diese Fälle prüfbar sind, ohne einen Server zu starten.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, describeConfig, resolveConfig } from '../src/server/config.ts';
import { DEV_RULESET_VERSION, LATEST_RULESET_VERSION } from '../src/sim/rules.ts';

const ROOT = '/srv/spiel';

test('die Umgebung muss genannt werden — es gibt keinen Standardwert', () => {
  // Ein vergessenes Flag darf nie zu „irgendwas" führen.
  assert.throws(() => resolveConfig({}, [], ROOT), ConfigError);
  assert.throws(() => resolveConfig({}, ['--env=staging'], ROOT), ConfigError);
  assert.throws(() => resolveConfig({ NEUES_SPIEL_ENV: 'PROD' }, [], ROOT), ConfigError);
});

test('beide Schreibweisen des Flags funktionieren, Umgebungsvariable auch', () => {
  assert.equal(resolveConfig({}, ['--env=dev'], ROOT).env, 'dev');
  assert.equal(resolveConfig({}, ['--env', 'dev'], ROOT).env, 'dev');
  assert.equal(resolveConfig({ NEUES_SPIEL_ENV: 'prod' }, [], ROOT).env, 'prod');
  // Das Flag schlägt die Variable — was man tippt, gilt.
  assert.equal(resolveConfig({ NEUES_SPIEL_ENV: 'prod' }, ['--env=dev'], ROOT).env, 'dev');
});

test('die beiden Umgebungen teilen sich nichts', () => {
  const dev = resolveConfig({}, ['--env=dev'], ROOT);
  const prod = resolveConfig({}, ['--env=prod'], ROOT);

  assert.notEqual(dev.port, prod.port, 'gleicher Port — sie könnten nicht gleichzeitig laufen');
  assert.notEqual(dev.savePath, prod.savePath, 'gleicher Spielstand');
  assert.notEqual(dev.tokenPath, prod.tokenPath, 'gleiches Token');
  assert.notEqual(dev.rulesetVersion, prod.rulesetVersion, 'gleiches Regelwerk');

  assert.equal(dev.rulesetVersion, DEV_RULESET_VERSION);
  assert.equal(prod.rulesetVersion, LATEST_RULESET_VERSION);
});

test('RIEGEL: das Dev-Regelwerk kommt nicht in Produktion', () => {
  // Der teuerste Betriebsfehler, den dieses System zulässt — deshalb ein
  // Startabbruch und keine Warnung.
  assert.throws(
    () => resolveConfig({ NEUES_SPIEL_RULESET: String(DEV_RULESET_VERSION) }, ['--env=prod'], ROOT),
    ConfigError,
  );
  // In Dev ist genau das dagegen der Normalfall.
  assert.equal(
    resolveConfig({ NEUES_SPIEL_RULESET: String(DEV_RULESET_VERSION) }, ['--env=dev'], ROOT)
      .rulesetVersion,
    DEV_RULESET_VERSION,
  );
});

test('RIEGEL: die Werkbank ist in Produktion aus, in Dev an', () => {
  assert.equal(resolveConfig({}, ['--env=prod'], ROOT).adminEnabled, false);
  assert.equal(resolveConfig({}, ['--env=dev'], ROOT).adminEnabled, true);

  // Ausdrücklich einschalten geht — mit sichtbarer Warnung im Startprotokoll.
  const forced = resolveConfig({ NEUES_SPIEL_ADMIN: '1' }, ['--env=prod'], ROOT);
  assert.equal(forced.adminEnabled, true);
  assert.ok(
    describeConfig(forced).some((l) => l.includes('WERKBANK IN PRODUKTION')),
    'keine Warnung im Startprotokoll',
  );

  // Und in Dev abschalten geht ebenso.
  assert.equal(resolveConfig({ NEUES_SPIEL_ADMIN: '0' }, ['--env=dev'], ROOT).adminEnabled, false);
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
  assert.equal(cfg.tokenPath, '/etc/spiel/token');
  assert.equal(cfg.version, 'a1b2c3d');
});

test('das Startprotokoll verrät, was läuft — sonst rät man beim Deployen', () => {
  const lines = describeConfig(resolveConfig({ NEUES_SPIEL_VERSION: 'abc1234' }, ['--env=dev'], ROOT));
  const text = lines.join('\n');

  assert.match(text, /DEV/);
  assert.match(text, /abc1234/);
  assert.match(text, /8788/);
  assert.match(text, /v1001/);
});
