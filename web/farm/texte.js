var NAMES = {
  gold: 'Gold', wheat: 'Weizen', feed: 'Futter', eggs: 'Eier',
  corn: 'Mais', milk: 'Milch', cream: 'Sahne', butter: 'Butter', cheese: 'Käse',
  mill: 'Mühle', dairy: 'Molkerei', 'cow-feed': 'Kuhfutter',
  plank: 'Bretter', nail: 'Nägel',
  saw: 'Säge', shovel: 'Schaufel', pickaxe: 'Spitzhacke',
  map: 'Landkarte', mallet: 'Bauhammer', stake: 'Steckpfahl',
  explosive: 'Sprengstoff', coal: 'Kohle', 'iron-ore': 'Eisenerz',
  'gold-ore': 'Golderz', 'iron-bar': 'Eisenbarren', 'gold-bar': 'Goldbarren',
  mine: 'Mine', forge: 'Schmiede',
  'dig-shovel': 'Mit Schaufel', 'dig-pickaxe': 'Mit Spitzhacke', 'dig-blast': 'Mit Sprengstoff',
  apple: 'Äpfel', 'apple-tree': 'Apfelbaum',
  flour: 'Mehl', bread: 'Brot', 'apple-pie': 'Apfelkuchen', 'fried-egg': 'Spiegeleier',
  oven: 'Backofen', grill: 'Grill',
  'deco-fence': 'Zaun', 'deco-flowers': 'Blumenbeet', 'deco-bench': 'Gartenbank',
  bait: 'Köder', 'fish-perch': 'Barsch', 'fish-trout': 'Forelle',
  'fish-carp': 'Karpfen', 'fish-pike': 'Hecht',
  'seaweed': 'Seegras', 'junk-can': 'Alte Dose',
  'wood': 'Holz', 'smoked-fish': 'Räucherfisch',
  'woodlot': 'Waldstück', 'workshop': 'Werkstatt', 'smokehouse': 'Räucherei',
  'kitchen': 'Hofküche', 'farm-platter': 'Bauernbrettl', 'cream-cake': 'Sahnetorte',
  'booster-xp': 'XP-Verdoppler', 'booster-wuchs': 'Schnellwuchs',
  wool: 'Wolle', yarn: 'Garn', sweater: 'Pullover', weberei: 'Weberei',
  'sheep-feed': 'Schaffutter',
  'deco-erntekranz': 'Erntekranz', 'deco-boje': 'Boje', 'deco-marktfahne': 'Marktfahne', 'deco-laterne': 'Laterne',
};
function hasCowFeed() {
  return rules.items.some(function (x) { return x.id === 'cow-feed'; });
}
function nameOf(id) {
  if (id === 'feed' && hasCowFeed()) return 'Hühnerfutter';
  return NAMES[id] || id;
}
function itemName(i) { return nameOf(rules.items[i].id); }
// Die Warennamen stehen in der Mehrzahl, weil man selten eine einzelne hat.
// Ein Fund ist genau so ein Fall: „1 Bretter" liest sich falsch.
var EINZAHL = { plank: 'Brett', nail: 'Nagel', apple: 'Apfel', eggs: 'Ei', yarn: 'Garn', sweater: 'Pullover' };
function stueckName(amount, i) {
  var id = rules.items[i].id;
  return amount === 1 && EINZAHL[id] ? EINZAHL[id] : itemName(i);
}

function iconFor(id) {
  return typeof ICONS === 'object' && ICONS[id] ? ICONS[id] : null;
}
function iconTag(id, klasse) {
  var quelle = iconFor(id);
  if (!quelle) return '';
  return '<img class="ic' + (klasse ? ' ' + klasse : '') + '" src="' + quelle +
    '" alt="" aria-hidden="true">';
}
function itemIcon(item, klasse) { return iconTag(rules.items[item].id, klasse); }
function mengeMitBild(item, menge) {
  return itemIcon(item) + '<span>' + menge + ' ' + itemName(item) + '</span>';
}
var HOF_ERST = [
  'Sonnen', 'Linden', 'Birken', 'Eichen', 'Rosen', 'Auen', 'Berg', 'Tal',
  'Wiesen', 'Bach', 'Stein', 'Hasel', 'Kirsch', 'Ahorn', 'Weiden', 'Erlen',
];
var HOF_ZWEIT = ['hof', 'gut', 'feld', 'garten', 'wiese', 'kamp', 'acker', 'weide'];

function hofName(nummer) {
  var n = Math.abs(nummer | 0);
  return HOF_ERST[n % HOF_ERST.length] + HOF_ZWEIT[Math.floor(n / HOF_ERST.length) % HOF_ZWEIT.length];
}

function hindernisName(art) {
  return art === 'tree' ? 'Baum' : art === 'rock' ? 'Stein' : 'Tümpel';
}

function animalOf(i) {
  var id = rules.plots[i].id;
  if (id.indexOf('coop-') === 0) {
    return { one: 'Huhn', many: 'Hühner', jung: 'Küken', artikel: 'ein' };
  }
  if (id.indexOf('pasture-') === 0) {
    return { one: 'Kuh', many: 'Kühe', jung: 'Kalb', artikel: 'eine' };
  }
  if (id.indexOf('sheep-') === 0) {
    return { one: 'Schaf', many: 'Schafe', jung: 'Lamm', artikel: 'ein' };
  }
  return { one: 'Platz', many: 'Plätze', jung: 'Platz', artikel: 'ein' };
}
function plotName(i) {
  var id = rules.plots[i].id;
  if (id.indexOf('field-') === 0) return 'Feld ' + id.slice(6);
  if (id.indexOf('coop-') === 0) return 'Hühnerstall';
  if (id.indexOf('pasture-') === 0) return 'Kuhweide';
  if (id.indexOf('sheep-') === 0) return 'Schafweide';
  if (id.indexOf('apple-tree') === 0) return 'Apfelbaum';
  return nameOf(id);
}
function stacks(list) {
  return list.map(function (x) { return x.amount + ' ' + itemName(x.item); }).join(' + ');
}
function stacksMitBild(list) {
  return list
    .map(function (x) { return itemIcon(x.item) + x.amount + ' ' + itemName(x.item); })
    .join(' + ');
}
function costText(cost) { return stacks(cost); }

// Zutaten werden ueberall gleich gezeigt: Bild, Bedarf, Name — und wenn etwas
// fehlt, wie viel davon wirklich im Lager liegt. `have` ist eine Liste
// item -> Menge; ohne `have` steht nur der Bedarf da (Vorschau auf Rezepte,
// die noch gar nicht offen sind).
function zutatenHtml(list, have, opt) {
  if (!list || list.length === 0) return '';
  var o = opt || {};
  var faktor = o.faktor || 1;
  var chips = list.map(function (x) {
    var braucht = x.amount * faktor;
    var da = have ? (have[x.item] || 0) : null;
    var fehlt = da !== null && da < braucht;
    return '<span class="zutat' + (fehlt ? ' fehlt' : '') + '">' +
      // Gold ist keine Stueckzahl: „1200 Gold" statt „1200× Gold".
      itemIcon(x.item) + braucht + (x.item === rules.currency ? ' ' : '\u00d7 ') +
      itemName(x.item) +
      (fehlt ? ' <b>(' + da + ' da)</b>' : '') + '</span>';
  });
  return '<span class="zutaten' + (o.klasse ? ' ' + o.klasse : '') + '">' +
    '<span class="zlabel">' + (o.titel || 'braucht') + '</span>' +
    chips.join('') + '</span>';
}

// Bestaende aus einer fertigen Farm-Sicht — v.stock laeuft parallel zu
// rules.items, das spart eine zweite Vorschau-Rechnung.
function lagerAusSicht(v) {
  var have = [];
  (v && v.stock ? v.stock : []).forEach(function (e) { have[e.item] = e.amount; });
  return have;
}
// Fuer Stellen ohne fertige Sicht.
function lagerJetzt() {
  return typeof client !== 'undefined' && client ? client.preview().items : null;
}

function ausbeute(recipeIndex) {
  var r = rules.recipes[recipeIndex];
  if (!r) return [];
  return r.extra && r.extra.length ? [r.output].concat(r.extra) : [r.output];
}
function ausbeuteHtml(recipeIndex, klasse) {
  return ausbeute(recipeIndex).map(function (s) {
    return '+' + s.amount + ' ' + itemIcon(s.item, klasse || 'gross');
  }).join(' ');
}
function ausbeuteText(recipeIndex) {
  return ausbeute(recipeIndex).map(function (s) { return s.amount + ' ' + itemName(s.item); }).join(' + ');
}

// Der Tageswechsel haengt am Kalendertag des Servers, und der zaehlt in UTC:
// tagVon(ms) = floor(ms / 86400000). Der naechste Wechsel ist also die
// naechste UTC-Mitternacht — gerechnet auf der Serveruhr, nicht auf der des
// Geraets, sonst laege eine schiefe Uhr auch beim Countdown daneben.
var TAG_MS = 86400000;

function naechsterTageswechsel() {
  var serverJetzt = Date.now() + (typeof clockOffsetMs === 'number' ? clockOffsetMs : 0);
  return { jetzt: serverJetzt, wechsel: (Math.floor(serverJetzt / TAG_MS) + 1) * TAG_MS };
}

// Angezeigt wird in der Zeitzone des Geraets — der Moment ist derselbe, nur
// eben so, wie er auf der Uhr des Spielers steht. Fest 24 Stunden, damit es
// nicht je nach Systemsprache zwischen 14:00 und 2 PM springt.
// Die Woche beginnt am Montag (UTC): Tag 0 der Epoche war ein Donnerstag,
// darum die drei Tage Versatz — dieselbe Rechnung wie in der Sim.
function naechsterWochenwechsel() {
  var serverJetzt = Date.now() + (typeof clockOffsetMs === 'number' ? clockOffsetMs : 0);
  var tag = Math.floor(serverJetzt / TAG_MS);
  var woche = Math.floor((tag + 3) / 7);
  var ersterTag = (woche + 1) * 7 - 3;
  return { jetzt: serverJetzt, wechsel: ersterTag * TAG_MS };
}
// Das Fest: Name aus dem Regelwerk, und wann es endet (der Tag nach dem
// letzten Festtag, 0 Uhr Serverzeit) beziehungsweise beginnt.
var WOCHENTAGE = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
function festName(fest) {
  var arten = rules.feste ? rules.feste.arten : [];
  return fest && arten[fest.art] ? arten[fest.art].label : 'Fest';
}
function festEndeMs(fest) {
  return (fest.tag + (fest.bis - fest.heute) + 1) * TAG_MS;
}
function festStartMs(fest) {
  return (fest.tag + fest.inTagen) * TAG_MS;
}
function serverJetztMs() {
  return Date.now() + (typeof clockOffsetMs === 'number' ? clockOffsetMs : 0);
}
// Restzeit in Tagen und Stunden — fuer alles, was laenger als einen Tag dauert.
function tageText(seconds) {
  if (seconds < 86400) return timeText(seconds);
  var d = Math.floor(seconds / 86400);
  var h = Math.floor((seconds % 86400) / 3600);
  return d + (d === 1 ? ' Tag' : ' Tage') + (h > 0 ? ' ' + h + ' h' : '');
}
function uhrzeitKurz(ms) {
  var d = new Date(ms);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

// Meisterschaft: Sterne als Zeichen und der Vorteil je Stern in Worten.
function sterneText(n, max) {
  var s = '';
  for (var i = 0; i < max; i++) s += i < n ? '★' : '☆';
  return s;
}
function meisterVorteil(stern, m) {
  if (stern === 1) return m.schnellerProzent + ' % schneller';
  if (stern === 2) return '+' + m.xpProzent + ' % XP';
  return 'jede ' + m.extraJede + '. Abholung ein Stück extra';
}

function timeText(seconds) {
  if (seconds < 60) return seconds + ' s';
  if (seconds < 3600) return Math.ceil(seconds / 60) + ' min';
  var h = Math.floor(seconds / 3600);
  var m = Math.round((seconds % 3600) / 60);
  return m > 0 ? h + ' h ' + m + ' min' : h + ' h';
}

function nextLevelOf(i, level) { return rules.plots[i].levels[level] || null; }
function recipesAt(i, level) {
  return level <= 0 ? [] : (rules.plots[i].levels[level - 1].recipes || []);
}
