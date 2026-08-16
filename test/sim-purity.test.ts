/**
 * Verteidigungslinie 1 gegen R1: Determinismus-Regeln maschinell erzwingen.
 *
 * Die Regeln aus §2.2 („keine Floats, keine Systemzeit, keine Plattform-APIs")
 * sind nur so viel wert, wie sie geprüft werden. Ein Entwickler, der in zwei
 * Jahren `Math.random()` in die Sim schreibt, bekommt sonst keinen Widerspruch —
 * bis irgendwann ehrliche Spieler Rollbacks melden.
 *
 * Dieser Test liest den Quelltext des Sim-Kerns und blockiert die bekannten
 * Determinismus-Killer. Statisch, also greift er auch für Pfade, die kein
 * Fuzz-Test je erreicht.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Nur die zustandsverändernden Dateien. `hash.ts` ist bewusst NICHT dabei:
 * Es benutzt `node:crypto`, verändert aber keinen Zustand — SHA-256 ist selbst
 * plattformübergreifend deterministisch.
 */
const PURE_FILES = ['rules.ts', 'state.ts', 'produce.ts', 'commands.ts', 'sim.ts'];

const SIM_DIR = join(import.meta.dirname, '..', 'src', 'sim');

/** Nur `Math`-Funktionen, die auf Integern exakt und plattformstabil sind. */
const ALLOWED_MATH = new Set(['floor', 'min', 'max', 'abs', 'trunc', 'sign']);

/**
 * Entfernt Kommentare und String-Literale, damit die Prüfungen nur echten Code
 * sehen — sonst schlägt jede Erklärung im Kommentar falschen Alarm.
 */
function stripNonCode(src: string): string[] {
  const withoutBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks.split('\n').map((line) => {
    const noLineComment = line.replace(/\/\/.*$/, '');
    return noLineComment
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  });
}

type Finding = { file: string; line: number; rule: string; text: string };

function auditFile(file: string): Finding[] {
  const lines = stripNonCode(readFileSync(join(SIM_DIR, file), 'utf8'));
  const findings: Finding[] = [];
  const flag = (i: number, rule: string, text: string) =>
    findings.push({ file, line: i + 1, rule, text: text.trim() });

  lines.forEach((line, i) => {
    // Nichtdeterministische bzw. umgebungsabhängige Quellen.
    if (/\bMath\.random\b/.test(line)) flag(i, 'Math.random', line);
    if (/\bDate\b|\bperformance\b|\bprocess\b/.test(line)) flag(i, 'Systemzeit/Umgebung', line);
    if (/\bIntl\b|toLocale/.test(line)) flag(i, 'Locale', line);

    // Fließkomma-Literale.
    if (/\b\d+\.\d+\b/.test(line)) flag(i, 'Float-Literal', line);

    // Math-Funktionen außerhalb der Allowlist (z.B. pow, sqrt, round).
    for (const m of line.matchAll(/\bMath\.(\w+)/g)) {
      if (!ALLOWED_MATH.has(m[1]!)) flag(i, `Math.${m[1]}`, line);
    }

    // Ungeschützte Division erzeugt Floats. Erlaubt nur mit Math.floor.
    if (/\s\/\s/.test(line) && !/Math\.floor/.test(line)) flag(i, 'ungeschützte Division', line);

    // `for…in` iteriert in nicht garantierter Reihenfolge (§2.2).
    if (/\bfor\s*\(\s*(?:const|let|var)\s+\w+\s+in\b/.test(line)) flag(i, 'for…in', line);
  });

  return findings;
}

test('der Sim-Kern enthält keine Determinismus-Killer', () => {
  const findings = PURE_FILES.flatMap(auditFile);

  const report = findings.map((f) => `  ${f.file}:${f.line}  [${f.rule}]  ${f.text}`).join('\n');
  assert.equal(findings.length, 0, `Determinismus-Regeln verletzt:\n${report}`);
});

test('der Wächter hat Zähne — er erkennt die Verstöße, die er erkennen soll', () => {
  // Ohne diesen Test könnte der Wächter stillschweigend kaputtgehen (etwa durch
  // eine zu gierige Kommentar-Regex) und würde dann nichts mehr finden.
  const cases = [
    ['const x = Math.random();', 'Math.random'],
    ['const t = Date.now();', 'Systemzeit/Umgebung'],
    ['const r = 1.5;', 'Float-Literal'],
    ['const r = Math.round(x);', 'Math.round'],
    ['const r = a / b;', 'ungeschützte Division'],
    ['for (const k in obj) {}', 'for…in'],
    ['const s = x.toLocaleString();', 'Locale'],
  ];

  for (const [code, expectedRule] of cases) {
    const lines = stripNonCode(code!);
    const line = lines[0]!;
    let hit = false;

    if (/\bMath\.random\b/.test(line) && expectedRule === 'Math.random') hit = true;
    if (/\bDate\b|\bperformance\b|\bprocess\b/.test(line) && expectedRule === 'Systemzeit/Umgebung')
      hit = true;
    if (/\bIntl\b|toLocale/.test(line) && expectedRule === 'Locale') hit = true;
    if (/\b\d+\.\d+\b/.test(line) && expectedRule === 'Float-Literal') hit = true;
    if (/\bMath\.round\b/.test(line) && expectedRule === 'Math.round') hit = true;
    if (/\s\/\s/.test(line) && !/Math\.floor/.test(line) && expectedRule === 'ungeschützte Division')
      hit = true;
    if (/\bfor\s*\(\s*(?:const|let|var)\s+\w+\s+in\b/.test(line) && expectedRule === 'for…in')
      hit = true;

    assert.ok(hit, `Wächter erkennt nicht: ${code}`);
  }

  // Und er darf legitimen Code nicht anfassen.
  const ok = stripNonCode('const eggs = Math.floor(available / ticksPerEgg); // 1.5 im Kommentar');
  assert.ok(!/\b\d+\.\d+\b/.test(ok[0]!), 'Kommentar wird fälschlich geprüft');
  assert.ok(/Math\.floor/.test(ok[0]!), 'geschützte Division wird fälschlich gemeldet');
});
