var syncSoon = null;
function scheduleSync() {
  if (syncSoon) return;
  syncSoon = setTimeout(function () {
    syncSoon = null;
    attempt(false);
  }, 250);
}

function act(name, result) {
  if (!isActive) return;
  if (result.ok) { toast(name); save(); scheduleSync(); }
  else toast(CODES[result.code] || result.code, true);
  render();
}

function tapPlot(i) {
  if (!isActive) return;
  client.localTick = tickNow();
  var p = NS.farmView(client.preview(), rules, navigator.onLine).plots[i];

  if (p.capacity > 1) { openStall(p); return; }

  if (p.tap === 'collect') {
    act('Geerntet · ' + p.output.amount + ' ' + itemName(p.output.item), client.collect(i));
    return;
  }
  if (p.tap === 'buy') { tapBuy(i); return; }

  if (p.options.length > 1 && (p.tap === 'start' || p.blocked === 'inputs')) {
    openPicker(p);
    return;
  }
  if (p.tap === 'start') {
    act('Gestartet · ' + nameOf(p.next.id) +
          (p.next.inputs.length > 0 ? ' · −' + costText(p.next.inputs) : ''),
        client.start(i, p.next.recipe));
    return;
  }
  if (p.blocked === 'inputs') toast('Zutaten fehlen', true);
  else if (p.blocked === 'level') toast('Erst ab Stufe ' + p.upgrade.minPlayerLevel, true);
  else if (p.blocked === 'cost') toast('Zu wenig ' + itemName(rules.currency), true);
}

var sheet = { plot: null, mode: null, slot: 0 };
var pickerPlot = null;

function collectSlot(p, j) {
  var out = p.slots[j].output;
  act('Geerntet · ' + out.amount + ' ' + itemName(out.item), client.collect(p.index, j));
}

function feedSlot(p, j) {
  var open = p.options.filter(function (o) { return o.unlocked; });
  if (open.length > 1) { openPicker(p, j); return; }
  if (open.length === 0) { toast('Erst ab einer höheren Stufe', true); return; }
  var o = open[0];
  act('Gestartet · ' + nameOf(o.id) + (o.inputs.length > 0 ? ' · −' + costText(o.inputs) : ''),
      client.start(p.index, o.recipe, j));
}

function slotStatus(p, s) {
  if (s.done) return 'fertig · +' + s.output.amount + ' ' + itemName(s.output.item);
  if (s.busy) return 'noch ' + timeText(s.remaining) + ' · ' + nameOf(s.producing);
  var open = p.options.filter(function (o) { return o.unlocked; });
  if (open.length === 0) return 'kein Rezept frei';
  if (open.length > 1) return 'auswählen';
  var o = open[0];
  return (o.inputs.length > 0 ? costText(o.inputs) + ' · ' : '') + timeText(o.durationTicks) +
    (o.affordable ? '' : ' · fehlt');
}

function stallRow(p, s) {
  var tier = animalOf(p.index);
  var card = document.createElement('button');
  card.type = 'button';
  card.className = 'card opt';
  card.disabled = s.busy || (!s.done && !p.options.some(function (o) { return o.affordable; }));
  card.innerHTML =
    '<div class="body">' +
    '<div class="top">' + tier.one + ' ' + (s.index + 1) + '</div>' +
    '<div class="sub">' + slotStatus(p, s) + '</div>' +
    '</div>' +
    '<span class="yield">' + (s.done ? 'Ernten' : s.busy ? timeText(s.remaining) : 'Füttern') + '</span>';
  card.addEventListener('click', function () {
    if (s.done) collectSlot(p, s.index);
    else if (!s.busy) feedSlot(p, s.index);
  });
  return card;
}

function openStall(p) {
  sheet = { plot: p.index, mode: 'stall', slot: 0 };
  pickerPlot = p.index;
  renderStall(p);
  $('pick-bg').hidden = false;
}

function renderStall(p) {
  var tier = animalOf(p.index);
  $('pick-title').textContent = plotName(p.index) + ' — ' + p.capacity + ' ' +
    (p.capacity === 1 ? tier.one : tier.many);

  var box = $('pick-list');
  box.textContent = '';

  var ready = p.slots.filter(function (s) { return s.done; });
  var hungry = p.slots.filter(function (s) { return !s.done && !s.busy; });

  if (ready.length > 1) {
    var all = document.createElement('button');
    all.type = 'button';
    all.className = 'card opt';
    all.innerHTML = '<div class="body"><div class="top">Alle ernten</div>' +
      '<div class="sub">' + ready.length + ' ' + tier.many + ' sind fertig</div></div>';
    all.addEventListener('click', function () {
      ready.forEach(function (s) { collectSlot(p, s.index); });
    });
    box.appendChild(all);
  }

  if (hungry.length > 1 && p.options.filter(function (o) { return o.unlocked; }).length === 1) {
    var feedAll = document.createElement('button');
    feedAll.type = 'button';
    feedAll.className = 'card opt';
    var one = p.options.filter(function (o) { return o.unlocked; })[0];
    var have = client.preview().items;
    var enough = one.inputs.every(function (x) {
      return (have[x.item] || 0) >= x.amount * hungry.length;
    });
    feedAll.disabled = !enough;
    feedAll.innerHTML = '<div class="body"><div class="top">Alle füttern</div>' +
      '<div class="sub">' + hungry.length + '× ' + costText(one.inputs) +
      (enough ? '' : ' · reicht nicht') + '</div></div>';
    feedAll.addEventListener('click', function () {
      hungry.forEach(function (s) { feedSlot(p, s.index); });
    });
    box.appendChild(feedAll);
  }

  p.slots.forEach(function (s) { box.appendChild(stallRow(p, s)); });
}

function renderSheet(v) {
  if (sheet.mode === null || sheet.plot === null) return;
  var p = v.plots[sheet.plot];
  if (sheet.mode === 'stall') renderStall(p);
}

function openPicker(p, slot) {
  sheet = { plot: p.index, mode: 'recipes', slot: slot || 0 };
  pickerPlot = p.index;
  $('pick-title').textContent = plotName(p.index) + ' — was soll laufen?';

  var box = $('pick-list');
  box.textContent = '';
  p.options.forEach(function (o) {
    var card = document.createElement('button');
    card.type = 'button';
    card.className = 'card opt';
    card.disabled = !o.affordable;
    card.innerHTML =
      '<div class="body">' +
      '<div class="top">' + nameOf(o.id) + '</div>' +
      '<div class="sub">' +
      (!o.unlocked
        ? 'ab Stufe ' + o.minPlayerLevel
        : (o.inputs.length > 0 ? costText(o.inputs) + ' · ' : '') +
          timeText(o.durationTicks) +
          (o.affordable ? '' : ' · Zutaten fehlen')) +
      '</div></div>' +
      '<span class="yield">+' + o.output.amount + ' ' + itemName(o.output.item) + '</span>';
    card.addEventListener('click', function () {
      var slot = sheet.slot;
      closePicker();
      act('Gestartet · ' + nameOf(o.id) +
            (o.inputs.length > 0 ? ' · −' + costText(o.inputs) : ''),
          client.start(p.index, o.recipe, slot));
    });
    box.appendChild(card);
  });

  $('pick-bg').hidden = false;
}

function closePicker() {
  pickerPlot = null;
  sheet = { plot: null, mode: null, slot: 0 };
  $('pick-bg').hidden = true;
}

$('pick-close').addEventListener('click', closePicker);

$('pick-bg').addEventListener('click', function (e) {
  if (e.target === $('pick-bg')) closePicker();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && pickerPlot !== null) closePicker();
});

function tapBuy(i) {
  if (!isActive) return;
  client.localTick = tickNow();
  var level = nextLevelOf(i, client.preview().plots[i].level);
  if (!level) { toast('Voll ausgebaut'); return; }
  act(level.label + ' gekauft', client.buy(i));
}
