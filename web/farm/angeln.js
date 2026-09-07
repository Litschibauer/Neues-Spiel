// Der Angelsee — eine eigene Dimension mit EIGENEM Raster. Über das Boot auf dem
// Hof reist man hinüber (wechselZone), dort gibt es Wasser, Inseln, ein
// Strandhaus und Angelstellen zum Antippen. Das Fangen selbst ist der
// deterministische Sim-Befehl CAST_LINE — hier nur Darstellung & Bedienung.

// Boot-Knopf im HUD nur zeigen, wenn der See offen ist (und man auf dem Hof ist).
function seeKnopf(v) {
  var knopf = $('see-auf');
  if (!knopf) return;
  var imSee = typeof seeAktiv !== 'undefined' && seeAktiv;
  knopf.hidden = imSee || !(v.angeln && v.angeln.available);
}

function oeffneSee() {
  var v = NS.farmView(client.preview(), rules, navigator.onLine);
  if (!v.angeln) { toast('Hier gibt es keinen See', true); return; }
  if (!v.angeln.available) { toast('Der Angelsee öffnet ab Stufe ' + v.angeln.minLevel, true); return; }
  wechselZone(true);
}

// Das See-Raster mit seinen Objekten. Wird bei jedem render() im See gemalt.
function renderSeeWelt(v) {
  ['brett', 'lagerhaus', 'stand', 'nachbarn', 'wagen', 'kiste', 'boot'].forEach(function (id) {
    var e = $(id); if (e) e.hidden = true;
  });
  ['hindernisse', 'erweiterungen', 'kisten'].forEach(function (id) {
    var e = $(id); if (e) e.textContent = '';
  });

  $('hof').classList.remove('kein-raster');
  var scene = $('scene');
  if (scene && scene.dataset.stand !== 'see') {
    scene.innerHTML = artScene();
    scene.dataset.stand = 'see';
  }

  var box = $('plots');
  box.textContent = '';

  var objekte = [
    { art: 'haus', gx: 1, gy: 0, w: 6, h: 3, label: 'Strandhaus' },
    { art: 'dock', gx: 1, gy: 9, w: 6, h: 3, tap: 'zurueck', label: 'Zum Hof' },
    { art: 'spot', gx: 10, gy: 4, w: 2, h: 2, tap: 'angeln' },
    { art: 'spot', gx: 15, gy: 8, w: 2, h: 2, tap: 'angeln' },
    { art: 'spot', gx: 19, gy: 3, w: 2, h: 2, tap: 'angeln' },
    { art: 'spot', gx: 20, gy: 9, w: 2, h: 2, tap: 'angeln' },
  ];

  objekte.forEach(function (o) {
    var k = feldKasten(o.gx, o.gy, o.w, o.h);
    var tile = document.createElement('button');
    tile.className = 'plot see-obj' + (o.tap === 'angeln' ? ' see-spot' : '');
    tile.style.left = k.left + '%';
    tile.style.top = k.top + '%';
    tile.style.width = k.breite + '%';
    tile.style.height = k.hoehe + '%';
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
  toast('Das Strandhaus des Anglers 🎣');
}

// Untere Leiste im See: Köder-Vorrat, Fänge, Köder kaufen, zurück zum Hof.
function seeHudMalen(v) {
  var hud = $('see-hud');
  if (!hud) return;
  hud.hidden = false;
  var a = v.angeln;
  $('see-hud-info').innerHTML =
    iconTag('bait') + ' <b>' + (a ? a.bait : 0) + '</b> · 🎣 ' + (a ? a.gefangen : 0);
  var kb = $('see-hud-koeder');
  var kosten = a ? a.baitPrice * 5 : 0;
  kb.disabled = !a || v.currency.amount < kosten || !isActive;
  kb.textContent = '5 Köder · ' + kosten + ' Gold';
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
