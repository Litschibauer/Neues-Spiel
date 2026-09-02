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
};
function hasCowFeed() {
  return rules.items.some(function (x) { return x.id === 'cow-feed'; });
}
function nameOf(id) {
  if (id === 'feed' && hasCowFeed()) return 'Hühnerfutter';
  return NAMES[id] || id;
}
function itemName(i) { return nameOf(rules.items[i].id); }

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
  return { one: 'Platz', many: 'Plätze', jung: 'Platz', artikel: 'ein' };
}
function plotName(i) {
  var id = rules.plots[i].id;
  if (id.indexOf('field-') === 0) return 'Feld ' + id.slice(6);
  if (id.indexOf('coop-') === 0) return 'Hühnerstall';
  if (id.indexOf('pasture-') === 0) return 'Kuhweide';
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
