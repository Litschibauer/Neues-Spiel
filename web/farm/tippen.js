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

var pickerPlot = null;

function openPicker(p) {
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
      closePicker();
      act('Gestartet · ' + nameOf(o.id) +
            (o.inputs.length > 0 ? ' · −' + costText(o.inputs) : ''),
          client.start(p.index, o.recipe));
    });
    box.appendChild(card);
  });

  $('pick-bg').hidden = false;
}

function closePicker() {
  pickerPlot = null;
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
