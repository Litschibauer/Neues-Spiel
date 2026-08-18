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
  if (sheet.mode === 'wagen') { renderFracht(v); return; }
  if (sheet.mode === null || sheet.plot === null) return;
  var p = v.plots[sheet.plot];
  if (sheet.mode === 'stall') renderStall(p);
}

function openTruck() {
  if (!isActive) return;
  sheet = { plot: null, mode: 'wagen', slot: 0 };
  pickerPlot = -1;
  client.localTick = tickNow();
  renderFracht(NS.farmView(client.preview(), rules, navigator.onLine));
  $('pick-bg').hidden = false;
}

function renderFracht(v) {
  var box = $('pick-list');
  box.textContent = '';
  var t = v.truck;
  $('pick-title').textContent = !t.here
    ? 'Der Wagen ist unterwegs'
    : t.waybill ? 'Frachtbrief' : 'Kein Frachtbrief';
  frachtInhalt(v, box);
}

function frachtInhalt(v, box) {
  var t = v.truck;

  if (!t.here) {
    box.innerHTML = '<p class="empty">Der Wagen ist unterwegs — zurück in ' +
      timeText(t.backIn) + '. Dann steht der nächste Frachtbrief an.</p>';
    return;
  }
  if (!t.waybill) {
    box.innerHTML = '<p class="empty">Gerade liegt nichts an. Beim nächsten Sync kommt Arbeit.</p>';
    return;
  }

  var liste = document.createElement('div');
  liste.className = 'frachtbrief';

  t.waybill.stacks.forEach(function (p) {
    var zeile = document.createElement('div');
    zeile.className = 'posten' + (p.missing === 0 ? ' fertig' : '');

    var was = document.createElement('div');
    was.className = 'was';
    was.innerHTML = '<b>' + itemName(p.item) + '</b><span>' +
      (p.missing === 0 ? 'vollständig' : 'im Lager: ' + p.have) + '</span>';

    var zahl = document.createElement('div');
    zahl.className = 'zahl';
    zahl.textContent = p.loaded + ' / ' + p.wanted;

    zeile.appendChild(was);
    zeile.appendChild(zahl);

    if (p.missing > 0) {
      var laden = document.createElement('button');
      laden.className = 'abfahrt laden';
      laden.disabled = p.loadable <= 0;
      laden.textContent = p.loadable > 0 ? '+ ' + p.loadable : 'fehlt';
      laden.addEventListener('click', function () {
        act('Geladen · ' + p.loadable + ' ' + itemName(p.item),
            client.loadTruck(p.index, p.loadable));
      });
      zeile.appendChild(laden);
    }

    liste.appendChild(zeile);
  });

  var lohn = document.createElement('div');
  lohn.className = 'lohn';
  lohn.innerHTML = '<span>Lohn</span><b>' + stacks(t.waybill.reward) +
    ' · ' + t.waybill.xp + ' XP</b>';
  liste.appendChild(lohn);

  var los = document.createElement('button');
  los.className = 'abfahrt';
  los.disabled = !t.waybill.full;
  los.textContent = t.waybill.full
    ? 'Abfahren · ' + stacks(t.waybill.reward)
    : 'Erst vollständig beladen';
  los.addEventListener('click', function () {
    act('Wagen abgefahren · ' + stacks(t.waybill.reward), client.sendTruck());
  });
  liste.appendChild(los);

  if (v.skip.enabled) {
    var weg = document.createElement('button');
    weg.className = 'abfahrt skip';
    weg.disabled = !t.skippable;
    weg.textContent = t.skippable
      ? 'Wegschicken'
      : 'Wegschicken wieder in ' + timeText(v.skip.readyIn);
    weg.addEventListener('click', function () {
      act('Frachtbrief weggeschickt', client.skipRequest(t.waybill.id));
    });
    liste.appendChild(weg);
  }

  if (t.next) {
    var naechster = document.createElement('p');
    naechster.className = 'empty naechste';
    naechster.textContent = 'Als Nächstes: ' + stacks(t.next.wants) +
      ' für ' + stacks(t.next.reward);
    liste.appendChild(naechster);
  }

  box.appendChild(liste);
}

$('wagen').addEventListener('click', openTruck);

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
