// Der Angelsee — eine eigene Dimension mit EIGENEM Raster. Über das Boot auf dem
// Hof reist man hinüber (wechselZone). Das Boot steht immer da, anfangs kaputt:
// Erst reparieren (Gold + Material), dann fährt es.
//
// Gefischt wird mit Reusen, nicht auf Klick: Im Strandhaus siedet man Köder
// (dauert, begrenzte Plätze), legt ihn an eine Insel (BAIT_SPOT) und holt den
// Fang später ein (COLLECT_SPOT). Beides sind Sim-Befehle, die Wartezeit steckt
// also im Regelwerk und nicht in der Anzeige — hier ist nur Darstellung.

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

  // Was die Reparatur kostet, steht ueber dem Knopf — auf dem gruenen Knopf
  // selbst waeren die Zutaten-Chips nicht zu lesen.
  if (a.boot.reparierbar) {
    var kosten = document.createElement('div');
    kosten.innerHTML = zutatenHtml(a.boot.kosten, lagerJetzt(), { titel: 'kostet' });
    box.appendChild(kosten);
  }

  var knopf = document.createElement('button');
  knopf.type = 'button';
  knopf.className = 'abfahrt';
  knopf.disabled = !a.boot.reparierbar || !a.boot.bezahlbar;
  knopf.innerHTML = a.boot.reparierbar
    ? 'Reparieren' + (a.boot.bezahlbar ? '' : ' · es fehlt noch etwas')
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
// Die Angelstellen sind kleine Inseln (siehe artSeeRaum 'spot'), am Strand oben
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
  // Der See ist kleiner als der Bildschirm; ohne das hier laege ringsum Wiese.
  $('hof').classList.add('see-zone');
  var scene = $('scene');
  if (scene && scene.dataset.stand !== 'see') {
    scene.innerHTML = artScene();
    scene.dataset.stand = 'see';
  }

  var box = $('plots');
  box.textContent = '';

  var objekte = [
    // Haus steht auf dem Sand, der Steg ragt von dort ins Wasser.
    { art: 'haus', gx: 1, gy: -1, w: 5, h: 3, tap: 'haus', label: 'Strandhaus' },
    { art: 'dock', gx: 18, gy: -1, w: 5, h: 3, tap: 'zurueck', label: 'Zum Hof' },
    { art: 'spot', gx: 3, gy: 5, w: 4, h: 3, tap: 'angeln', stelle: 0 },
    { art: 'spot', gx: 15, gy: 4, w: 4, h: 3, tap: 'angeln', stelle: 1 },
    { art: 'spot', gx: 9, gy: 8, w: 4, h: 3, tap: 'angeln', stelle: 2 },
    { art: 'spot', gx: 19, gy: 9, w: 4, h: 3, tap: 'angeln', stelle: 3 },
    { art: 'spot', gx: 4, gy: 10, w: 4, h: 3, tap: 'angeln', stelle: 4 },
  ];
  var stellen = (v.angeln && v.angeln.stellen) || [];

  objekte.forEach(function (o) {
    var k = feldKasten(o.gx, o.gy, o.w, o.h);
    // Auch im See wird aufgestellt statt gequetscht: Der Kasten waechst nach
    // oben, bis das Objekt wieder so hoch aussieht wie vor der Neigung.
    var m = koerperSee(o.art, o.w, o.h);
    var hoch = m.hoch;
    var tile = document.createElement('button');
    tile.className = 'plot see-obj' + (o.tap === 'angeln' ? ' see-spot' : '');
    tile.style.left = k.left + '%';
    tile.style.top = (k.top - hoch * zellH()) + '%';
    tile.style.width = k.breite + '%';
    tile.style.height = (k.hoehe + hoch * zellH()) + '%';
    tile.style.zIndex = String(1 + Math.round((o.gy + o.h) * 2));
    tile.innerHTML =
      '<svg class="art" viewBox="0 0 100 ' + m.vh + '" preserveAspectRatio="none" aria-hidden="true">' +
      artSeeRaum(o.art, m) + '</svg>';
    if (o.label) {
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = '<div class="name">' + o.label + '</div>';
      tile.appendChild(meta);
    }

    // Reuse: leer, zieht noch, oder voll. Voll bekommt eine Fisch-Blase,
    // ziehend einen Balken — dieselbe Sprache wie auf dem Hof.
    var st = o.stelle !== undefined ? stellen[o.stelle] : null;
    if (st) {
      tile.classList.add(st.fertig ? 'ripe' : st.belegt ? 'zieht-noch' : 'leer');
      if (st.fertig) {
        var blase1 = blase('fish-perch');
        blase1.style.width = blasenBreite(o.w);
        tile.appendChild(blase1);
      } else if (st.belegt) {
        var bar = document.createElement('div');
        bar.className = 'bar';
        var fill = document.createElement('i');
        fill.style.width = st.fortschritt + '%';
        bar.appendChild(fill);
        tile.appendChild(bar);
      }
    }
    tile.setAttribute('aria-label', o.label ||
      (st ? (st.fertig ? 'Volle Reuse einholen' : st.belegt ? 'Reuse zieht noch' : 'Köder legen') : 'Angelstelle'));
    tile.addEventListener('click', function () { seeObjTap(o, tile); });
    box.appendChild(tile);
  });

  if (hatRaster()) weltFormat();
  if (!kamera.gesetzt && $('hof').getBoundingClientRect().width > 0) kameraStart();
}

function seeObjTap(o, tile) {
  if (o.tap === 'zurueck') { wechselZone(false); return; }
  if (o.tap === 'angeln') { stelleTap(o.stelle, tile); return; }
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
    // Erst die Werkbank-Plätze: was siedet, was ist fertig, was ist frei.
    a.koeder.plaetze.forEach(function (platz) {
      var zeile = document.createElement('button');
      zeile.type = 'button';
      zeile.className = 'card opt' + (platz.fertig ? ' bereit' : '');
      if (platz.fertig) {
        zeile.innerHTML =
          '<div class="body"><div class="top">' + iconTag('bait') + a.koeder.output + ' Köder fertig</div>' +
          '<div class="sub">abholen und Platz frei machen</div></div><span class="yield">✓</span>';
        zeile.addEventListener('click', function () {
          var res = client.collectBait(platz.index);
          if (!res.ok) { toast(CODES[res.code] || res.code, true); klang('fehler'); return; }
          toast(a.koeder.output + ' Köder ins Lager');
          klang('ernte');
          save(); scheduleSync(); render();
        });
      } else if (platz.laeuft) {
        zeile.disabled = true;
        zeile.innerHTML =
          '<div class="body"><div class="top">Sud ' + (platz.index + 1) + ' · noch ' + timeText(platz.rest) + '</div>' +
          '<div class="sub"><span class="bar"><i style="width:' + platz.fortschritt + '%"></i></span></div></div>';
      } else {
        zeile.disabled = !a.koeder.bezahlbar;
        zeile.innerHTML =
          '<div class="body"><div class="top">' + iconTag('bait') + a.koeder.output + ' Köder sieden</div>' +
          '<div class="sub">dauert ' + timeText(a.koeder.dauer) + '</div>' +
          zutatenHtml(a.koeder.input, lagerJetzt(), { klasse: 'klein' }) + '</div>' +
          '<span class="yield">＋</span>';
        zeile.addEventListener('click', function () {
          var res = client.craftBait(platz.index);
          if (!res.ok) { toast(CODES[res.code] || res.code, true); klang('fehler'); return; }
          toast('Sud angesetzt · fertig in ' + timeText(a.koeder.dauer));
          klang('kauf');
          save(); scheduleSync(); render();
        });
      }
      box.appendChild(zeile);
    });
  }

  var titel = document.createElement('p');
  titel.className = 'empty';
  titel.style.marginBottom = '0';
  titel.textContent = 'Das geht hier ins Netz:';
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

// Eine Angelstelle antippen: leer → Köder legen, voll → einholen, sonst sagen
// wie lange es noch dauert.
function stelleTap(nummer, tile) {
  if (!isActive) return;
  var v = NS.farmView(client.preview(), rules, navigator.onLine);
  var st = v.angeln && v.angeln.stellen[nummer];
  if (!st) return;

  if (st.fertig) { reuseEinholen(nummer, tile); return; }
  if (st.belegt) {
    toast('Die Reuse zieht noch · ' + timeText(st.rest));
    return;
  }
  if (v.angeln.bait < 1) {
    toast('Kein Köder da — im Strandhaus welchen sieden', true);
    klang('fehler');
    oeffneKoeder();
    return;
  }
  var res = client.baitSpot(nummer);
  if (!res.ok) { toast(CODES[res.code] || res.code, true); klang('fehler'); return; }
  toast('Köder gelegt · fertig in ' + timeText(v.angeln.ziehdauer));
  klang('kauf');
  save();
  scheduleSync();
  render();
}

function reuseEinholen(nummer, tile) {
  var vorher = client.preview().items.slice();
  var res = client.collectSpot(nummer);
  if (!res.ok) { toast(CODES[res.code] || res.code, true); klang('fehler'); return; }

  var nachher = client.preview().items;
  var beute = [];
  for (var i = 0; i < nachher.length; i++) {
    var mehr = (nachher[i] || 0) - (vorher[i] || 0);
    if (mehr > 0) beute.push(mehr + ' ' + itemName(i));
  }
  klang('ernte');
  save();
  scheduleSync();
  render();
  toast(beute.length ? 'Eingeholt: ' + beute.join(', ') : 'Reuse eingeholt');
  var box = tile && tile.getBoundingClientRect ? tile.getBoundingClientRect() : null;
  if (box && box.width && beute.length) zahlAuf(box, '+' + beute[0], 'ware');
}
