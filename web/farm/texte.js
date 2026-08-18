var NAMES = {
  gold: 'Gold', wheat: 'Weizen', feed: 'Futter', eggs: 'Eier',
  corn: 'Mais', milk: 'Milch', cream: 'Sahne', butter: 'Butter', cheese: 'Käse',
  mill: 'Mühle', dairy: 'Molkerei',
};
function nameOf(id) { return NAMES[id] || id; }
function itemName(i) { return nameOf(rules.items[i].id); }
function plotName(i) {
  var id = rules.plots[i].id;
  if (id.indexOf('field-') === 0) return 'Feld ' + id.slice(6);
  if (id.indexOf('coop-') === 0) return 'Gehege ' + id.slice(5);
  if (id.indexOf('pasture-') === 0) return 'Kuhgehege ' + id.slice(8);
  return nameOf(id);
}
function stacks(list) {
  return list.map(function (x) { return x.amount + ' ' + itemName(x.item); }).join(' + ');
}
function costText(cost) { return stacks(cost); }

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
