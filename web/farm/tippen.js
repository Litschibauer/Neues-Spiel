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

function verschiebeKnopf(p, box) {
  if (!rules.grid || (rules.plots[p.index] && rules.plots[p.index].fixed)) return;
  var knopf = document.createElement('button');
  knopf.type = 'button';
  knopf.className = 'abfahrt skip';
  knopf.textContent = 'Verschieben';
  knopf.addEventListener('click', function () { verschiebe(p.index); });
  box.appendChild(knopf);
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
  verschiebeKnopf(p, box);
}

function renderSheet(v) {
  if (sheet.mode === null || sheet.plot === null) return;
  var p = v.plots[sheet.plot];
  if (!p) return;
  if (sheet.mode === 'stall') renderStall(p);
  else if (sheet.mode === 'recipes') zeichnePicker(p);
}

$('wagen').addEventListener('click', function () { show('brett'); });
$('bauen').addEventListener('click', function () { show('bau'); });

var setzePlot = -1;

function starteSetzen(plot, text) {
  setzePlot = plot;
  bauModus = true;
  $('hof').classList.add('setzt');
  $('setzen').hidden = false;
  $('setzen-text').textContent = text;
  render();
}

function endeSetzen() {
  setzePlot = -1;
  bauModus = false;
  $('hof').classList.remove('setzt');
  $('setzen').hidden = true;
  render();
}

function baueUndSetze(plot) {
  if (!isActive) return;
  client.localTick = tickNow();
  var vorher = client.preview().plots[plot].level;
  if (vorher <= 0) {
    var res = client.buy(plot);
    if (!res.ok) { toast(CODES[res.code] || res.code, true); return; }
    toast('Gekauft · ' + plotName(plot));
    save();
    scheduleSync();
  }
  show('farm');
  starteSetzen(plot, plotName(plot) + ' — wohin?');
}

function verschiebe(plot) {
  closePicker();
  show('farm');
  starteSetzen(plot, plotName(plot) + ' verschieben');
}

$('setzen-ab').addEventListener('click', function () {
  if (setzePlot >= 0 && client.preview().plots[setzePlot].gx < 0) {
    toast('Der Platz muss noch hingestellt werden', true);
    return;
  }
  endeSetzen();
});

$('hof').addEventListener('click', function (e) {
  if (setzePlot < 0) return;
  var feld = zeigerAufFeld(e);
  if (!feld) return;

  client.localTick = tickNow();
  var groesse = rules.plots[setzePlot].size || { w: 1, h: 1 };
  var g = rules.grid;
  var gx = Math.max(0, Math.min(g.w - groesse.w, feld.gx - (groesse.w >> 1)));
  var gy = Math.max(0, Math.min(g.h - groesse.h, feld.gy - (groesse.h >> 1)));

  var res = client.place(setzePlot, gx, gy);
  if (!res.ok) { toast(CODES[res.code] || res.code, true); render(); return; }

  toast(plotName(setzePlot) + ' steht');
  save();
  scheduleSync();
  endeSetzen();
});

$('kiste').addEventListener('click', function () {
  if (!isActive) return;
  client.localTick = tickNow();
  var offen = NS.farmView(client.preview(), rules, navigator.onLine).chests
    .filter(function (k) { return k.ready; });
  if (offen.length === 0) return;
  act('Kiste geöffnet · der Inhalt kommt mit der Post', client.openChest(offen[0].id));
});

function openPicker(p, slot) {
  sheet = { plot: p.index, mode: 'recipes', slot: slot === undefined ? sheet.slot : slot };
  pickerPlot = p.index;
  zeichnePicker(p);
  $('pick-bg').hidden = false;
}

function zeichnePicker(p) {
  var v = NS.farmView(client.preview(), rules, navigator.onLine);
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
      '<div class="top">' + iconTag(o.id) + nameOf(o.id) + '</div>' +
      '<div class="sub">' +
      (!o.unlocked
        ? 'ab Stufe ' + o.minPlayerLevel
        : (o.inputs.length > 0 ? costText(o.inputs) + ' · ' : '') +
          timeText(o.durationTicks) +
          (o.affordable ? '' : ' · Zutaten fehlen')) +
      '</div></div>' +
      '<span class="yield">+' + o.output.amount + ' ' + itemIcon(o.output.item, 'gross') + '</span>';
    card.addEventListener('click', function () {
      var slot = sheet.slot;
      closePicker();
      act('Gestartet · ' + nameOf(o.id) +
            (o.inputs.length > 0 ? ' · −' + costText(o.inputs) : ''),
          client.start(p.index, o.recipe, slot));
    });
    box.appendChild(card);

    if (o.unlocked && !o.affordable) nachkaufZeile(v, o, box);
  });

  verschiebeKnopf(p, box);
}

function nachkaufZeile(v, o, box) {
  o.inputs.forEach(function (zutat) {
    var lager = null;
    v.stock.forEach(function (e) { if (e.item === zutat.item) lager = e; });
    if (!lager || lager.npcBuyPrice <= 0) return;
    if (v.notkauf && lager.amount > 0) return;
    if (lager.amount >= zutat.amount) return;

    var kasten = document.createElement('div');
    kasten.className = 'nachkauf';

    var text = document.createElement('div');
    text.innerHTML = itemIcon(zutat.item) +
      (lager.amount === 0
        ? '<b>' + itemName(zutat.item) + ' ist ausgegangen.</b> Ein Korn zum Weitermachen:'
        : '<b>' + itemName(zutat.item) + '</b> reicht nicht — nachlegen:');
    kasten.appendChild(text);

    var knopf = document.createElement('button');
    knopf.type = 'button';
    knopf.className = 'kaufen';
    knopf.disabled = v.currency.amount < lager.npcBuyPrice || v.silo.free < 1;
    knopf.textContent = v.currency.amount < lager.npcBuyPrice
      ? 'zu wenig ' + itemName(v.currency.item)
      : v.silo.free < 1
      ? 'Lager voll'
      : '1 ' + itemName(zutat.item) + ' kaufen · ' + lager.npcBuyPrice + ' ' +
        itemName(v.currency.item);
    knopf.addEventListener('click', function () {
      act('Nachgekauft · 1 ' + itemName(zutat.item), client.buyNpc(zutat.item, 1));
    });
    kasten.appendChild(knopf);

    box.appendChild(kasten);
  });
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
  if (e.key !== 'Escape') return;
  if (pickerPlot !== null) closePicker();
  else if (view !== 'farm') show('farm');
});

function tapBuy(i) {
  if (!isActive) return;
  client.localTick = tickNow();
  var level = nextLevelOf(i, client.preview().plots[i].level);
  if (!level) { toast('Voll ausgebaut'); return; }
  act(level.label + ' gekauft', client.buy(i));
}
