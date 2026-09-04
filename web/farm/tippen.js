var syncSoon = null;
function scheduleSync() {
  if (engine) engine.hurry(Date.now());
  if (syncSoon) return;
  syncSoon = setTimeout(function () {
    syncSoon = null;
    attempt(false);
  }, 250);
}

function platzKasten(i) {
  var el = document.querySelector('#plots .plot[data-platz="' + i + '"]');
  return el ? el.getBoundingClientRect() : null;
}

function hoch(kasten) {
  if (!kasten) return null;
  return { left: kasten.left, top: kasten.top - 22, width: kasten.width, height: kasten.height };
}

function act(name, result, ton) {
  if (!isActive) return;
  if (result.ok) {
    toast(name);
    klang(ton || 'tipp');
    save();
    scheduleSync();
  } else {
    toast(CODES[result.code] || result.code, true);
    klang('fehler');
  }
  render();
}

function tapPlot(i) {
  if (!isActive) return;
  client.localTick = tickNow();
  var p = NS.farmView(client.preview(), rules, navigator.onLine).plots[i];

  if (p.baum) { tapBaum(p); return; }
  if (p.stall || p.capacity > 1) { openStall(p); return; }

  if (p.tap === 'collect') {
    var wo = platzKasten(i);
    var vorher = client.preview().xp;
    var res = client.collect(i);
    act('Geerntet · ' + p.output.amount + ' ' + itemName(p.output.item), res, 'ernte');
    if (res.ok) {
      zahlAuf(wo, '+' + p.output.amount + ' ' + itemName(p.output.item), 'ware');
      var dazu = client.preview().xp - vorher;
      if (dazu > 0) zahlAuf(hoch(wo), '+' + dazu + ' XP', 'xp');
    }
    return;
  }
  if (p.tap === 'buy') { tapBuy(i); return; }

  // Läuft das Gebäude gerade (Slot belegt)? Menü mit Status zeigen, statt beim
  // Tippen gar nicht zu reagieren.
  if (p.options.length >= 1 && p.busy) { openPicker(p, 0); return; }

  // Jedes Werkstatt-Gebäude öffnet sein Menü — auch die mit nur EINEM Rezept
  // (z. B. der Grill). Sonst reagiert so ein Gebäude beim Tippen scheinbar gar
  // nicht, während Öfen mit mehreren Rezepten ein Menü zeigen.
  if (p.options.length >= 1 && (p.tap === 'start' || p.blocked === 'inputs')) {
    openPicker(p, 0);
    return;
  }
  if (p.tap === 'start') {
    act('Gestartet · ' + nameOf(p.next.id) +
          (p.next.inputs.length > 0 ? ' · −' + costText(p.next.inputs) : ''),
        client.start(i, p.next.recipe), 'saat');
    return;
  }
  // Gebautes, nicht-festes Bauwerk ohne andere Aktion (z. B. Deko): Menü zum
  // Verschieben/Abreißen öffnen.
  if (p.level > 0 && rules.plots[i] && !rules.plots[i].fixed) { openPicker(p, 0); return; }
  if (p.blocked === 'inputs') toast('Zutaten fehlen', true);
  else if (p.blocked === 'level') toast('Erst ab Stufe ' + p.upgrade.minPlayerLevel, true);
  else if (p.blocked === 'cost') toast('Zu wenig ' + itemName(rules.currency), true);
}

function tapBaum(p) {
  var b = p.baum;
  if (b.stufe === 'reif') {
    var wo = platzKasten(p.index);
    var vorher = client.preview().xp;
    var res = client.harvestTree(p.index);
    act('Geerntet · ' + b.ertrag.amount + ' ' + itemName(b.ertrag.item), res, 'ernte');
    if (res.ok) {
      zahlAuf(wo, '+' + b.ertrag.amount + ' ' + itemName(b.ertrag.item), 'ware');
      var dazu = client.preview().xp - vorher;
      if (dazu > 0) zahlAuf(hoch(wo), '+' + dazu + ' XP', 'xp');
    }
    return;
  }
  if (b.stufe === 'verwelkt') {
    if (!b.kannFaellen) { toast('Zum Fällen brauchst du eine ' + itemName(b.faellenWerkzeug), true); return; }
    act('Baum gefällt', client.fellTree(p.index), 'ernte');
    return;
  }
  if (b.stufe === 'setzling') toast('Setzling · in ' + timeText(b.reifIn) + ' trägt er Äpfel');
  else toast('Äpfel reifen · noch ' + timeText(b.reifIn));
}

var sheet = { plot: null, mode: null, slot: 0 };
var pickerPlot = null;

function collectSlot(p, j) {
  var out = p.slots[j].output;
  var woTier = platzKasten(p.index);
  var erg = client.collect(p.index, j);
  act('Geerntet · ' + out.amount + ' ' + itemName(out.item), erg, 'ernte');
  if (erg.ok) zahlAuf(woTier, '+' + out.amount + ' ' + itemName(out.item), 'ware');
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
  card.className = 'card opt tierplatz';
  card.dataset.tier = s.animal || 'egal';

  if (s.animal === 'none') {
    var kosten = p.stall.cost;
    card.disabled = !p.stall.affordable;
    card.innerHTML =
      '<div class="body">' +
      '<div class="top">Leerer Platz</div>' +
      '<div class="sub">' + tier.jung + ' dazukaufen' +
      (p.stall.affordable ? '' : ' · Gold fehlt') + '</div>' +
      '</div>' +
      '<span class="yield">' + kosten + ' ' + itemName(rules.currency) + '</span>';
    card.addEventListener('click', function () {
      act(tier.jung + ' gekauft', client.buyAnimal(p.index), 'tier');
    });
    return card;
  }

  if (s.animal === 'young') {
    card.disabled = true;
    card.innerHTML =
      '<div class="body">' +
      '<div class="top">' + tier.jung + ' ' + (s.index + 1) + '</div>' +
      '<div class="sub">wird in ' + timeText(s.grownIn) + ' ' + tier.artikel + ' ' +
      tier.one + '</div>' +
      '</div>' +
      '<span class="yield">' + timeText(s.grownIn) + '</span>';
    return card;
  }

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
  var reihe = document.createElement('div');
  reihe.className = 'platzknoepfe';

  var knopf = document.createElement('button');
  knopf.type = 'button';
  knopf.className = 'abfahrt skip';
  knopf.textContent = 'Verschieben';
  knopf.addEventListener('click', function () { verschiebe(p.index); });
  reihe.appendChild(knopf);

  if (p.level > 0) {
    var ab = document.createElement('button');
    ab.type = 'button';
    ab.className = 'abfahrt abreissen';
    ab.textContent = 'Abreißen';
    ab.addEventListener('click', function () { abreissen(p.index, ab); });
    reihe.appendChild(ab);
  }
  box.appendChild(reihe);
}

// Zweimal tippen zum Bestätigen — kein hässlicher Browser-Dialog.
function abreissen(i, btn) {
  if (btn && !btn.dataset.sicher) {
    btn.dataset.sicher = '1';
    btn.textContent = 'Sicher? (halbes Gold zurück)';
    btn.classList.add('sicher');
    setTimeout(function () {
      if (btn) { btn.dataset.sicher = ''; btn.textContent = 'Abreißen'; btn.classList.remove('sicher'); }
    }, 3000);
    return;
  }
  closePicker();
  act(plotName(i) + ' abgerissen', client.removePlot(i), 'stufe');
}

function renderStall(p) {
  var tier = animalOf(p.index);
  $('pick-title').textContent = p.stall
    ? plotName(p.index) + ' — ' + p.stall.animals + ' von ' + p.stall.places + ' Plätzen'
    : plotName(p.index) + ' — ' + p.capacity + ' ' +
      (p.capacity === 1 ? tier.one : tier.many);

  var box = $('pick-list');
  box.textContent = '';

  var ready = p.slots.filter(function (s) { return s.done; });
  var hungry = p.slots.filter(function (s) {
    return !s.done && !s.busy && s.animal !== 'none' && s.animal !== 'young';
  });

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
  if (sheet.mode === 'hindernis') {
    var h = null;
    v.obstacles.forEach(function (x) { if (x.index === sheet.hindernis) h = x; });
    if (h) zeichneHindernis(h);
    else closePicker();
    return;
  }
  if (sheet.mode === null || sheet.plot === null) return;
  var p = v.plots[sheet.plot];
  if (!p) return;
  if (sheet.mode === 'stall') renderStall(p);
  else if (sheet.mode === 'recipes') zeichnePicker(p);
}

$('wagen').addEventListener('click', function () { show('brett'); });
$('bauen').addEventListener('click', function () { show('bau'); });

var setzePlot = -1;
var ziehen = null;
var klickSchlucken = 0;
var schwenk = null;

function schwenkStart(e) {
  if (!isActive || setzePlot >= 0 || bauModus) return;
  if (e.button !== undefined && e.button !== 0) return;
  schwenk = { x: e.clientX, y: e.clientY, kx: kamera.x, ky: kamera.y, aktiv: false };
}

function schwenkZu(e) {
  if (!schwenk) return false;
  var dx = e.clientX - schwenk.x;
  var dy = e.clientY - schwenk.y;
  if (!schwenk.aktiv) {
    if (Math.abs(dx) + Math.abs(dy) < 10) return false;
    schwenk.aktiv = true;
    $('hof').classList.add('schwenkt');
    if (ziehen) { clearTimeout(ziehen.timer); ziehen = null; }
  }
  kamera.x = schwenk.kx + dx;
  kamera.y = schwenk.ky + dy;
  kameraAnwenden();
  return true;
}

function schwenkEnde() {
  if (!schwenk) return;
  var war = schwenk;
  schwenk = null;
  $('hof').classList.remove('schwenkt');
  if (war.aktiv) klickSchlucken = Date.now();
}

function ziehStart(e, plot, tile) {
  if (!isActive || !hatRaster() || setzePlot >= 0) return;
  if (rules.plots[plot] && rules.plots[plot].fixed) return;
  if (e.button !== undefined && e.button !== 0) return;

  ziehen = {
    plot: plot,
    tile: tile,
    x: e.clientX,
    y: e.clientY,
    aktiv: false,
    ziel: null,
    timer: setTimeout(function () { ziehLos(e); }, 420),
  };
}

function ziehLos(e) {
  if (!ziehen) return;
  ziehen.aktiv = true;
  bauModus = true;
  $('hof').classList.add('setzt');
  ziehen.tile.classList.add('zieht');
  $('setzen').hidden = false;
  $('setzen-text').textContent = plotName(ziehen.plot) + ' verschieben';
  if (navigator.vibrate) navigator.vibrate(12);
  render();
  ziehZu(e);
}

function ziehZu(e) {
  if (!ziehen || !ziehen.aktiv) return;
  var feld = zeigerAufFeld(e);
  if (!feld) return;

  var ziel = feldFuer(ziehen.plot, feld);
  var geht = passtHin(ziehen.plot, ziel.gx, ziel.gy);
  ziehen.ziel = geht ? ziel : null;
  ziehen.tile.classList.toggle('geht-nicht', !geht);

  var kasten = plotKasten(ziehen.plot, { gx: ziel.gx, gy: ziel.gy });
  ziehen.tile.style.left = kasten.left + '%';
  ziehen.tile.style.top = kasten.top + '%';
  ziehen.tile.style.width = kasten.width + '%';
  ziehen.tile.style.height = kasten.height + '%';
}

function ziehEnde() {
  if (!ziehen) return;
  clearTimeout(ziehen.timer);
  var war = ziehen;
  ziehen = null;

  if (!war.aktiv) return;

  klickSchlucken = Date.now();
  war.tile.classList.remove('zieht', 'geht-nicht');
  bauModus = false;
  $('hof').classList.remove('setzt');
  $('setzen').hidden = true;

  if (war.ziel) {
    client.localTick = tickNow();
    var res = client.place(war.plot, war.ziel.gx, war.ziel.gy);
    if (res.ok) { toast(plotName(war.plot) + ' steht jetzt hier'); save(); scheduleSync(); }
    else toast(CODES[res.code] || res.code, true);
  }
  render();
}

document.addEventListener('pointermove', function (e) {
  if (ziehen && ziehen.aktiv) { e.preventDefault(); ziehZu(e); return; }
  if (schwenk) { if (schwenkZu(e)) e.preventDefault(); return; }
  if (ziehen && !ziehen.aktiv) {
    var weit = Math.abs(e.clientX - ziehen.x) + Math.abs(e.clientY - ziehen.y);
    if (weit > 12) { clearTimeout(ziehen.timer); ziehen = null; }
  }
}, { passive: false });

document.addEventListener('pointerup', function (e) { ziehEnde(); schwenkEnde(); });
document.addEventListener('pointercancel', function (e) { ziehEnde(); schwenkEnde(); });

$('hof').addEventListener('pointerdown', function (e) {
  if (e.target.closest('.zahnrad, .setzen, .moebel')) return;
  schwenkStart(e);
});

$('hof').addEventListener('wheel', function (e) {
  if (!isActive || !hatRaster() || bauModus) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    kameraZoomen(e.deltaY < 0 ? 1.12 : 0.89, e.clientX, e.clientY);
  } else {
    kamera.x -= e.deltaX;
    kamera.y -= e.deltaY;
    kameraAnwenden();
  }
}, { passive: false });

var kneifDist = 0;
$('hof').addEventListener('touchmove', function (e) {
  if (e.touches.length !== 2) return;
  e.preventDefault();
  var a = e.touches[0], b = e.touches[1];
  var d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  var mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
  if (kneifDist > 0) kameraZoomen(d / kneifDist, mx, my);
  kneifDist = d;
}, { passive: false });
$('hof').addEventListener('touchend', function () { kneifDist = 0; });

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

function tippeHindernis(h) {
  if (!isActive) return;
  sheet = { plot: null, mode: 'hindernis', slot: 0, hindernis: h.index };
  pickerPlot = -1;
  zeichneHindernis(h);
  $('pick-bg').hidden = false;
}

function zeichneHindernis(h) {
  $('pick-title').textContent = hindernisName(h.kind);

  var box = $('pick-list');
  box.textContent = '';

  var text = document.createElement('p');
  text.className = 'empty';
  text.innerHTML = h.kind === 'pond'
    ? 'Ein Tümpel. Mit einer Schaufel bekommst du ihn trocken.'
    : h.kind === 'rock'
    ? 'Ein Felsbrocken. Eine Spitzhacke macht daraus Platz.'
    : 'Ein Baum. Mit einer Säge ist er schnell weg.';
  box.appendChild(text);

  var knopf = document.createElement('button');
  knopf.className = 'abfahrt';
  knopf.disabled = !h.removable;
  knopf.innerHTML = h.removable
    ? 'Wegräumen · ' + itemIcon(h.tool) + '1 ' + itemName(h.tool) + ' · +' + h.xp + ' XP'
    : itemIcon(h.tool) + itemName(h.tool) + ' fehlt — steckt in den Kisten';
  knopf.addEventListener('click', function () {
    closePicker();
    act(hindernisName(h.kind) + ' weggeräumt · +' + h.xp + ' XP',
        client.clearObstacle(h.index));
  });
  box.appendChild(knopf);
}

function oeffneKiste(id) {
  if (!isActive) return;
  client.localTick = tickNow();
  act('Kiste geöffnet · der Inhalt kommt mit der Post', client.openChest(id), 'kiste');
}

$('kiste').addEventListener('click', function () {
  if (!isActive) return;
  client.localTick = tickNow();
  var offen = NS.farmView(client.preview(), rules, navigator.onLine).chests
    .filter(function (k) { return k.ready; });
  if (offen.length === 0) return;
  oeffneKiste(offen[0].id);
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

  // Status des angetippten Slots: läuft gerade / ist fertig.
  var s0 = p.slots[sheet.slot];
  if (s0 && s0.done) {
    var fertig = document.createElement('button');
    fertig.type = 'button';
    fertig.className = 'card opt';
    fertig.innerHTML =
      '<div class="body"><div class="top">Fertig</div><div class="sub">' +
      (s0.output ? '+' + s0.output.amount + ' ' + itemName(s0.output.item) : 'bereit') +
      '</div></div><span class="yield">Ernten</span>';
    fertig.addEventListener('click', function () { closePicker(); collectSlot(p, sheet.slot); });
    box.appendChild(fertig);
  } else if (s0 && s0.busy) {
    var laeuft = document.createElement('div');
    laeuft.className = 'card opt laufend';
    laeuft.innerHTML =
      '<div class="body"><div class="top">Läuft gerade</div><div class="sub">' +
      nameOf(s0.producing) +
      (s0.output ? ' → +' + s0.output.amount + ' ' + itemName(s0.output.item) : '') +
      '</div></div><span class="yield">noch ' + timeText(s0.remaining) + '</span>';
    box.appendChild(laeuft);
  }

  // Rezepte nur zum Starten zeigen, wenn der Slot frei ist.
  if (s0 && (s0.busy || s0.done)) { verschiebeKnopf(p, box); return; }

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
      '<span class="yield">' + ausbeuteHtml(o.recipe) + '</span>';
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
      act('Nachgekauft · 1 ' + itemName(zutat.item), client.buyNpc(zutat.item, 1), 'kauf');
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
