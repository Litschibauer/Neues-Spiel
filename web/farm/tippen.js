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

// Beim ersten Antippen eines Bauwerks mit eigener Einführung: kurz erklären.
var FEATURE_PLATZ = {
  mine: 'mine',
  workshop: 'werkstatt',
  woodlot: 'waldstueck',
  smokehouse: 'raeucherei',
  kitchen: 'hofkueche',
};

// — Fundstuecke ————————————————————————————————————————————————————————
// Was beim Ernten obendrauf lag, rechnet die Sim aus — deterministisch aus dem
// Spielstand, damit Server und Geraet dasselbe finden. Die Oberflaeche braucht
// dafuer keinen zweiten Kanal: Sie vergleicht das Lager vor und nach der Ernte
// und zieht ab, was der Platz ohnehin gebracht haette. Was uebrig bleibt, lag
// im Acker.
function ertragVon(i, j) {
  var platz = client.preview().plots[i];
  var slot = platz && platz.slots ? platz.slots[j || 0] : null;
  if (!slot || typeof slot.recipe !== 'number' || slot.recipe < 0) return [];
  return ausbeute(slot.recipe);
}

function fundAus(vor, nach, erwartet) {
  var offen = [];
  (erwartet || []).forEach(function (e) { offen[e.item] = (offen[e.item] || 0) + e.amount; });
  for (var i = 0; i < nach.length; i++) {
    var dazu = (nach[i] || 0) - (vor[i] || 0) - (offen[i] || 0);
    if (dazu > 0) return { item: i, amount: dazu };
  }
  return null;
}

function fundText(fund) {
  return fund ? ' · Fund: ' + fund.amount + ' ' + stueckName(fund.amount, fund.item) : '';
}

// Ein Fund darf sich nicht anfuehlen wie eine Ernte mehr: eigener Klang,
// eigene Farbe, ein Stoss im Handteller.
function fundFeiern(wo, fund) {
  if (!fund) return;
  klang('fund');
  zahlAuf(hoch(wo), 'Fund! ' + fund.amount + ' ' + stueckName(fund.amount, fund.item), 'fund');
  if (fund.item === rules.currency) muenzenFliegen(wo, fund.amount);
  else flugZu(wo, $('silo'), itemIcon(fund.item), 'ware', 1);
  if (navigator.vibrate) navigator.vibrate([10, 40, 18]);
}

function tapPlot(i) {
  var featureId = FEATURE_PLATZ[rules.plots[i] && rules.plots[i].id];
  if (featureId && typeof featureTutorial === 'function') featureTutorial(featureId);
  if (!isActive) return;
  client.localTick = tickNow();
  var p = NS.farmView(client.preview(), rules, navigator.onLine).plots[i];

  if (p.baum) { tapBaum(p); return; }
  if (p.stall || p.capacity > 1) { openStall(p); return; }

  if (p.tap === 'collect') {
    var wo = platzKasten(i);
    var vorher = client.preview().xp;
    var vorLager = client.preview().items.slice();
    var erwartet = ertragVon(i, 0);
    var res = client.collect(i);
    var fund = res.ok ? fundAus(vorLager, client.preview().items, erwartet) : null;
    act('Geerntet · ' + p.output.amount + ' ' + itemName(p.output.item) + fundText(fund), res, 'ernte');
    if (res.ok) {
      zahlAuf(wo, '+' + p.output.amount + ' ' + itemName(p.output.item), 'ware');
      warenFliegen(wo, p.output.item, p.output.amount);
      var dazu = client.preview().xp - vorher;
      if (dazu > 0) xpAuf(wo, dazu);
      fundFeiern(hoch(wo), fund);
    }
    return;
  }
  // Noch nicht gebaut? Erst zeigen, was es braucht (Stufe, Kosten, freies Land)
  // — statt still Gold abzubuchen oder gar nicht zu reagieren.
  if (p.level <= 0 && p.upgrade) { oeffneBauInfo(p.index); return; }
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
    if (istFeld(p)) merkeSaat(p.next.recipe);
    var gestartet = client.start(i, p.next.recipe);
    act('Gestartet · ' + nameOf(p.next.id) +
          (p.next.inputs.length > 0 ? ' · −' + costText(p.next.inputs) : ''),
        gestartet, 'saat');
    if (gestartet.ok) saatFliegt(i, p.next.inputs);
    return;
  }
  // Gebautes, nicht-festes Bauwerk ohne andere Aktion (z. B. Deko): Menü zum
  // Verschieben/Abreißen öffnen.
  if (p.level > 0 && rules.plots[i] && !rules.plots[i].fixed) { openPicker(p, 0); return; }
  if (p.blocked === 'inputs') { toast('Zutaten fehlen', true); return; }
  if (p.blocked === 'level') { toast('Erst ab Stufe ' + p.upgrade.minPlayerLevel, true); return; }
  if (p.blocked === 'cost') { toast('Zu wenig ' + itemName(rules.currency), true); return; }
  // Fallback: jedes gebaute Bauwerk reagiert beim Tippen — nie ins Leere.
  if (p.level > 0 && p.options.length >= 1) { openPicker(p, 0); return; }
}

function tapBaum(p) {
  var b = p.baum;
  if (b.stufe === 'reif') {
    var wo = platzKasten(p.index);
    var vorher = client.preview().xp;
    var vorLager = client.preview().items.slice();
    var res = client.harvestTree(p.index);
    var fund = res.ok ? fundAus(vorLager, client.preview().items, [b.ertrag]) : null;
    act('Geerntet · ' + b.ertrag.amount + ' ' + itemName(b.ertrag.item) + fundText(fund), res, 'ernte');
    if (res.ok) {
      zahlAuf(wo, '+' + b.ertrag.amount + ' ' + itemName(b.ertrag.item), 'ware');
      warenFliegen(wo, b.ertrag.item, b.ertrag.amount);
      var dazu = client.preview().xp - vorher;
      if (dazu > 0) xpAuf(wo, dazu);
      fundFeiern(hoch(wo), fund);
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
  var vorLager = client.preview().items.slice();
  var erwartet = ertragVon(p.index, j);
  var erg = client.collect(p.index, j);
  var fund = erg.ok ? fundAus(vorLager, client.preview().items, erwartet) : null;
  act('Geerntet · ' + out.amount + ' ' + itemName(out.item) + fundText(fund), erg, 'ernte');
  if (erg.ok) {
    zahlAuf(woTier, '+' + out.amount + ' ' + itemName(out.item), 'ware');
    warenFliegen(woTier, out.item, out.amount);
    fundFeiern(hoch(woTier), fund);
  }
}

function feedSlot(p, j) {
  var open = p.options.filter(function (o) { return o.unlocked; });
  if (open.length > 1) { openPicker(p, j); return; }
  if (open.length === 0) { toast('Erst ab einer höheren Stufe', true); return; }
  var o = open[0];
  act('Gestartet · ' + nameOf(o.id) + (o.inputs.length > 0 ? ' · −' + costText(o.inputs) : ''),
      client.start(p.index, o.recipe, j));
}

function slotStatus(p, s, lager) {
  if (s.done) return 'fertig · +' + s.output.amount + ' ' + itemName(s.output.item);
  if (s.busy) return 'noch ' + timeText(s.remaining) + ' · ' + nameOf(s.producing);
  var open = p.options.filter(function (o) { return o.unlocked; });
  if (open.length === 0) return 'kein Rezept frei';
  if (open.length > 1) return 'auswählen';
  var o = open[0];
  return timeText(o.durationTicks) + (o.affordable ? '' : ' · fehlt') +
    zutatenHtml(o.inputs, lager || lagerJetzt(), { klasse: 'klein' });
}

function stallRow(p, s, lager) {
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
    '<div class="sub">' + slotStatus(p, s, lager) + '</div>' +
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

  if (p.level > 0 && p.deco) {
    // Dekoration wird eingepackt (behalten & kostenlos wieder aufstellen).
    var ein = document.createElement('button');
    ein.type = 'button';
    ein.className = 'abfahrt skip';
    ein.textContent = 'Einpacken';
    ein.addEventListener('click', function () {
      closePicker();
      act(plotName(p.index) + ' eingepackt', client.packPlot(p.index), 'kauf');
    });
    reihe.appendChild(ein);
  } else if (p.level > 0) {
    var ab = document.createElement('button');
    ab.type = 'button';
    ab.className = 'abfahrt abreissen';
    ab.textContent = 'Abreißen';
    ab.addEventListener('click', function () { abreissen(p.index, ab); });
    reihe.appendChild(ab);
  }
  box.appendChild(reihe);
}

// Welches gesperrte Feld liegt unter einem Platz? null, wenn das Land frei ist.
function gesperrtesLandFuer(v, p) {
  var g = (rules.plots[p.index] && rules.plots[p.index].size) || { w: 1, h: 1 };
  if (p.gx < 0) return null;
  var treffer = null;
  (v.expansions || []).forEach(function (e) {
    if (e.unlocked || treffer) return;
    var raus =
      p.gx + g.w <= e.gx || e.gx + e.w <= p.gx || p.gy + g.h <= e.gy || e.gy + e.h <= p.gy;
    if (!raus) treffer = e;
  });
  return treffer;
}

// Bau-Info für ein noch nicht gebautes Bauwerk: Was kostet es, ab welcher Stufe,
// und liegt das Land drumherum überhaupt frei?
function oeffneBauInfo(plot) {
  sheet = { plot: plot, mode: 'bauinfo', slot: 0 };
  pickerPlot = plot;
  var v = NS.farmView(client.preview(), rules, navigator.onLine);
  zeichneBauInfo(v, v.plots[plot]);
  $('pick-bg').hidden = false;
}

function zeilenKarte(box, titel, text, ok) {
  var karte = document.createElement('div');
  karte.className = 'card opt' + (ok ? '' : ' laufend');
  karte.innerHTML =
    '<div class="body"><div class="top">' + titel + '</div>' +
    '<div class="sub">' + text + '</div></div>' +
    '<span class="yield">' + (ok ? '✓' : '✗') + '</span>';
  box.appendChild(karte);
}

function zeichneBauInfo(v, p) {
  if (!p || !p.upgrade) { closePicker(); return; }
  var u = p.upgrade;
  var land = gesperrtesLandFuer(v, p);
  $('pick-title').textContent = plotName(p.index) + ' — noch nicht gebaut';

  var box = $('pick-list');
  box.textContent = '';

  zeilenKarte(box, 'Stufe ' + u.minPlayerLevel, u.unlocked
    ? 'Stufe reicht'
    : 'Du bist noch nicht so weit', u.unlocked);

  zeilenKarte(box, 'Baukosten',
    (u.affordable ? 'alles da' : 'es fehlt noch etwas') +
    zutatenHtml(u.cost, lagerJetzt(), { titel: 'kostet' }), u.affordable);

  if (land) {
    zeilenKarte(box, 'Land freimachen',
      'Steht im gesperrten Land — erst „' + (land.reachedLevel
        ? 'Neues Land' : 'ab Stufe ' + land.minLevel) + '" freimachen', false);
  }

  var geht = u.unlocked && u.affordable && !land;
  var knopf = document.createElement('button');
  knopf.type = 'button';
  knopf.className = 'abfahrt';
  knopf.disabled = !geht;
  knopf.textContent = geht
    ? 'Bauen · ' + costText(u.cost)
    : land
      ? 'Erst das Land freimachen'
      : !u.unlocked
        ? 'Erst ab Stufe ' + u.minPlayerLevel
        : 'Es fehlt noch Material';
  knopf.addEventListener('click', function () {
    closePicker();
    tapBuy(p.index);
  });
  box.appendChild(knopf);
}

// Ausbauen-Karte im Menü statt einer schwebenden „+ Kosten"-Blase am Platz.
function ausbauKnopf(p, box) {
  if (!p.upgrade || p.idle) return;
  var u = p.upgrade;
  var karte = document.createElement('button');
  karte.type = 'button';
  karte.className = 'card opt ausbau';
  karte.disabled = !u.unlocked || !u.affordable;
  var sub = u.unlocked
    ? (u.affordable ? 'bereit' : 'es fehlt noch etwas')
    : 'ab Stufe ' + u.minPlayerLevel;
  karte.innerHTML =
    '<div class="body"><div class="top">Ausbauen · ' + u.label + '</div>' +
    '<div class="sub">' + sub + '</div>' +
    zutatenHtml(u.cost, u.unlocked ? lagerJetzt() : null, { titel: 'kostet' }) + '</div>' +
    '<span class="yield">' + (u.unlocked ? '＋' : '🔒') + '</span>';
  karte.addEventListener('click', function () { closePicker(); tapBuy(p.index); });
  box.appendChild(karte);
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
      '<div class="sub">' + hungry.length + ' Tiere' +
      (enough ? '' : ' · reicht nicht') + '</div>' +
      zutatenHtml(one.inputs, have, { faktor: hungry.length }) + '</div>';
    feedAll.addEventListener('click', function () {
      hungry.forEach(function (s) { feedSlot(p, s.index); });
    });
    box.appendChild(feedAll);
  }

  var lager = lagerJetzt();
  p.slots.forEach(function (s) { box.appendChild(stallRow(p, s, lager)); });
  meisterKarte(p, box);
  ausbauKnopf(p, box);
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
  if (sheet.mode === 'boot') { zeichneBootSheet(v); return; }
  if (sheet.mode === 'koeder') { zeichneKoederSheet(v); return; }
  if (sheet.mode === 'bauinfo') { zeichneBauInfo(v, v.plots[sheet.plot]); return; }
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
// — Ernten im Zug ————————————————————————————————————————————————————————
// Wie die Sichel in Hay Day: ueber reife Plaetze wischen erntet sie der Reihe
// nach. Es braucht dafuer keinen Modus und kein Werkzeug, weil der Zustand
// unter dem Finger entscheidet — nur ein erntereifer Platz startet einen Zug,
// auf allem anderen bleibt es beim Schwenken.
var ernteStart = null;
var ernteZug = null;
// Zuletzt bewusst gewaehltes Rezept. Der Sae-Zug nimmt es, damit man nicht bei
// jedem Feld neu waehlen muss.
//
// Und er startet AUSSCHLIESSLICH, wenn es diese Wahl schon gab. Ernten ist
// reiner Gewinn, ein Fehlgriff also harmlos — Saeen kostet Saatgut. Wer nur
// schwenken will und dabei ueber leere Felder faehrt, soll nicht ungewollt
// aussaeen. Damit entspricht es auch dem Vorbild: dort nimmt man erst den
// Saatsack in die Hand und zieht dann.
var letzteSaat = null;
var saeZug = null;

function saatSchluessel() {
  return accountId ? 'ns-saat-' + accountId : 'ns-saat';
}

function merkeSaat(recipe) {
  letzteSaat = recipe;
  try { localStorage.setItem(saatSchluessel(), String(recipe)); } catch (e) {}
}

// Nach einem Neustart soll die Geste sich genauso verhalten wie vorher.
function ladeSaat() {
  try {
    var roh = localStorage.getItem(saatSchluessel());
    letzteSaat = roh === null || roh === '' ? null : Number(roh);
  } catch (e) {
    letzteSaat = null;
  }
}

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
  if (!isActive || setzePlot >= 0) return;
  // Zu Besuch wird weder geerntet noch gesaet noch verschoben — nur geschaut.
  if (besuchAktiv()) return;
  if (e.button !== undefined && e.button !== 0) return;
  // Merken, wo der Finger aufgesetzt hat. Bewegt er sich gleich weiter und lag
  // er auf etwas Erntereifem, wird daraus ein Erntezug. Das steht vor den
  // Wachen unten, damit es auch fuer feste Plaetze und ohne Raster gilt.
  ernteStart = { plot: plot, x: e.clientX, y: e.clientY };
  if (!hatRaster()) return;
  if (rules.plots[plot] && rules.plots[plot].fixed) return;

  ziehen = {
    plot: plot,
    tile: tile,
    x: e.clientX,
    y: e.clientY,
    aktiv: false,
    ziel: null,
    timer: setTimeout(function () { ziehLos(e); }, 200),
  };
}

function ziehLos(e) {
  if (!ziehen) return;
  ziehen.aktiv = true;
  ernteStart = null;
  // Der Schwenk, der beim selben Fingerdruck mit angestoßen wurde, tritt zurück:
  // Jetzt wird verschoben, nicht geschwenkt.
  if (schwenk) { schwenk = null; $('hof').classList.remove('schwenkt'); }
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

// Welcher Platz liegt gerade unter dem Finger? Die Kacheln tragen ihren Index
// schon als data-platz, deshalb reicht der Treffer unter dem Zeiger — das ist
// robuster als die Rastermathematik, weil Gebaeude ueber ihren Standplatz
// hinausragen.
function platzUnterZeiger(e) {
  var el = document.elementFromPoint(e.clientX, e.clientY);
  var kachel = el && el.closest ? el.closest('.plot[data-platz]') : null;
  return kachel ? Number(kachel.dataset.platz) : -1;
}

// Nur einfache Ein-Platz-Ernten werden gewischt. Baeume und Staelle haben eigene
// Abläufe (faellen, fuettern) — die gehoeren nicht in einen Wisch.
function erntbar(i) {
  var p = NS.farmView(client.preview(), rules, navigator.onLine).plots[i];
  return !!p && !p.baum && !p.stall && p.capacity <= 1 && p.tap === 'collect';
}

function ernteZugLos(i, e) {
  // Ein Tick fuer den ganzen Zug: Der Server weist Befehle ab, deren Tick
  // zurueckspringt, und pro Platz neu zu stellen bringt nichts.
  client.localTick = tickNow();
  ernteZug = { hatte: {}, zahl: 0, menge: {}, funde: 0, fundMenge: {},
    xp: client.preview().xp, voll: false, letzter: -1 };
  if (schwenk) { schwenk = null; $('hof').classList.remove('schwenkt'); }
  if (ziehen) { clearTimeout(ziehen.timer); ziehen = null; }
  $('hof').classList.add('erntet');
  ernteSchritt(i);
  ernteZugZu(e);
}

function ernteZugZu(e) {
  if (!ernteZug || ernteZug.voll) return;
  var i = platzUnterZeiger(e);
  if (i < 0 || i === ernteZug.letzter) return;
  ernteZug.letzter = i;
  ernteSchritt(i);
}

function ernteSchritt(i) {
  if (!ernteZug || ernteZug.voll || ernteZug.hatte[i]) return;
  var p = NS.farmView(client.preview(), rules, navigator.onLine).plots[i];
  if (!p || p.baum || p.stall || p.capacity > 1 || p.tap !== 'collect') return;
  if (!p.output) return;

  var wo = platzKasten(i);
  var vorLager = client.preview().items.slice();
  var erwartet = ertragVon(i, 0);
  var res = client.collect(i);
  if (!res.ok) {
    // Lager voll mitten im Zug: hier abbrechen und am Ende EINMAL sagen, wie
    // weit man gekommen ist — nicht bei jedem weiteren Platz erneut meckern.
    if (res.code === 'SILO_FULL') ernteZug.voll = true;
    return;
  }

  ernteZug.hatte[i] = true;
  ernteZug.zahl++;
  ernteZug.menge[p.output.item] = (ernteZug.menge[p.output.item] || 0) + p.output.amount;
  zahlAuf(wo, '+' + p.output.amount + ' ' + itemName(p.output.item), 'ware');
  warenFliegen(wo, p.output.item, p.output.amount, 2);
  var fund = fundAus(vorLager, client.preview().items, erwartet);
  if (fund) {
    ernteZug.funde++;
    ernteZug.fundMenge[fund.item] = (ernteZug.fundMenge[fund.item] || 0) + fund.amount;
    fundFeiern(hoch(wo), fund);
  }
  ernteKlang(ernteZug.zahl - 1);
  if (navigator.vibrate) navigator.vibrate(8);
  // Der volle Neuaufbau kommt erst am Zugende — bis dahin darf die Kachel nicht
  // weiter reif aussehen, sonst laeuft die Anzeige dem Finger hinterher.
  var kachel = document.querySelector('#plots .plot[data-platz="' + i + '"]');
  if (kachel) {
    kachel.classList.remove('ripe');
    var badge = kachel.querySelector('.badge');
    if (badge) badge.remove();
  }
  // Gold, XP und vor allem der Lagerbalken laufen waehrend des Zugs mit — man
  // muss sehen, dass das Lager gleich voll ist. Das ist nur der Kopf, nicht der
  // teure Neuaufbau der Kacheln.
  renderPurse(NS.farmView(client.preview(), rules, navigator.onLine));
}

// — Saeen im Zug ————————————————————————————————————————————————————————
// Die andere Haelfte der Sichel: ueber leere Felder wischen setzt ueberall
// dasselbe an. Welches Rezept, entscheidet nicht der Finger, sondern die
// letzte bewusste Wahl — sonst muesste man mitten im Zug etwas auswaehlen.
// Nur ein gewoehnliches Feld saet man im Zug an: kein Baum, kein Stall, kein
// Platz mit mehreren Faechern.
function istFeld(p) {
  return !!p && !p.baum && !p.stall && !(p.capacity > 1);
}

function saatFuer(p) {
  if (!istFeld(p) || p.tap !== 'start') return null;
  var offen = p.options.filter(function (o) { return o.unlocked; });
  if (offen.length === 0) return null;
  // Nur die gemerkte Sorte, und nur wenn sie auf diesem Platz ueberhaupt geht.
  var gewaehlt = null;
  offen.forEach(function (o) { if (o.recipe === letzteSaat) gewaehlt = o; });
  return gewaehlt;
}

function saebar(i) {
  if (letzteSaat === null) return false;
  var p = NS.farmView(client.preview(), rules, navigator.onLine).plots[i];
  var saat = saatFuer(p);
  return !!saat && saat.affordable && saat.recipe === letzteSaat;
}

function saeZugLos(i, e) {
  client.localTick = tickNow();
  saeZug = { hatte: {}, zahl: 0, was: null, leer: false, letzter: -1 };
  if (schwenk) { schwenk = null; $('hof').classList.remove('schwenkt'); }
  if (ziehen) { clearTimeout(ziehen.timer); ziehen = null; }
  $('hof').classList.add('saet');
  saeSchritt(i);
  saeZugZu(e);
}

function saeZugZu(e) {
  if (!saeZug || saeZug.leer) return;
  var i = platzUnterZeiger(e);
  if (i < 0 || i === saeZug.letzter) return;
  saeZug.letzter = i;
  saeSchritt(i);
}

function saeSchritt(i) {
  if (!saeZug || saeZug.leer || saeZug.hatte[i]) return;
  var p = NS.farmView(client.preview(), rules, navigator.onLine).plots[i];
  var saat = saatFuer(p);
  if (!saat) return;
  // Der Zug bleibt bei einer Sorte — sonst saet ein Wisch quer ueber den Hof
  // ein Durcheinander, das man einzeln wieder zurueckbauen muesste.
  if (saeZug.was !== null && saat.recipe !== saeZug.was) return;

  var wo = platzKasten(i);
  var res = client.start(i, saat.recipe);
  if (!res.ok) {
    // Saatgut alle: hier abbrechen und am Ende EINMAL sagen, wie weit es kam.
    saeZug.leer = true;
    return;
  }

  saeZug.hatte[i] = true;
  saeZug.zahl++;
  saeZug.was = saat.recipe;
  saeZug.name = nameOf(saat.id);
  zahlAuf(wo, nameOf(saat.id), 'saat');
  saatFliegt(i, saat.inputs);
  ernteKlang(saeZug.zahl - 1);
  if (navigator.vibrate) navigator.vibrate(8);
  renderPurse(NS.farmView(client.preview(), rules, navigator.onLine));
}

function saeZugEnde() {
  if (!saeZug) return;
  var zug = saeZug;
  saeZug = null;
  $('hof').classList.remove('saet');
  if (zug.zahl === 0) return;

  klickSchlucken = Date.now();
  toast(zug.zahl + (zug.zahl === 1 ? ' Feld' : ' Felder') + ' angesetzt · ' + zug.name +
    (zug.leer ? ' · dann war Schluss' : ''), zug.leer);
  save();
  scheduleSync();
  render();
}

function ernteZugEnde() {
  if (!ernteZug) return;
  var zug = ernteZug;
  ernteZug = null;
  $('hof').classList.remove('erntet');
  if (zug.zahl === 0) return;

  // Der Fingerabdruck darf hinterher nicht noch als Tipp durchgehen.
  klickSchlucken = Date.now();

  var teile = Object.keys(zug.menge).map(function (k) {
    return '+' + zug.menge[k] + ' ' + itemName(Number(k));
  });
  var dazu = client.preview().xp - zug.xp;
  // Ein Zug, eine Meldung — nicht acht Toasts hintereinander.
  var fundTeile = Object.keys(zug.fundMenge).map(function (k) {
    return zug.fundMenge[k] + ' ' + stueckName(zug.fundMenge[k], Number(k));
  });
  toast(zug.zahl + (zug.zahl === 1 ? ' Platz' : ' Plätze') + ' geerntet · ' +
    teile.join(' · ') + (dazu > 0 ? ' · +' + dazu + ' XP' : '') +
    (zug.funde > 0 ? ' · Fund: ' + fundTeile.join(' · ') : '') +
    (zug.voll ? ' · Lager voll' : ''), zug.voll);
  save();
  scheduleSync();
  render();
}

document.addEventListener('pointermove', function (e) {
  if (ernteZug) { e.preventDefault(); ernteZugZu(e); return; }
  if (saeZug) { e.preventDefault(); saeZugZu(e); return; }
  if (ziehen && ziehen.aktiv) { e.preventDefault(); ziehZu(e); return; }

  // Wischt der Finger von einem reifen Platz weg, wird geerntet; von einem
  // leeren gesaet. Beides statt zu schwenken, und beides nur dort, wo man
  // ohnehin genau das tun wollte — ein Fehlgriff ist deshalb harmlos.
  if (ernteStart) {
    var los = Math.abs(e.clientX - ernteStart.x) + Math.abs(e.clientY - ernteStart.y);
    if (los > 16) {
      var start = ernteStart.plot;
      ernteStart = null;
      if (erntbar(start)) { e.preventDefault(); ernteZugLos(start, e); return; }
      if (saebar(start)) { e.preventDefault(); saeZugLos(start, e); return; }
    }
  }

  // Solange ein Platz-Griff aussteht, hat er Vorrang: Der Schwenk darf ihn NICHT
  // stehlen. Erst wenn der Finger klar wegwischt (großer Weg, bevor der Halte-
  // Timer greift), ist es doch ein Schwenk — dann übergeben wir sauber.
  if (ziehen && !ziehen.aktiv) {
    var weit = Math.abs(e.clientX - ziehen.x) + Math.abs(e.clientY - ziehen.y);
    if (weit > 16) {
      clearTimeout(ziehen.timer);
      ziehen = null;
      if (schwenk && schwenkZu(e)) e.preventDefault();
    }
    return;
  }
  if (schwenk) { if (schwenkZu(e)) e.preventDefault(); return; }
}, { passive: false });

document.addEventListener('pointerup', function (e) {
  ernteStart = null; ernteZugEnde(); saeZugEnde(); ziehEnde(); schwenkEnde();
});
document.addEventListener('pointercancel', function (e) {
  ernteStart = null; ernteZugEnde(); saeZugEnde(); ziehEnde(); schwenkEnde();
});

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
    if (res.ok) bauMoment(plot);
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
  if (res.ok) bauMoment(setzePlot);
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

// Die Beute wuerfelt der Server; sie kommt mit dem naechsten Abgleich und wird
// dann enthuellt (momente.js). Ohne Netz dauert das bis zur naechsten Verbindung
// — das soll dastehen, sonst wartet man auf eine Karte, die nicht kommt.
function kisteText() {
  return navigator.onLine
    ? 'Kiste geöffnet · gleich siehst du, was drin war'
    : 'Kiste geöffnet · was drin war, siehst du mit der nächsten Verbindung';
}

function oeffneKiste(id) {
  if (!isActive) return;
  client.localTick = tickNow();
  act(kisteText(), client.openChest(id), 'kiste');
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
  if (s0 && (s0.busy || s0.done)) { meisterKarte(p, box); ausbauKnopf(p, box); verschiebeKnopf(p, box); return; }

  var lager = lagerAusSicht(v);
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
        : timeText(o.durationTicks) + (o.affordable ? '' : ' · Zutaten fehlen')) +
      '</div>' +
      zutatenHtml(o.inputs, o.unlocked ? lager : null) +
      '</div>' +
      '<span class="yield">' + ausbeuteHtml(o.recipe) + '</span>';
    card.addEventListener('click', function () {
      var slot = sheet.slot;
      closePicker();
      // Ein Stallrezept darf die gemerkte Saat nicht verdraengen — sonst waere
      // das Wischen nach einem Besuch im Huehnerstall stumm aus.
      if (istFeld(p)) merkeSaat(o.recipe);
      var los = client.start(p.index, o.recipe, slot);
      act('Gestartet · ' + nameOf(o.id) +
            (o.inputs.length > 0 ? ' · −' + costText(o.inputs) : ''),
          los);
      if (los.ok) saatFliegt(p.index, o.inputs);
    });
    box.appendChild(card);

    if (o.unlocked && !o.affordable) nachkaufZeile(v, o, box);
  });

  meisterKarte(p, box);
  ausbauKnopf(p, box);
  verschiebeKnopf(p, box);
}

// Die Meisterschaft eines Gebäudes: Sterne, der Weg zum nächsten und was die
// verdienten schon bringen. Steht unter den Rezepten — man soll erst arbeiten
// und dann sehen, wohin es führt.
function meisterKarte(p, box) {
  var m = p.meister;
  if (!m) return;
  var karte = document.createElement('div');
  karte.className = 'card meister';
  var html = '<div class="body"><div class="top">' + iconTag('stern') + 'Meisterschaft ' +
    '<span class="sterne-text">' + sterneText(m.sterne, m.maxSterne) + '</span></div>';
  if (m.ziel !== null) {
    var noch = m.ziel - m.punkte;
    html += '<div class="sub">Noch ' + noch + (noch === 1 ? ' Abholung' : ' Abholungen') +
      ' bis ' + sterneText(m.sterne + 1, m.sterne + 1) + ' · ' + meisterVorteil(m.sterne + 1, m) + '</div>' +
      '<div class="balken"><i style="width:' +
      Math.round((100 * (m.punkte - m.von)) / Math.max(1, m.ziel - m.von)) + '%"></i></div>';
  } else {
    html += '<div class="sub">Gemeistert — alle Sterne verdient</div>';
  }
  if (m.sterne > 0) {
    var gilt = [];
    for (var i = 1; i <= m.sterne; i++) gilt.push(meisterVorteil(i, m));
    html += '<div class="sub gilt">Gilt hier: ' + gilt.join(' · ') + '</div>';
  }
  karte.innerHTML = html + '</div>';
  box.appendChild(karte);
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
  var gekauft = client.buy(i);
  act(level.label + ' gekauft', gekauft);
  if (gekauft.ok) bauMoment(i);
}

// — Booster einsetzen ———————————————————————————————————————————————
function boosterEinsetzen(item) {
  if (!isActive) return;
  var v = NS.farmView(client.preview(), rules, navigator.onLine);
  var b = v.booster;
  if (!b) return;
  var xp = item === b.xpItem;
  var res = client.useBooster(item);
  act(xp ? '2× XP · die nächste halbe Stunde zählt doppelt'
         : 'Schnellwuchs · alles Laufende ist um die Hälfte weiter', res, 'stufe');
  if (!res.ok) return;
  if (xp) {
    var ring = document.querySelector('.ring');
    if (ring) zielHuepft(ring);
    konfetti();
  } else {
    // Jeder Platz, der vorgerueckt ist, meldet sich kurz.
    v.plots.forEach(function (p) {
      if (!p.busy || p.done || p.baum) return;
      var kachel = document.querySelector('#plots .plot[data-platz="' + p.index + '"]');
      if (kachel) {
        kachel.classList.add('zeigt');
        setTimeout(function () { kachel.classList.remove('zeigt'); }, 2600);
      }
      var wo = platzKasten(p.index);
      if (wo && wo.width) funken(wo, 'ware');
    });
  }
  if (navigator.vibrate) { try { navigator.vibrate([0, 30, 40, 30]); } catch (e) {} }
}
