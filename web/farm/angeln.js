// Der Angelsee — eine eigene Dimension mit EIGENEM Raster. Über das Boot auf dem
// Hof reist man hinüber (wechselZone). Das Boot steht immer da, anfangs kaputt:
// Erst reparieren (Gold + Material), dann fährt es. Im See gibt es Wasser,
// Insel-Angelstellen und ein Strandhaus, in dem man Köder herstellt. Das Fangen
// selbst ist der deterministische Sim-Befehl CAST_LINE — hier nur Darstellung.

// Tippen aufs Hof-Boot: heil → rüber zum See, kaputt → Reparatur-Menü.
function bootTap() {
  if (!isActive) return;
  var v = NS.farmView(client.preview(), rules, navigator.onLine);
  var a = v.angeln;
  if (!a) { toast('Hier gibt es keinen See', true); return; }
  if (a.boot.repariert) { wechselZone(true); return; }
  oeffneBootReparatur();
}

function oeffneBootReparatur() {
  sheet = { plot: null, mode: 'boot', slot: 0 };
  pickerPlot = -1;
  var v = NS.farmView(client.preview(), rules, navigator.onLine);
  zeichneBootSheet(v);
  $('pick-bg').hidden = false;
}

function zeichneBootSheet(v) {
  var a = v.angeln;
  if (!a) { closePicker(); return; }
  $('pick-title').textContent = 'Kaputtes Boot';

  var box = $('pick-list');
  box.textContent = '';

  var text = document.createElement('p');
  text.className = 'empty';
  text.innerHTML = a.boot.reparierbar
    ? 'Das alte Boot ist morsch und leck. Mach es mit Gold und Material wieder flott — dann bringt es dich zum Angelsee. 🎣'
    : 'Das alte Boot ist morsch und leck. Ab Stufe ' + a.minLevel +
      ' kannst du es reparieren und zum Angelsee fahren.';
  box.appendChild(text);

  var knopf = document.createElement('button');
  knopf.type = 'button';
  knopf.className = 'abfahrt';
  knopf.disabled = !a.boot.reparierbar || !a.boot.bezahlbar;
  knopf.innerHTML = a.boot.reparierbar
    ? 'Reparieren · ' + stacksMitBild(a.boot.kosten) + (a.boot.bezahlbar ? '' : ' · fehlt')
    : 'ab Stufe ' + a.minLevel;
  knopf.addEventListener('click', function () {
    var res = client.repairBoat();
    if (!res.ok) { toast(CODES[res.code] || res.code, true); klang('fehler'); return; }
    toast('Das Boot fährt wieder! 🎣');
    klang('stufe');
    save();
    scheduleSync();
    closePicker();
    wechselZone(true); // gleich rüber zum See
  });
  box.appendChild(knopf);
}

// Das See-Raster mit seinen Objekten. Wird bei jedem render() im See gemalt.
// Die Angelstellen sind kleine Inseln (siehe artSeeObj 'spot'), am Strand oben
// links das Strandhaus (Köder herstellen), rechts der Steg zurück zum Hof.
function renderSeeWelt(v) {
  ['brett', 'lagerhaus', 'stand', 'nachbarn', 'wagen', 'kiste', 'boot'].forEach(function (id) {
    var e = $(id); if (e) e.hidden = true;
  });
  ['hindernisse', 'erweiterungen', 'kisten'].forEach(function (id) {
    var e = $(id); if (e) e.textContent = '';
  });
  // Der Hof merkt sich, was er zuletzt gezeichnet hat. Hier wird es geleert,
  // also muss die Erinnerung mit — sonst bleibt der Hof nach der Rueckkehr leer.
  hindernisStand = null;
  sperrStand = null;

  $('hof').classList.remove('kein-raster');
  var scene = $('scene');
  if (scene && scene.dataset.stand !== 'see') {
    scene.innerHTML = artScene();
    scene.dataset.stand = 'see';
  }

  var box = $('plots');
  box.textContent = '';

  var objekte = [
    { art: 'haus', gx: 1, gy: 0, w: 5, h: 3, tap: 'haus', label: 'Strandhaus' },
    { art: 'dock', gx: 18, gy: 0, w: 5, h: 3, tap: 'zurueck', label: 'Zum Hof' },
    { art: 'spot', gx: 3, gy: 5, w: 4, h: 3, tap: 'angeln' },
    { art: 'spot', gx: 15, gy: 4, w: 4, h: 3, tap: 'angeln' },
    { art: 'spot', gx: 9, gy: 8, w: 4, h: 3, tap: 'angeln' },
    { art: 'spot', gx: 19, gy: 9, w: 4, h: 3, tap: 'angeln' },
    { art: 'spot', gx: 4, gy: 10, w: 4, h: 3, tap: 'angeln' },
  ];

  objekte.forEach(function (o) {
    var k = feldKasten(o.gx, o.gy, o.w, o.h);
    // Auch im See wird aufgestellt statt gequetscht: Der Kasten waechst nach
    // oben, bis das Objekt wieder so hoch aussieht wie vor der Neigung.
    var hoch = stehHoehe(o.h);
    var tile = document.createElement('button');
    tile.className = 'plot see-obj' + (o.tap === 'angeln' ? ' see-spot' : '');
    tile.style.left = k.left + '%';
    tile.style.top = (k.top - hoch * zellH()) + '%';
    tile.style.width = k.breite + '%';
    tile.style.height = (k.hoehe + hoch * zellH()) + '%';
    tile.style.zIndex = String(1 + Math.round((o.gy + o.h) * 2));
    tile.innerHTML =
      '<svg class="art" viewBox="0 0 100 80" preserveAspectRatio="none" aria-hidden="true">' +
      artSeeObj(o.art) + '</svg>';
    if (o.label) {
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = '<div class="name">' + o.label + '</div>';
      tile.appendChild(meta);
    }
    tile.setAttribute('aria-label', o.label || 'Angelstelle');
    tile.addEventListener('click', function () { seeObjTap(o, tile); });
    box.appendChild(tile);
  });

  if (hatRaster()) weltFormat();
  if (!kamera.gesetzt && $('hof').getBoundingClientRect().width > 0) kameraStart();
}

function seeObjTap(o, tile) {
  if (o.tap === 'zurueck') { wechselZone(false); return; }
  if (o.tap === 'angeln') { angelWurf(tile); return; }
  if (o.tap === 'haus') { oeffneKoeder(); return; }
}

// Untere Leiste im See: nur noch Anzeige (Köder-Vorrat, Fänge). Zurück geht es
// über den Steg, Köder gibt es im Strandhaus — keine HUD-Knöpfe mehr.
function seeHudMalen(v) {
  var hud = $('see-hud');
  if (!hud) return;
  hud.hidden = false;
  var a = v.angeln;
  $('see-hud-info').innerHTML =
    iconTag('bait') + ' <b>' + (a ? a.bait : 0) + '</b> Köder · 🎣 ' + (a ? a.gefangen : 0) + ' Fänge';
}

// Strandhaus: Köder aus Weizen herstellen; zeigt auch, was im See beißt.
function oeffneKoeder() {
  sheet = { plot: null, mode: 'koeder', slot: 0 };
  pickerPlot = -1;
  var v = NS.farmView(client.preview(), rules, navigator.onLine);
  zeichneKoederSheet(v);
  $('pick-bg').hidden = false;
}

function zeichneKoederSheet(v) {
  var a = v.angeln;
  if (!a) { closePicker(); return; }
  $('pick-title').textContent = 'Strandhaus — Köder herstellen';

  var box = $('pick-list');
  box.textContent = '';

  var stand = document.createElement('p');
  stand.className = 'empty';
  stand.innerHTML = 'Im Lager: ' + iconTag('bait') + ' <b>' + a.bait + '</b> Köder';
  box.appendChild(stand);

  if (a.koeder) {
    var karte = document.createElement('button');
    karte.type = 'button';
    karte.className = 'card opt';
    karte.disabled = !a.koeder.bezahlbar;
    karte.innerHTML =
      '<div class="body"><div class="top">' + iconTag('bait') + a.koeder.output + ' Köder herstellen</div>' +
      '<div class="sub">' + stacksMitBild(a.koeder.input) +
      (a.koeder.bezahlbar ? '' : ' · fehlt') + '</div></div>' +
      '<span class="yield">＋</span>';
    karte.addEventListener('click', function () {
      var res = client.craftBait();
      if (!res.ok) { toast(CODES[res.code] || res.code, true); klang('fehler'); return; }
      toast(a.koeder.output + ' Köder hergestellt');
      klang('kauf');
      save();
      scheduleSync();
      render();
    });
    box.appendChild(karte);
  }

  var titel = document.createElement('p');
  titel.className = 'empty';
  titel.style.marginBottom = '0';
  titel.textContent = 'Das beißt hier:';
  box.appendChild(titel);

  a.table.forEach(function (f) {
    var zeile = document.createElement('div');
    zeile.className = 'card opt';
    zeile.innerHTML =
      '<div class="body"><div class="top">' + itemIcon(f.item) + itemName(f.item) + '</div></div>' +
      '<span class="yield">' + f.chance + ' %</span>';
    box.appendChild(zeile);
  });
}

function angelWurf(tile) {
  if (!isActive) return;
  var vorher = client.preview().items.slice();
  var res = client.castLine();
  if (!res.ok) {
    toast(CODES[res.code] || res.code, true);
    klang('fehler');
    return;
  }
  var nachher = client.preview().items;
  var fisch = -1;
  for (var i = 0; i < nachher.length; i++) {
    if ((nachher[i] || 0) > (vorher[i] || 0) && rules.items[i].id.indexOf('fish-') === 0) {
      fisch = i;
      break;
    }
  }
  klang('ernte');
  save();
  scheduleSync();
  render();
  if (fisch >= 0) {
    toast('Gefangen: ' + itemName(fisch) + '! 🐟', false);
    var box = tile && tile.getBoundingClientRect ? tile.getBoundingClientRect() : null;
    if (box && box.width) zahlAuf(box, '+1 ' + itemName(fisch), 'ware');
  }
}
