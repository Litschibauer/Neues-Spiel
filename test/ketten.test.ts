import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset, LATEST_RULESET_VERSION, levelRecipes, recipeOutputs } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';

const V = getRuleset(LATEST_RULESET_VERSION);
const idx = (id: string) => {
  const i = V.items.findIndex((x) => x.id === id);
  assert.ok(i >= 0, `Ware ${id} fehlt im Katalog`);
  return i;
};

// Alles, was irgendein Rezept auf irgendeinem Platz herstellen kann.
function herstellbar(): Set<number> {
  const raus = new Set<number>();
  V.plots.forEach((p, i) => {
    p.levels.forEach((_, stufe) => {
      for (const r of levelRecipes(V, i, stufe + 1)) {
        for (const o of recipeOutputs(V.recipes[r]!)) raus.add(o.item);
      }
    });
  });
  return raus;
}

function mitItems(paare: [number, number][], xp = 1_000_000) {
  const s = initialState(V);
  const items = s.items.slice();
  for (const [i, n] of paare) items[i] = n;
  return { ...s, items, xp };
}

// — Der Kern: Werkzeug war eine Sackgasse ————————————————————————————

test('jedes Werkzeug zum Räumen lässt sich herstellen', () => {
  const kann = herstellbar();
  for (const [art, def] of Object.entries(V.obstacleKinds ?? {})) {
    assert.ok(
      kann.has(def.tool),
      `${art} kostet ${V.items[def.tool]!.id}, und das kann kein Rezept herstellen`,
    );
  }
});

test('jedes Material zum Freimachen von Land lässt sich herstellen', () => {
  const kann = herstellbar();
  const gebraucht = new Set<number>();
  for (const e of V.expansions ?? []) for (const c of e.cost ?? []) gebraucht.add(c.item);
  for (const item of gebraucht) {
    if (item === V.currency) continue;
    assert.ok(kann.has(item), `Land kostet ${V.items[item]!.id}, herstellen kann man es nicht`);
  }
});

test('jedes Baumaterial für Gebäude lässt sich herstellen', () => {
  const kann = herstellbar();
  const gebraucht = new Set<number>();
  for (const p of V.plots) for (const l of p.levels) for (const c of l.cost ?? []) gebraucht.add(c.item);
  for (const item of gebraucht) {
    if (item === V.currency) continue;
    assert.ok(kann.has(item), `Bauen kostet ${V.items[item]!.id}, herstellen kann man es nicht`);
  }
});

test('die Barren aus der Schmiede werden weiterverarbeitet', () => {
  const eisen = idx('iron-bar');
  const nutzer = V.recipes.filter((r) => r.inputs.some((c) => c.item === eisen));
  assert.ok(nutzer.length >= 4, `Eisenbarren geht in ${nutzer.length} Rezepte statt ins Nichts`);
});

// — Holz als Grundlage ————————————————————————————————————————————————

test('einen Baum zu fällen bringt Holz, ein Stein bringt keins', () => {
  const holz = idx('wood');
  const baum = (V.obstacles ?? []).findIndex((o) => o.kind === 'tree');
  const stein = (V.obstacles ?? []).findIndex((o) => o.kind === 'rock');
  assert.ok(baum >= 0 && stein >= 0, 'Karte hat Bäume und Steine');

  const saege = V.obstacleKinds!.tree!.tool;
  const hacke = V.obstacleKinds!.rock!.tool;

  const nachBaum = simulate(
    mitItems([[saege, 1]]),
    { seq: 1, tick: 0, type: 'CLEAR_OBSTACLE', index: baum },
    V,
  );
  assert.equal(nachBaum.items[holz], V.obstacleKinds!.tree!.ertrag!.amount, 'Holz liegt da');
  assert.equal(nachBaum.items[saege], 0, 'Säge verbraucht');

  const nachStein = simulate(
    mitItems([[hacke, 1]]),
    { seq: 1, tick: 0, type: 'CLEAR_OBSTACLE', index: stein },
    V,
  );
  assert.equal(nachStein.items[holz], 0, 'aus Stein kommt kein Holz');
});

test('Holz ist erneuerbar: das Waldstück gibt mehr zurück, als es nimmt', () => {
  const holz = idx('wood');
  const rezept = V.recipes.find((r) => r.id === 'wood');
  assert.ok(rezept, 'Waldstück-Rezept vorhanden');
  const rein = rezept!.inputs.find((c) => c.item === holz)!.amount;
  assert.ok(rezept!.output.amount > rein, `${rein} Holz rein, ${rezept!.output.amount} raus`);
});

// — Die Kette rechnet sich ————————————————————————————————————————————

test('die Werkzeugkette ist vollständig: Holz und Erz werden zu Karte und Säge', () => {
  const kette = ['plank', 'nail', 'saw', 'shovel', 'pickaxe', 'stake', 'mallet', 'map'];
  for (const id of kette) {
    const r = V.recipes.find((x) => x.id === id);
    assert.ok(r, `Rezept ${id} fehlt`);
    assert.ok(r!.inputs.length > 0, `${id} entsteht nicht aus dem Nichts`);
  }
});

test('geräucherter Fisch bringt mehr als roher, und Seegras findet Verwendung', () => {
  const geraeuchert = idx('smoked-fish');
  const seegras = idx('seaweed');
  const preis = (i: number) => V.items[i]!.npcPrice;

  for (const id of ['smoke-perch', 'smoke-trout', 'smoke-carp']) {
    const r = V.recipes.find((x) => x.id === id);
    assert.ok(r, `Rezept ${id} fehlt`);
    const rein = r!.inputs.reduce((n, c) => n + preis(c.item) * c.amount, 0);
    const raus = preis(geraeuchert) * r!.output.amount;
    assert.ok(raus > rein, `${id}: ${rein} rein, ${raus} raus — lohnt sich nicht`);
  }
  assert.ok(
    V.recipes.some((r) => r.inputs.some((c) => c.item === seegras)),
    'Seegras wird irgendwo gebraucht',
  );
});

test('alte Dosen aus dem See lassen sich einschmelzen', () => {
  const dose = idx('junk-can');
  const r = V.recipes.find((x) => x.inputs.some((c) => c.item === dose));
  assert.ok(r, 'für die Dose gibt es ein Rezept');
  assert.equal(V.items[r!.output.item]!.id, 'iron-bar');
});

// — Was die Kette tatsächlich leistet ————————————————————————————————

test('eine Karte entsteht in Minuten statt in Stunden Truhenwarten', () => {
  const karte = idx('map');
  const r = V.recipes.find((x) => x.output.item === karte);
  assert.ok(r, 'Karte ist herstellbar');
  // Truhe alle 7 min, ein Zug aus neun Sorten, Karte mit rund 4 Prozent:
  // im Schnitt gut zweieinhalb Stunden je Karte. Alles darunter ist besser.
  assert.ok(r!.durationTicks < 60 * 60, `Karte dauert ${r!.durationTicks / 60} min`);
});

test('die neuen Gebäude füllen die Stufen nach der Schmiede', () => {
  const nachSchmiede = V.plots.filter((p) =>
    p.levels.some((l) => (l.minPlayerLevel ?? 1) >= 12),
  );
  assert.ok(
    nachSchmiede.length >= 3,
    `${nachSchmiede.length} Bauwerke ab Stufe 12 — vorher war dort nichts`,
  );
});

test('jeder Fisch lässt sich räuchern, auch der wertvollste', () => {
  for (const fisch of ['fish-perch', 'fish-trout', 'fish-carp', 'fish-pike']) {
    const i = idx(fisch);
    assert.ok(
      V.recipes.some((r) => r.inputs.some((c) => c.item === i)),
      `${fisch} wird von keinem Rezept angenommen`,
    );
  }
});

// Waren, die nirgends weiterverarbeitet werden, sind nur dann in Ordnung, wenn
// sie das ENDE einer Kette sind. Alles andere ist eine Sackgasse.
test('nur noch Endprodukte enden im Verkauf', () => {
  const eingang = new Set<number>();
  for (const r of V.recipes) for (const c of r.inputs) eingang.add(c.item);
  const kosten = new Set<number>();
  for (const p of V.plots) for (const l of p.levels) for (const c of l.cost ?? []) kosten.add(c.item);
  for (const e of V.expansions ?? []) for (const c of e.cost ?? []) kosten.add(c.item);
  const werkzeug = new Set(Object.values(V.obstacleKinds ?? {}).map((x) => x.tool));

  // Das sind die gewollten Endpunkte: Spitzenwaren und der Wohlstandsbarren.
  const erlaubt = new Set(['gold-bar', 'smoked-fish', 'farm-platter', 'cream-cake']);
  const offen: string[] = [];
  // Booster werden eingesetzt, nicht verarbeitet — auch das ist ein Ende.
  const eingesetzt = new Set(V.booster ? [V.booster.xpItem, V.booster.wuchsItem] : []);
  V.items.forEach((it, i) => {
    if (i === V.currency || i === V.fishing?.bait) return;
    if (eingang.has(i) || kosten.has(i) || werkzeug.has(i) || eingesetzt.has(i)) return;
    if (!erlaubt.has(it.id)) offen.push(it.id);
  });
  assert.deepEqual(offen, [], `Sackgassen: ${offen.join(', ')}`);
});

test('die Hofküche verarbeitet, was vorher nur verkauft wurde', () => {
  const kueche = V.plots.find((p) => p.id === 'kitchen');
  assert.ok(kueche, 'Hofküche vorhanden');
  const zutaten = new Set<string>();
  for (const l of kueche!.levels) {
    for (const r of l.recipes) {
      for (const c of V.recipes[r]!.inputs) zutaten.add(V.items[c.item]!.id);
    }
  }
  for (const noetig of ['bread', 'cheese', 'apple-pie', 'cream']) {
    assert.ok(zutaten.has(noetig), `${noetig} wird in der Küche nicht gebraucht`);
  }
});

test('die neuen Waren tragen Namen und sind auftragsfähig', () => {
  for (const id of ['wood', 'smoked-fish']) {
    const i = idx(id);
    assert.ok(V.items[i]!.npcPrice > 0, `${id} hat einen Verkaufswert`);
  }
  const geraeuchert = idx('smoked-fish');
  assert.ok(
    (V.requestTemplates ?? []).some((t) => t.wants.some((w) => w.item === geraeuchert)),
    'Räucherfisch wird von Aufträgen verlangt',
  );
});
