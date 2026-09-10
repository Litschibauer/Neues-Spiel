function render() {
  if (!client) return;
  if (netzWache()) return;
  client.localTick = tickNow();
  var s = client.preview();
  var v = NS.farmView(s, rules, marktLive());

  renderPurse(v);
  // Die Menü-Bildschirme gehören zu keiner Zone: Sie müssen auch am See
  // gezeichnet werden, sonst steht man dort vor leeren Listen.
  renderBadges(v);
  renderZiele(v);
  renderAbenteuer(v);
  renderHofinfo(v);

  // Angel-Dimension: eigenes Raster, eigene Objekte — die Hof-Renderer bleiben aus.
  if (typeof seeAktiv !== 'undefined' && seeAktiv) {
    renderPlots(v);
    seeHudMalen(v);
    renderSheet(v); // Strandhaus-Menü (Köder) frisch halten
    return;
  }

  renderPlots(v);
  renderTruck(v);
  renderMoebel(v);
  renderHindernisse(v);
  renderErweiterungen(v);
  renderKisten(v);
  renderRequests(v);
  renderMail(v);
  renderMarket(v);
  renderVorrat(v);
  if (view === 'pfad') renderPfad(v);

  var typing = document.activeElement
    && document.activeElement.tagName === 'INPUT'
    && $('stand-bg').contains(document.activeElement);
  if (!typing) renderStand(v);
  renderAusbau(v);
  if (view === 'erweiterung') renderErweiterungSheet(v);
  renderBauliste(v);
  renderSheet(v);
  renderEmpfang();
  renderNaechstes(v);
  momentePruefen(v);
  winkeAnwenden();
  bonusKnopf();
  $('see-hud').hidden = true;
}

function renderPurse(v) {
  stufePruefen(v);
  $('lvl').textContent = v.level;
  $('gold').textContent = v.currency.amount;

  var pct = v.xp.atMax ? 1 : v.xp.into / v.xp.span;

  $('ring-fill').setAttribute(
    'stroke-dashoffset',
    String(Math.round(107 * (1 - Math.max(0, Math.min(1, pct))))),
  );
  $('xp').textContent = v.xp.atMax
    ? v.xp.total + ' XP · Höchststufe'
    : v.xp.into + ' / ' + v.xp.span + ' XP';

  $('silo-num').textContent = v.silo.used + '/' + v.silo.capacity;
  $('silo-fill').style.width = Math.min(100, Math.round((v.silo.used * 100) / v.silo.capacity)) + '%';
  $('silo').className = 'silo' + (v.silo.over ? ' over' : v.silo.full ? ' full' : '');
}

function plotStatus(p) {
  // Reine Dekoration hat keine Aufgabe — kein „nichts zu tun" anzeigen.
  if (p.deco) return '';
  if (p.baum) {
    var b = p.baum;
    if (b.stufe === 'reif') return 'reif · ' + b.ertrag.amount + ' ' + itemName(b.ertrag.item) + ' ernten';
    if (b.stufe === 'verwelkt') return 'verwelkt · mit Säge fällen';
    if (b.stufe === 'setzling') return 'Setzling · in ' + timeText(b.reifIn);
    return 'Äpfel reifen · noch ' + timeText(b.reifIn) + ' (' + b.geerntet + '/' + b.ernten + ')';
  }
  if (p.stall) {
    var art = animalOf(p.index);
    if (p.stall.animals === 0) return 'leer · ' + art.jung + ' kaufen';
    var fertig = 0;
    var laeuft = 0;
    var jung = 0;
    p.slots.forEach(function (s) {
      if (s.animal === 'young') jung++;
      else if (s.done) fertig++;
      else if (s.busy) laeuft++;
    });
    var hunger = p.stall.animals - fertig - laeuft - jung;
    var teile = [];
    if (fertig > 0) teile.push(fertig + ' fertig');
    if (laeuft > 0) teile.push(laeuft + ' beschäftigt · ' + timeText(p.remaining));
    if (hunger > 0) teile.push(hunger + ' hungrig');
    if (jung > 0) teile.push(jung + ' ' + art.jung);
    if (p.stall.free > 0) teile.push(p.stall.free + ' frei');
    return p.stall.animals + ' ' + (p.stall.animals === 1 ? art.one : art.many) +
      ' · ' + teile.join(' · ');
  }
  if (p.capacity > 1) {
    var tier = animalOf(p.index);
    var ready = 0;
    var busy = 0;
    p.slots.forEach(function (s) { if (s.done) ready++; else if (s.busy) busy++; });
    var hungry = p.capacity - ready - busy;
    var parts = [];
    if (ready > 0) parts.push(ready + ' fertig');
    if (busy > 0) parts.push(busy + ' beschäftigt · ' + timeText(p.remaining));
    if (hungry > 0) parts.push(hungry + ' hungrig');
    return p.capacity + ' ' + tier.many + ' · ' + parts.join(' · ');
  }
  if (p.done) return 'fertig · ' + nameOf(p.producing);
  if (p.busy) return timeText(p.remaining);
  if (p.blocked === 'level') return 'ab Stufe ' + p.upgrade.minPlayerLevel;
  if (p.blocked === 'inputs') return 'Zutaten fehlen';
  if (p.tap === 'buy') return p.upgrade.label + ' · ' + costText(p.upgrade.cost);

  // Leeres, bepflanzbares Feld: kein „Weizen oder Mais" mehr — nur der Name „Feld".
  var istFeld = rules.plots[p.index] && rules.plots[p.index].id.indexOf('field-') === 0;
  if (istFeld) return '';

  if (p.options.length > 1) {
    var offen = p.options.filter(function (o) { return o.unlocked; });
    var spaeter = p.options.length - offen.length;
    if (offen.length === 0) return 'ab Stufe ' + p.options[0].minPlayerLevel;
    return offen.map(function (o) { return nameOf(o.id); }).join(' oder ')
      + (spaeter > 0 ? ' · +' + spaeter + ' später' : '');
  }
  if (p.tap === 'start') {
    var n = p.next;
    if (!n) return 'antippen zum Starten';
    if (n.inputs.length === 0) return 'antippen · ' + ausbeuteText(n.recipe);
    return costText(n.inputs) + ' → ' + ausbeuteText(n.recipe);
  }
  return 'nichts zu tun';
}

function renderPlots(v) {
  if (ziehen && ziehen.aktiv) return;
  if (typeof seeAktiv !== 'undefined' && seeAktiv) { renderSeeWelt(v); return; }
  $('hof').classList.toggle('kein-raster', !hatRaster());
  $('hof').classList.remove('see-zone');

  var scene = $('scene');
  var wunsch = 'boden' + (bauModus ? '-bau' : '');
  if (scene.dataset.stand !== wunsch) {
    scene.innerHTML = artScene();
    scene.dataset.stand = wunsch;
  }

  var box = $('plots');
  box.textContent = '';

  var sichtbar = v.plots.filter(function (p) { return !hatRaster() || p.gx >= 0; });
  var reihenfolge = sichtbar.slice().sort(function (a, b) {
    return plotKasten(a.index, a).tiefe - plotKasten(b.index, b).tiefe;
  });

  reihenfolge.forEach(function (p) {
    var ort = plotKasten(p.index, p);
    // Objekte mit Koerper ragen ueber ihren Standplatz hinaus: Der Kasten
    // waechst nach oben, gemalt wird in einer viewBox mit genau diesem
    // Seitenverhaeltnis. Alles andere bleibt vorerst flach.
    var koerper = koerperFuer(p.id, p.size.w, p.size.h);
    ort.top -= koerper.hoch * zellH();
    ort.height += koerper.hoch * zellH();
    var tile = document.createElement('button');
    var baumReif = p.baum && p.baum.stufe === 'reif';
    var baumWelk = p.baum && p.baum.stufe === 'verwelkt';
    tile.className = 'plot' + (p.done || baumReif || baumWelk ? ' ripe' : '') +
      (p.idle ? ' locked' : '') + (p.blocked === 'level' ? ' gated' : '');
    tile.disabled = (p.stall || p.capacity > 1 || p.baum)
      ? false
      : (p.tap === 'none' && !p.busy ? p.blocked !== 'inputs' : false);
    tile.style.left = ort.left + '%';
    tile.style.top = ort.top + '%';
    tile.style.width = ort.width + '%';
    tile.style.height = ort.height + '%';
    // Ein festes, noch nicht gebautes Bauwerk (die Mine) steht mitten im
    // Sperrland. Es liegt bewusst ÜBER der Sperrkachel, damit man es als Ziel
    // sieht und antippen kann — sonst verschwindet es unter „Neues Land".
    var wahrzeichen = p.level <= 0 && rules.plots[p.index] && rules.plots[p.index].fixed;
    tile.classList.toggle('wahrzeichen', !!wahrzeichen);
    tile.style.zIndex = wahrzeichen ? '58' : String(1 + Math.round(ort.tiefe * 2));
    tile.dataset.platz = String(p.index);
    tile.setAttribute('aria-label', plotName(p.index) + ' — ' + plotStatus(p));

    var art = document.createElement('div');
    art.innerHTML =
      '<svg class="art" viewBox="0 0 100 ' + koerper.vh +
      '" preserveAspectRatio="none" aria-hidden="true">' +
      artRaumFor(p, koerper) + '</svg>';
    tile.appendChild(art.firstChild);

    // Zustand zeigt die Welt selbst — wie in Hay Day: keine Schrift auf den
    // Kacheln, sondern eine Bildblase mit dem fertigen Produkt (bzw. Axt beim
    // welken Baum). Die Blase ist in Zellen bemessen und zoomt mit.
    if (p.done || baumReif || baumWelk) {
      var bild = baumWelk ? null : blasenBild(p);
      var badge = blase(baumWelk ? 'saw' : bild ? rules.items[bild.item].id : null, '!');
      badge.style.width = blasenBreite(p.size.w);
      tile.appendChild(badge);
    }

    var baumWaechst = p.baum && (p.baum.stufe === 'setzling' || p.baum.stufe === 'wachsen');
    if (p.busy || baumWaechst) {
      var bar = document.createElement('div');
      bar.className = 'bar';
      var fill = document.createElement('i');
      fill.style.width = Math.round(p.progress * 100) + '%';
      bar.appendChild(fill);
      tile.appendChild(bar);
    }

    // Name und Zustand nur für Vorleser und Tests — sichtbar ist davon nichts
    // (siehe .plot .meta im Stylesheet), die Welt bleibt schriftfrei.
    var meta = document.createElement('div');
    meta.className = 'meta';
    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = plotName(p.index);
    var status = document.createElement('div');
    status.className = 'status';
    status.textContent = plotStatus(p);
    meta.appendChild(name); meta.appendChild(status);
    tile.appendChild(meta);

    tile.addEventListener('click', function () {
      if (Date.now() - klickSchlucken < 400) return;
      tapPlot(p.index);
    });
    tile.addEventListener('pointerdown', function (e) { ziehStart(e, p.index, tile); });
    box.appendChild(tile);

    // Der Ausbau (früher schwebende „+ Kosten"-Blase) sitzt jetzt im Tipp-Menü.
  });

  if (hatRaster()) weltFormat();
  if (hatRaster() && !kamera.gesetzt && $('hof').getBoundingClientRect().width > 0) kameraStart();
}

var tileFuerKamera = false;

function renderTruck(v) {
  var knopf = $('wagen');
  var t = v.truck;
  if (!t.enabled) { knopf.hidden = true; return; }

  knopf.hidden = false;
  knopf.className = 'moebel wagen' + (t.here ? '' : ' unterwegs');
  setzeMoebel('wagen');
  knopf.innerHTML = moebelSvg('wagen', { unterwegs: !t.here });
  knopf.setAttribute('aria-label', t.here ? 'Lieferwagen wartet' : 'Lieferwagen unterwegs');
}

// Hof-Moebel bekommen wie Plaetze einen Kasten, der nach oben waechst.
// Unbekannte Knoepfe (etwa der Stand beim Nachbarn) zaehlen als 3 x 2 Zellen.
function moebelKoerper(id, artId) {
  var o = MOEBEL_ORTE[id] || [0, 0, 3, 2];
  if (!hatRaster()) return null;
  return koerperMoebel(artId || id, o[2], o[3]);
}

function moebelSvg(id, zustand, artId) {
  var m = moebelKoerper(id, artId) || koerperMoebel(artId || id, 3, 2);
  return '<svg class="art" viewBox="0 0 100 ' + m.vh +
    '" preserveAspectRatio="none" aria-hidden="true">' + artMoebelRaum(artId || id, m, zustand) + '</svg>';
}

// Die Moebelreihe am oberen Rand, [gx, gy, Breite, Hoehe] in Zellen. Die
// Spalten duerfen sich NICHT ueberlappen — Wagen und Kiste sind meistens
// versteckt, ein Zusammenstoss faellt deshalb erst auf, wenn sie auftauchen.
// Belegt: 0-2 Nachbarn, 4-6 Brett, 8-10 Lager, 12-14 Stand, 16-19 Wagen,
// 21-22 Kiste, 24-26 Abenteuerbrett.
var MOEBEL_ORTE = {
  nachbarn: [0, -2.5, 3, 2],
  brett: [4, -2.5, 3, 2],
  lagerhaus: [8, -2.5, 3, 2],
  stand: [12, -2.5, 3, 2],
  wagen: [16, -2.5, 4, 2],
  kiste: [21, -2.5, 2, 2],
  abenteuer: [24, -2.5, 3, 3],
  boot: [0, 10, 6, 3],
};

function setzeMoebel(id) {
  var el = $(id);
  var o = MOEBEL_ORTE[id];
  if (!hatRaster() || !o) {
    el.style.left = el.style.top = el.style.width = el.style.height = '';
    el.style.zIndex = '';
    return;
  }
  var k = moebelKasten(o[0], o[1], o[2], o[3]);
  var kp = moebelKoerper(id);
  if (kp) {
    k.top -= kp.hoch * zellH();
    k.height += kp.hoch * zellH();
  }
  el.style.left = k.left + '%';
  el.style.top = k.top + '%';
  el.style.width = k.width + '%';
  el.style.height = k.height + '%';
  el.style.zIndex = String(50 + Math.round(k.tiefe * 2));
}

function renderMoebel(v) {
  // Aus dem See zurück: Hof-Möbel wieder zeigen.
  ['brett', 'lagerhaus', 'stand', 'nachbarn', 'abenteuer'].forEach(function (id) { $(id).hidden = false; });

  // Boot zum Angelsee — steht IMMER am Hof (auch kaputt). Repariert man es,
  // fährt es wieder und öffnet den See.
  var boot = $('boot');
  if (boot) {
    var zeigBoot = v.angeln && hatRaster();
    boot.hidden = !zeigBoot;
    if (zeigBoot) {
      var heil = !!(v.angeln.boot && v.angeln.boot.repariert);
      boot.classList.toggle('kaputt', !heil);
      boot.innerHTML = moebelSvg('boot', { heil: heil }) +
        (heil ? '' : blase('mallet').outerHTML);
      var bootBlase = boot.querySelector('.badge');
      if (bootBlase) bootBlase.style.width = blasenBreite(MOEBEL_ORTE.boot[2]);
      boot.setAttribute('aria-label', heil ? 'Zum Angelsee' : 'Kaputtes Boot — reparieren');
      setzeMoebel('boot');
    }
  }

  var bereit = v.truck.board.filter(function (z) { return z.deliverable; }).length;
  moebel($('brett'), {}, 'Brett', bereit);
  moebel($('lagerhaus'), { voll: v.silo.full }, 'Lager',
    v.mail.entries.length + (v.silo.upgrade && v.silo.upgrade.affordable ? 1 : 0));
  moebel($('stand'), {}, 'Stand', v.orders.filter(function (o) { return o.sold > 0; }).length);
  moebel($('nachbarn'), {}, 'Nachbarn', 0);

  // Abenteuerbrett: Die Leiste leuchtet, sobald etwas abzuholen ist.
  var tages = (v.aufgaben && v.aufgaben.liste) || [];
  var tagesOffen = tages.filter(function (e) { return e.erfuellt && !e.eingeloest; }).length;
  var abBrett = $('abenteuer');
  abBrett.hidden = tages.length === 0;
  if (!abBrett.hidden) {
    abBrett.innerHTML = moebelSvg('abenteuer', { wartet: tagesOffen > 0 }) +
      (tagesOffen > 0 ? blase(null, String(tagesOffen)).outerHTML : '');
    var abBlase = abBrett.querySelector('.badge');
    if (abBlase) abBlase.style.width = blasenBreite(MOEBEL_ORTE.abenteuer[2]);
    var abZahl = $('abenteuer-zahl');
    if (abZahl) abZahl.textContent = tagesOffen > 0 ? tagesOffen + ' 🎁' : '📋';
    abBrett.setAttribute('aria-label',
      'Abenteuerbrett — ' + tages.length + ' Aufgaben heute' +
      (tagesOffen > 0 ? ', ' + tagesOffen + ' abzuholen' : ''));
  }

  ['brett', 'lagerhaus', 'stand', 'nachbarn', 'abenteuer'].forEach(setzeMoebel);

  var offen = v.chests.filter(function (k) { return k.ready; });
  var kiste = $('kiste');
  var ohneOrt = offen.filter(function (k) { return k.gx < 0 || !hatRaster(); });
  kiste.hidden = ohneOrt.length === 0;
  if (ohneOrt.length > 0) { moebel(kiste, {}, 'Kiste', ohneOrt.length); setzeMoebel('kiste'); }
}

// Hindernisse und Sperrflaechen sind fast immer unveraendert — es waere
// Verschwendung, sie jede Sekunde neu zu bauen. Bei einem grossen Hof sind das
// ueber 500 Knoepfe mit eigenem SVG; genau daran hat die Oberflaeche geruckelt.
// Darum: nur neu zeichnen, wenn sich der Inhalt tatsaechlich unterscheidet.
var hindernisStand = null;
var sperrStand = null;

function renderHindernisse(v) {
  var box = $('hindernisse');
  if (!hatRaster()) { box.textContent = ''; hindernisStand = null; return; }

  var stand = raster().w + 'x' + raster().h + '|' + v.obstacles.map(function (h) {
    return h.index + (h.removable ? 'r' : '') + (h.locked ? 'l' : '');
  }).join(',');
  if (stand === hindernisStand) return;
  hindernisStand = stand;
  box.textContent = '';

  v.obstacles.forEach(function (h) {
    var kasten = hindernisKasten(h);
    var koerper = koerperHindernis(h.kind, h.w, h.h);
    kasten.top -= koerper.hoch * zellH();
    kasten.height += koerper.hoch * zellH();
    var knopf = document.createElement('button');
    knopf.className = 'moebel hindernis' +
      (h.removable ? ' raeumbar' : '') + (h.locked ? ' verborgen' : '');
    knopf.style.left = kasten.left + '%';
    knopf.style.top = kasten.top + '%';
    knopf.style.width = kasten.width + '%';
    knopf.style.height = kasten.height + '%';
    knopf.style.zIndex = String(1 + Math.round(kasten.tiefe * 2));
    knopf.innerHTML =
      '<svg class="art" viewBox="0 0 100 ' + koerper.vh +
      '" preserveAspectRatio="none" aria-hidden="true">' +
      artHindernisRaum(h.kind, koerper, h.index) + '</svg>';
    knopf.setAttribute('aria-label', hindernisName(h.kind) + (h.locked ? ' (gesperrtes Land)' : ''));
    // Im gesperrten Land nur Vorschau: nicht anklickbar (Klick geht an die
    // Land-Sperre darüber), grau über CSS.
    if (h.locked) {
      knopf.disabled = true;
      knopf.style.pointerEvents = 'none';
    } else {
      knopf.addEventListener('click', function () { tippeHindernis(h); });
    }
    box.appendChild(knopf);
  });
}


// Gesperrtes Land ist Wildnis: dieselbe Landschaft — Boden, Baeume, Steine,
// Teiche — nur abgedunkelt. Kein Kasten, kein Banner. Ein Schild tragen nur die
// Felder, die ans FREIE Land grenzen; alles dahinter bleibt stumm, bis man
// naeher kommt. Sonst schreit jedes der 32 Felder „ab Stufe" und der eigene Hof
// geht darin unter.
function freieZelle(gx, gy, gesperrt) {
  var g = raster();
  if (gx < 0 || gy < 0 || gx >= g.w || gy >= g.h) return false;
  for (var i = 0; i < gesperrt.length; i++) {
    var e = gesperrt[i];
    if (gx >= e.gx && gx < e.gx + e.w && gy >= e.gy && gy < e.gy + e.h) return false;
  }
  return true;
}

function grenztAnFrei(e, gesperrt) {
  for (var x = e.gx; x < e.gx + e.w; x++) {
    if (freieZelle(x, e.gy - 1, gesperrt) || freieZelle(x, e.gy + e.h, gesperrt)) return true;
  }
  for (var y = e.gy; y < e.gy + e.h; y++) {
    if (freieZelle(e.gx - 1, y, gesperrt) || freieZelle(e.gx + e.w, y, gesperrt)) return true;
  }
  return false;
}

function renderErweiterungen(v) {
  var box = $('erweiterungen');
  if (!box) return;
  if (!hatRaster()) { box.textContent = ''; sperrStand = null; return; }

  var stand = raster().w + 'x' + raster().h + '|' + (v.expansions || []).map(function (e) {
    return e.id + (e.unlocked ? 'u' : '') + (e.reachedLevel ? 'r' : '') + (e.affordable ? 'a' : '');
  }).join(',');
  if (stand === sperrStand) return;
  sperrStand = stand;
  box.textContent = '';

  var gesperrt = (v.expansions || []).filter(function (e) { return !e.unlocked; });

  gesperrt.forEach(function (e) {
    var grenze = grenztAnFrei(e, gesperrt);
    var kasten = moebelKasten(e.gx, e.gy, e.w, e.h);
    var knopf = document.createElement('button');
    knopf.className = 'feld-sperre' +
      (grenze ? ' grenze' : ' wildnis') +
      (e.reachedLevel ? ' bereit' : ' fern');
    knopf.style.left = kasten.left + '%';
    knopf.style.top = kasten.top + '%';
    // Nachbarn ueberlappen sich um einen Bruchteil einer Zelle. Ohne das
    // scheint an jeder Kante ein Streifen ungefilterte Wiese durch — ein
    // Artefakt von backdrop-filter, das kein Saum am Rand schliesst. Liegt die
    // Kante INNERHALB des gefilterten Nachbarn, gibt es nichts, was durchblendet.
    knopf.style.width = (kasten.width + zellB() * 0.12) + '%';
    knopf.style.height = (kasten.height + zellH() * 0.12) + '%';
    knopf.style.zIndex = String(2 + Math.round(kasten.tiefe * 2));
    knopf.dataset.feld = e.id;
    if (grenze) {
      knopf.innerHTML = '<span class="plakette">' + (e.reachedLevel
        ? '<b>Neues Land</b>' + (e.affordable ? '<em>frei machen</em>' : '<em>Werkzeug fehlt</em>')
        : '<b>ab Stufe ' + e.minLevel + '</b>') + '</span>';
    }
    knopf.setAttribute('aria-label', 'Neues Land, ab Stufe ' + e.minLevel);
    knopf.addEventListener('click', function () { oeffneErweiterung(e.id); });
    box.appendChild(knopf);
  });
}

var offenesFeld = null;

function oeffneErweiterung(id) {
  offenesFeld = id;
  show('erweiterung');
}

function renderErweiterungSheet(v) {
  var box = $('erweiterung-inhalt');
  if (!box) return;
  var e = null;
  (v.expansions || []).forEach(function (x) { if (x.id === offenesFeld) e = x; });
  if (!e || e.unlocked) { show('farm'); return; }

  var kostenHtml = e.cost.map(function (c) {
    var hat = v.stock[c.item] ? v.stock[c.item].amount : 0;
    var ok = hat >= c.amount;
    return '<div class="zeile' + (ok ? ' ok' : ' fehlt') + '">' +
      itemIcon(c.item, 'gross') +
      '<span class="n">' + itemName(c.item) + '</span>' +
      '<span class="m">' + hat + ' / ' + c.amount + '</span></div>';
  }).join('');

  box.innerHTML =
    '<p class="lead">Dieses Stück Land ist überwuchert. Vermiss es mit Landkarte, ' +
    'Bauhammer und Steckpfahl, dann gehört es zu deinem Hof.</p>' +
    (e.reachedLevel ? '' : '<p class="warn">Erst ab Stufe ' + e.minLevel + '.</p>') +
    '<div class="kosten">' + kostenHtml + '</div>';

  var knopf = document.createElement('button');
  knopf.className = 'primär';
  knopf.disabled = !e.affordable;
  knopf.textContent = e.affordable ? 'Land freischalten'
    : !e.reachedLevel ? 'ab Stufe ' + e.minLevel
    : 'Werkzeug fehlt';
  knopf.addEventListener('click', function () {
    var res = client.expand(e.id);
    act('Neues Land freigeschaltet', res, 'stufe');
    if (res.ok) { offenesFeld = null; show('farm'); attempt(true); }
  });
  box.appendChild(knopf);
}

function renderKisten(v) {
  var box = $('kisten');
  box.textContent = '';
  if (!hatRaster()) return;

  v.chests.forEach(function (k) {
    if (!k.ready || k.gx < 0) return;
    var kasten = plotKasten(-1, { gx: k.gx, gy: k.gy });
    var m = koerperMoebel('schatz', 1, 1);
    var knopf = document.createElement('button');
    knopf.className = 'moebel schatz';
    knopf.style.left = kasten.left + '%';
    knopf.style.top = (kasten.top - m.hoch * zellH()) + '%';
    knopf.style.width = kasten.width + '%';
    knopf.style.height = (kasten.height + m.hoch * zellH()) + '%';
    knopf.style.zIndex = String(40 + Math.round(kasten.tiefe * 2));
    knopf.innerHTML =
      '<svg class="art" viewBox="0 0 100 ' + m.vh + '" preserveAspectRatio="none" aria-hidden="true">' +
      artMoebelRaum('schatz', m) + '</svg>';
    knopf.setAttribute('aria-label', k.kind + ' öffnen');
    knopf.addEventListener('click', function () { oeffneKiste(k.id); });
    box.appendChild(knopf);
  });
}

function renderAusbau(v) {
  var box = $('ausbau');
  box.textContent = '';

  var stand = document.createElement('div');
  stand.className = 'note';
  stand.textContent = 'Platz ' + v.silo.used + ' von ' + v.silo.capacity +
    (v.silo.level > 0 ? ' · Stufe ' + (v.silo.level + 1) : '');
  box.appendChild(stand);

  if (!v.silo.upgrade) {
    var fertig = document.createElement('p');
    fertig.className = 'empty';
    fertig.textContent = 'Voll ausgebaut.';
    box.appendChild(fertig);
    return;
  }

  var karte = document.createElement('button');
  karte.className = 'card';
  karte.disabled = !v.silo.upgrade.affordable;
  karte.innerHTML =
    '<div class="body"><div class="top">' + v.silo.upgrade.label + ' · auf ' +
    v.silo.upgrade.capacity + ' Platz</div>' +
    '<div class="sub">' + (v.silo.upgrade.affordable ? 'alles da' : 'es fehlt noch etwas') +
    '</div>' + zutatenHtml(v.silo.upgrade.cost, lagerAusSicht(v), { titel: 'kostet' }) + '</div>' +
    '<span class="go">Bauen</span>';
  karte.addEventListener('click', function () {
    act('Lager ausgebaut · ' + v.silo.upgrade.capacity + ' Platz', client.upgradeSilo(), 'stufe');
  });
  box.appendChild(karte);
}

function moebel(knopf, zustand, name, zahl, artId) {
  knopf.innerHTML = moebelSvg(knopf.id, zustand, artId) +
    '<span class="meta">' + name + '</span>' +
    (zahl > 0 ? blase(null, String(zahl)).outerHTML : '');
  var b = knopf.querySelector('.badge');
  if (b) b.style.width = blasenBreite(MOEBEL_ORTE[knopf.id] ? MOEBEL_ORTE[knopf.id][2] : 3);
  knopf.setAttribute('aria-label', name + (zahl > 0 ? ' — ' + zahl + ' offen' : ''));
}

// Blasen sind rund 0,9 Zellen breit — gleich groß über Feld, Stall und Boot,
// egal wie viele Zellen das Objekt selbst einnimmt.
function blasenBreite(zellen) {
  return (90 / Math.max(1, zellen)) + '%';
}

// Welches Bild gehört in die „fertig"-Blase eines Platzes? Beim Baum die
// Ernte, sonst das Produkt des ersten fertigen Slots (Feld, Stall, Werkstatt).
function blasenBild(p) {
  if (p.baum && p.baum.ertrag) return p.baum.ertrag;
  for (var i = 0; i < p.slots.length; i++) {
    if (p.slots[i].done && p.slots[i].output) return p.slots[i].output;
  }
  return p.output;
}

// Eine runde Blase über einem Weltobjekt: ein einziges SVG mit Ring und
// Inhalt (Bild-Icon per Kennung oder kurzer Text). Alles in viewBox-Einheiten,
// damit Ring, Bild und Schrift beim Zoomen exakt mitwachsen — rem/px würden
// je nach Zoom mal winzig, mal riesig wirken.
function blase(bildId, text) {
  var el = document.createElement('span');
  el.className = 'badge';
  var quelle = bildId ? iconFor(bildId) : null;
  var inhalt = quelle
    ? '<image href="' + quelle + '" x="4.2" y="4.2" width="11.6" height="11.6"/>'
    : '<text x="10" y="14.6" text-anchor="middle" font-size="' + ((text || '').length > 1 ? 10 : 13) +
      '" font-weight="800" font-family="system-ui, sans-serif" fill="var(--ink)">' + (text || '!') + '</text>';
  el.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true">' +
    '<circle cx="10" cy="10" r="9.2" fill="var(--surface)" stroke="var(--ripe)" stroke-width="1.3"/>' +
    inhalt + '</svg>';
  return el;
}

function renderRequests(v) {
  var box = $('requests');
  box.textContent = '';
  var t = v.truck;

  if (!t.enabled || t.board.length === 0) {
    box.innerHTML = '<p class="empty">Am Brett hängt gerade nichts.</p>';
    return;
  }

  t.board.forEach(function (z) {
    var karte = document.createElement('div');
    karte.className = 'zettel' + (z.deliverable ? ' bereit' : '');
    karte.dataset.zettel = String(z.id);

    var kopf = document.createElement('div');
    kopf.className = 'kopf';
    kopf.innerHTML = '<span class="ziel">nach ' + z.dest + '</span>' +
      '<span class="lohn">' + stacksMitBild(z.reward) + ' · ' + z.xp + ' XP</span>';
    karte.appendChild(kopf);

    var ware = document.createElement('div');
    ware.className = 'ware';
    z.wants.forEach(function (w) {
      var fehlt = 0;
      z.missing.forEach(function (m) { if (m.item === w.item) fehlt = m.amount; });
      var posten = document.createElement('span');
      posten.className = 'posten' + (fehlt > 0 ? ' fehlt' : '');
      posten.innerHTML = itemIcon(w.item) + w.amount + ' ' + itemName(w.item) +
        (fehlt > 0 ? ' (' + fehlt + ' fehlt)' : '');
      ware.appendChild(posten);
    });
    karte.appendChild(ware);

    var reihe = document.createElement('div');
    reihe.className = 'reihe';

    var los = document.createElement('button');
    los.className = 'abfahrt';
    los.disabled = !z.deliverable;
    los.textContent = !t.here
      ? 'Wagen unterwegs'
      : z.deliverable ? 'Abschicken' : 'Ware fehlt';
    los.addEventListener('click', function () {
      // Der Lohn kommt sofort — also soll man ihn auch ankommen sehen: Muenzen
      // steigen vom Zettel auf, der Geldbeutel oben huepft, kurz nach dem
      // Motor klingelt die Kasse.
      var wo = los.getBoundingClientRect();
      var lohnGold = 0;
      z.reward.forEach(function (r) { if (r.item === rules.currency) lohnGold += r.amount; });
      var res = client.sendSlip(z.slot);
      act('Abgeschickt nach ' + z.dest + ' · ' + stacks(z.reward), res, 'wagen');
      if (!res.ok) return;
      if (lohnGold > 0) zahlAuf(wo, '+' + lohnGold, 'muenzen');
      if (z.xp > 0) zahlAuf(hoch(wo), '+' + z.xp + ' XP', 'xp');
      setTimeout(function () { klang('muenzen'); geldbeutelHuepft(); }, 320);
    });
    reihe.appendChild(los);

    if (v.skip.enabled) {
      var tausch = document.createElement('button');
      tausch.className = 'abfahrt skip';
      tausch.disabled = !v.skip.ready;
      tausch.textContent = v.skip.ready ? 'Tauschen' : 'in ' + timeText(v.skip.readyIn);
      tausch.addEventListener('click', function () {
        act('Zettel getauscht', client.skipRequest(z.id));
      });
      reihe.appendChild(tausch);
    }

    karte.appendChild(reihe);
    box.appendChild(karte);
  });
}

function renderMail(v) {
  var box = $('mail');
  box.textContent = '';
  if (v.mail.entries.length === 0) {
    box.innerHTML = '<p class="empty">Postfach leer.</p>';
    return;
  }
  var card = document.createElement('button');
  card.className = 'card';
  var body = document.createElement('div');
  body.className = 'body';
  var top = document.createElement('div');
  top.className = 'top';
  top.textContent = stacks(v.mail.entries);
  var sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = v.mail.entries.length + ' von ' + v.mail.capacity + ' Fächern belegt';
  body.appendChild(top); body.appendChild(sub);
  var go = document.createElement('span');
  go.className = 'go';
  go.textContent = 'Abholen';
  card.appendChild(body); card.appendChild(go);
  card.addEventListener('click', function () {
    act('Postfach geleert', client.collectMail(), 'muenzen');
  });
  box.appendChild(card);
}

function marktLive() {
  return netzOk();
}

function renderMarket(v) {
  var online = marktLive();
  var blatt = $('zeitung');
  $('market-note').hidden = online;
  if (!online) {
    $('market-note').textContent = navigator.onLine
      ? 'Der Server antwortet gerade nicht. Besuchen und kaufen geht erst wieder, '
        + 'wenn die Verbindung steht.'
      : 'Nachbarn brauchen Verbindung — wer ein Angebot bekommt, entscheidet sich '
        + 'nicht auf diesem Gerät. Anschauen geht trotzdem.';
  }
  zeichneZeitung(v, blatt, online);
}

function zeichneZeitung(v, box, online) {
  box.textContent = '';
  box.className = online ? '' : 'no-net';

  if (v.zeitung.length === 0) {
    box.innerHTML = '<p class="empty">' + (online
      ? 'Diese Woche inseriert kein Hof. Stell selbst etwas in deinen Stand.'
      : 'Die Zeitung liegt nicht auf dem Gerät. Sie kommt mit dem nächsten Sync.') + '</p>';
    return;
  }

  v.zeitung.forEach(function (hof) {
    var a = hof.aushang;
    var karte = document.createElement('button');
    karte.className = 'card anzeige';
    karte.dataset.hof = hof.seller;
    karte.disabled = !online;
    karte.innerHTML =
      itemIcon(a.item, 'gross') +
      '<div class="body"><div class="top">' + hof.hof + '</div>' +
      '<div class="sub">' + a.amount + ' ' + itemName(a.item) + ' · ' +
      a.price + ' je Stück · ' + hof.offers.length +
      (hof.offers.length === 1 ? ' Kästchen' : ' Kästchen') + '</div></div>' +
      '<span class="go">Besuchen</span>';
    karte.addEventListener('click', function () {
      if (!marktLive()) return;
      besuche(hof.seller);
    });
    box.appendChild(karte);
  });
}

function clamp(n, lo, hi) {
  if (!isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function numberPick(label, get, lo, hi, set, maxLabel) {
  var row = document.createElement('div');
  row.className = 'pick';
  var value = clamp(get(), lo, hi);

  var lbl = document.createElement('span');
  lbl.className = 'lbl';
  lbl.textContent = label;
  row.appendChild(lbl);

  var step = function (delta) {
    return function () { set(clamp(get() + delta, lo, hi)); };
  };

  var minus = document.createElement('button');
  minus.type = 'button';
  minus.textContent = '−';
  minus.disabled = value <= lo;
  minus.addEventListener('click', step(-1));
  row.appendChild(minus);

  var input = document.createElement('input');
  input.type = 'number';
  input.inputMode = 'numeric';
  input.value = String(value);
  input.min = String(lo);
  input.max = String(hi);

  input.addEventListener('input', function () { set(clamp(Number(input.value), lo, hi), true); });
  input.addEventListener('blur', function () { render(); });
  row.appendChild(input);

  var plus = document.createElement('button');
  plus.type = 'button';
  plus.textContent = '+';
  plus.disabled = value >= hi;
  plus.addEventListener('click', step(1));
  row.appendChild(plus);

  if (maxLabel) {
    var max = document.createElement('button');
    max.type = 'button';
    max.className = 'max';
    max.textContent = maxLabel;
    max.disabled = value >= hi;
    max.addEventListener('click', function () { set(hi); });
    row.appendChild(max);
  }

  return row;
}

// Ziele & Erfolge. Ob ein Erfolg erfüllt ist und wie weit er ist, rechnet
// allein das Regelwerk (siehe view.ts) — hier wird nur sortiert und gemalt.
var ZIEL_GRUPPEN = [
  { id: 'hof', label: 'Hof', bild: 'wheat' },
  { id: 'wohlstand', label: 'Wohlstand', bild: 'gold' },
  { id: 'land', label: 'Land', bild: 'map' },
  { id: 'see', label: 'Angelsee', bild: 'fish-perch' },
  { id: 'vorrat', label: 'Vorrat', bild: 'plank' },
];

// Reihenfolge in einer Gruppe: zuerst was man abholen kann, dann die
// angefangenen (die dichtesten zuerst), zuletzt das Erledigte.
function zielRang(e) {
  if (e.erfuellt && !e.eingeloest) return 0;
  if (e.eingeloest) return 2;
  return 1;
}

function renderZiele(v) {
  var liste = v.erfolge || [];
  var tages = (v.aufgaben && v.aufgaben.liste) || [];
  if (liste.length === 0 && tages.length === 0) return;

  var offen = liste.filter(function (e) { return e.erfuellt && !e.eingeloest; }).length;
  var tagesOffen = tages.filter(function (e) { return e.erfuellt && !e.eingeloest; }).length;
  var fertig = liste.filter(function (e) { return e.eingeloest; }).length;
  var marke = $('ziele-zahl');
  // Tagesaufgaben zählen in dieselbe Marke — sonst übersieht man sie, weil man
  // den Bildschirm sonst nur wegen der Erfolge öffnet.
  if (marke) {
    marke.textContent = offen + tagesOffen > 0
      ? (offen + tagesOffen) + ' 🎁'
      : fertig + '/' + liste.length;
  }

  // Die Liste nur zeichnen, wenn der Ziele-Screen offen ist.
  if ($('ziele-bg').hidden) return;
  var box = $('ziele-liste');
  box.textContent = '';

  // Kopf: wie weit ist der ganze Hof?
  var kopf = document.createElement('div');
  kopf.className = 'ziel-kopf';
  kopf.innerHTML =
    '<div class="ziel-kopf-zahl"><b>' + fertig + '</b> von ' + liste.length + ' eingelöst</div>' +
    '<span class="balken"><i style="width:' +
      Math.floor((fertig * 100) / liste.length) + '%"></i></span>' +
    (offen > 0 ? '<div class="ziel-kopf-hinweis">' + offen + ' warten auf dich</div>' : '');
  box.appendChild(kopf);

  // Die Aufgaben des Tages haben ein eigenes Zuhause am Abenteuerbrett. Hier
  // steht nur der Hinweis, damit man sie vom Ziele-Bildschirm aus findet.
  if (tages.length > 0) {
    var hinweis = document.createElement('button');
    hinweis.type = 'button';
    hinweis.className = 'ziel-brettlink';
    hinweis.innerHTML = '<span class="ic">📋</span><span>Abenteuerbrett · ' +
      tages.length + ' Aufgaben heute' +
      (tagesOffen > 0 ? ' · <b>' + tagesOffen + " abzuholen</b>" : '') + '</span>';
    hinweis.addEventListener('click', function () { show('abenteuer'); });
    box.appendChild(hinweis);
  }

  ZIEL_GRUPPEN.forEach(function (gruppe) {
    var teil = liste.filter(function (e) { return e.gruppe === gruppe.id; });
    if (teil.length === 0) return;
    teil.sort(function (a, b) {
      var d = zielRang(a) - zielRang(b);
      if (d !== 0) return d;
      return b.prozent - a.prozent;
    });

    var titel = document.createElement('div');
    titel.className = 'ziel-gruppe';
    titel.innerHTML = iconTag(gruppe.bild) + '<span>' + gruppe.label + '</span>' +
      '<span class="ziel-gruppe-zahl">' +
      teil.filter(function (e) { return e.eingeloest; }).length + '/' + teil.length + '</span>';
    box.appendChild(titel);

    teil.forEach(function (e) { box.appendChild(zielZeile(e)); });
  });

  box.querySelectorAll('.ziel-los').forEach(function (btn) {
    btn.addEventListener('click', function () {
      act('Erfolg eingelöst', client.claimAchievement(btn.getAttribute('data-id')), 'stufe');
    });
  });
}

// Das Abenteuerbrett: die Aufgaben des Tages als angepinnte Zettel. Bewusst
// eine eigene Optik statt der Ziele-Liste — es soll sich wie ein Ort auf dem
// Hof anfuehlen und nicht wie ein Menuepunkt.
function renderAbenteuer(v) {
  if ($('abenteuer-bg').hidden) return;
  var tages = (v.aufgaben && v.aufgaben.liste) || [];
  var offen = tages.filter(function (e) { return e.erfuellt && !e.eingeloest; }).length;
  var fertig = tages.filter(function (e) { return e.eingeloest; }).length;

  $('abenteuer-unter').textContent = tages.length === 0
    ? 'Sobald dein Hof das erste Mal Verbindung hatte, hängen hier Aufgaben.'
    : offen > 0
      ? 'Nimm ab, was fertig ist — morgen hängen neue Zettel.'
      : fertig >= tages.length
        ? (v.aufgaben.abschluss && !v.aufgaben.abschluss.eingeloest
            ? 'Alle Zettel ab — jetzt den Tag abschließen.'
            : 'Alles abgeholt. Morgen hängen neue Zettel.')
        : 'Heute ' + fertig + ' von ' + tages.length + ' geschafft.';

  var box = $('abenteuer-liste');
  box.textContent = '';

  tages.forEach(function (e, i) {
    var zettel = document.createElement('div');
    zettel.className = 'zettel-brett' +
      (e.eingeloest ? ' abgeholt' : e.erfuellt ? ' reif' : '');
    // Leicht wechselnde Neigung, damit es nach angepinntem Papier aussieht.
    zettel.style.setProperty('--dreh', (i % 2 === 0 ? -1 : 1) * (0.4 + (i % 3) * 0.3) + 'deg');

    var lohn = (e.gold > 0 ? e.gold + ' Gold' : '') +
      (e.gold > 0 && e.xp > 0 ? ' · ' : '') + (e.xp > 0 ? e.xp + ' XP' : '');

    var unten = e.eingeloest
      ? '<span class="zettel-fertig">abgeholt ✓</span>'
      : e.erfuellt
        ? '<button type="button" class="zettel-los" data-id="' + e.id + '">Abholen · ' + lohn + '</button>'
        : '<span class="zettel-balken"><i style="width:' + e.prozent + '%"></i></span>' +
          '<span class="zettel-stand">' + e.ist + ' / ' + e.ziel + '</span>';

    zettel.innerHTML =
      '<span class="zettel-nadel"></span>' +
      '<div class="zettel-kopf">' + e.label + '</div>' +
      '<div class="zettel-lohn">' + lohn + '</div>' +
      '<div class="zettel-unten">' + unten + '</div>';
    box.appendChild(zettel);
  });

  // Der Schlussstrich unter den Tag. Er haengt unter den Zetteln wie eine
  // Urkunde am Brett: gesperrt, solange noch einer offen ist, und danach das
  // Groesste, was der Tag hergibt.
  var ab = v.aufgaben && v.aufgaben.abschluss;
  if (ab && tages.length > 0) {
    var urkunde = document.createElement('div');
    urkunde.className = 'tagesabschluss' +
      (ab.eingeloest ? ' abgeholt' : ab.erfuellt ? ' reif' : '');
    var abLohn = (ab.gold > 0 ? ab.gold + ' Gold' : '') +
      (ab.gold > 0 && ab.xp > 0 ? ' · ' : '') + (ab.xp > 0 ? ab.xp + ' XP' : '');
    urkunde.innerHTML =
      '<div class="ta-kopf">Tagesabschluss</div>' +
      '<div class="ta-lohn">' + abLohn + '</div>' +
      '<div class="ta-unten">' + (
        ab.eingeloest
          ? '<span class="ta-fertig">Heute geschafft ✓</span>'
          : ab.erfuellt
            ? '<button type="button" class="ta-los">Abholen · ' + abLohn + '</button>'
            : '<span class="ta-stand">Noch ' + (ab.noetig - ab.abgenommen) +
              ' von ' + ab.noetig + ' Zetteln abnehmen</span>'
      ) + '</div>';
    box.appendChild(urkunde);
    var abKnopf = urkunde.querySelector('.ta-los');
    if (abKnopf) {
      abKnopf.addEventListener('click', function () {
        act('Tag abgeschlossen', client.claimDay(), 'stufe');
      });
    }
  }

  box.querySelectorAll('.zettel-los').forEach(function (btn) {
    btn.addEventListener('click', function () {
      act('Abenteuer geschafft', client.claimTask(btn.getAttribute('data-id')), 'stufe');
    });
  });

  // Wann haengen neue Zettel? Der Countdown laeuft auf der Serveruhr, die
  // Uhrzeit steht in der Zeitzone des Geraets. Ohne Verbindung wechselt der
  // Tag nicht von allein — das muss dastehen, sonst wartet man vergeblich.
  var uhr = $('abenteuer-uhr');
  if (!uhr) return;
  if (tages.length === 0) { uhr.textContent = ''; return; }
  var w = naechsterTageswechsel();
  var rest = Math.max(0, Math.floor((w.wechsel - w.jetzt) / 1000));
  uhr.innerHTML = navigator.onLine
    ? 'Neue Zettel um <b>' + uhrzeitKurz(w.wechsel) + '</b> · noch ' + timeText(rest)
    : 'Neue Zettel um <b>' + uhrzeitKurz(w.wechsel) + '</b> — sobald dein Hof wieder Verbindung hat';
}

function zielZeile(e) {
  var einloesbar = e.erfuellt && !e.eingeloest;
  var belohnung = (e.gold > 0 ? e.gold + ' Gold' : '') +
    (e.gold > 0 && e.xp > 0 ? ' · ' : '') + (e.xp > 0 ? e.xp + ' XP' : '');

  var row = document.createElement('div');
  row.className = 'ziel' + (e.eingeloest ? ' erreicht' : '') + (einloesbar ? ' offen' : '');

  // Bei zählbaren Zielen ein Balken mit Stand, sonst nur die Belohnung.
  var fortschritt = e.ziel > 1 && !e.eingeloest
    ? '<span class="ziel-fortschritt"><span class="balken"><i style="width:' + e.prozent +
      '%"></i></span><span class="ziel-stand">' + e.ist + ' / ' + e.ziel + '</span></span>'
    : '';

  // Rechts steht, was es bringt — oder der Knopf, wenn es so weit ist.
  var rechts = e.eingeloest
    ? '<span class="ziel-hinweis erledigt">eingelöst</span>'
    : einloesbar
      ? '<button type="button" class="ziel-los" data-id="' + e.id + '">Einlösen</button>'
      : '<span class="ziel-hinweis">' + belohnung.replace(' · ', '<br>') + '</span>';

  row.innerHTML =
    '<span class="ziel-haken">' + (e.eingeloest ? '✓' : e.erfuellt ? '★' : '○') + '</span>' +
    '<span class="ziel-text">' + e.label + fortschritt + '</span>' + rechts;
  return row;
}

function renderVorrat(v) {
  var chips = $('stock');
  chips.textContent = '';
  v.stock.forEach(function (entry) {
    if (entry.item === v.currency.item) return;
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.disabled = entry.amount === 0;
    chip.title = 'Zum endgültigen Löschen tippen';
    chip.innerHTML = iconTag(entry.id) + '<span>' + nameOf(entry.id) +
      '</span><span class="n">' + entry.amount + '</span>';
    chip.addEventListener('click', function () { loeschDialog(entry); });
    chips.appendChild(chip);
  });
}

// Ware endgültig aus dem Lager löschen — ohne Gegenwert. In-App-Panel direkt
// im Lager, keine hässlichen Browser-Dialoge.
var loeschState = null;

function loeschMengeAnzeigen() {
  if (!loeschState) return;
  $('loesch-menge').textContent = String(loeschState.menge);
}

function loeschDialog(entry) {
  if (!isActive || entry.amount <= 0) return;
  loeschState = { item: entry.item, id: entry.id, max: entry.amount, menge: entry.amount };
  $('loesch-name').textContent = nameOf(entry.id);
  loeschMengeAnzeigen();
  $('loesch-panel').hidden = false;
}

function loeschZu() {
  loeschState = null;
  $('loesch-panel').hidden = true;
}

function loeschStellen(delta) {
  if (!loeschState) return;
  loeschState.menge = Math.max(1, Math.min(loeschState.max, loeschState.menge + delta));
  loeschMengeAnzeigen();
}

function loeschAusfuehren() {
  if (!loeschState) return;
  var vorrat = client.preview().items[loeschState.item] || 0;
  var n = Math.min(loeschState.menge, vorrat);
  if (n <= 0) { loeschZu(); return; }
  act(n + ' ' + nameOf(loeschState.id) + ' gelöscht', client.discard(loeschState.item, n), 'ernte');
  loeschZu();
}

var stand = null;

function standZu() { stand = null; }

function standWaren(v) {
  return v.stock.filter(function (e) { return e.sellable && e.amount > 0; });
}

function standKaufbar(v) {
  return v.stock.filter(function (e) { return e.sellable && e.amount > 0; });
}

function standGrenzen(entry) {
  var deckel = entry.maxAmount > 0 ? entry.maxAmount : entry.amount;
  return {
    menge: Math.max(1, Math.min(entry.amount, deckel)),
    min: entry.bandMin,
    max: entry.bandMax,
  };
}

function renderStand(v) {
  var kaesten = $('stand-kaesten');
  var fuellen = $('stand-fuellen');

  if (stand && !v.stock[stand.item] && stand.item !== null) stand = null;

  if (!stand) {
    fuellen.hidden = true;
    fuellen.textContent = '';
    kaesten.hidden = false;
    zeichneKaesten(v, kaesten);
    return;
  }

  kaesten.hidden = true;
  kaesten.textContent = '';
  fuellen.hidden = false;
  zeichneFuellen(v, fuellen);
}

function zeichneKaesten(v, box) {
  box.textContent = '';

  var kopf = document.createElement('div');
  kopf.className = 'stand-kopf';
  var kasse = v.orders.reduce(function (n, o) { return n + (o.sold > 0 ? 1 : 0); }, 0);
  kopf.innerHTML = '<span>Deine Kästchen</span><span class="frei">' +
    (kasse > 0
      ? kasse + ' verkauft — abholen'
      : v.orderSlotsFree + ' von ' + v.orderSlots + ' frei') + '</span>';
  box.appendChild(kopf);

  var raster = document.createElement('div');
  raster.className = 'stand-raster';
  var waren = standWaren(v);

  for (var i = 0; i < v.orderSlots; i++) {
    raster.appendChild(v.orders[i] ? vollesKaestchen(v.orders[i]) : leeresKaestchen(waren));
  }
  box.appendChild(raster);

  var hinweis = document.createElement('p');
  hinweis.className = 'note';
  hinweis.textContent = waren.length === 0
    ? 'Noch nichts zu verkaufen — erst ernten.'
    : 'Höchstens ' + standLimit(v) + ' Stück je Kästchen.';
  box.appendChild(hinweis);
}

function standLimit(v) {
  for (var i = 0; i < v.stock.length; i++) {
    if (v.stock[i].sellable && v.stock[i].maxAmount > 0) return v.stock[i].maxAmount;
  }
  return 0;
}

function vollesKaestchen(o) {
  var b = document.createElement('button');
  b.type = 'button';

  if (o.sold > 0) {
    b.className = 'kaestchen verkauft';
    b.innerHTML = itemIcon(rules.currency, 'gross') +
      '<span class="n">' + o.sold + '</span>' +
      '<span class="p">verkauft</span>' +
      '<span class="rest">abholen</span>';
    b.addEventListener('click', function () {
      var geld = o.sold;
      var wo = b.getBoundingClientRect();
      var erg = client.collectSale(o.id);
      act('Kasse · +' + geld + ' ' + itemName(rules.currency), erg, 'muenzen');
      if (erg.ok) { zahlAuf(wo, '+' + geld, 'muenzen'); geldbeutelHuepft(); }
    });
    return b;
  }

  b.className = 'kaestchen voll';
  b.innerHTML = itemIcon(o.item, 'gross') +
    '<span class="n">' + o.amount + '×</span>' +
    '<span class="p">' + o.price + iconTag(rules.items[rules.currency].id) + '</span>' +
    '<span class="rest">' + (o.expiresIn === null
      ? 'steht seit ' + timeText(o.listedFor)
      : 'noch ' + timeText(o.expiresIn)) + '</span>';
  b.addEventListener('click', function () {
    act('Zurückgeholt · ' + o.amount + ' ' + itemName(o.item), client.cancelOrder(o.id));
  });
  return b;
}

function leeresKaestchen(waren) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'kaestchen leer';
  b.disabled = waren.length === 0;
  b.innerHTML = '<span class="plus">+</span><span class="rest">frei</span>';
  b.addEventListener('click', function () {
    stand = { item: null, amount: 1, price: 1 };
    render();
  });
  return b;
}

function zeichneFuellen(v, box) {
  box.textContent = '';

  var kopf = document.createElement('div');
  kopf.className = 'stand-kopf';
  var zurueck = document.createElement('button');
  zurueck.type = 'button';
  zurueck.className = 'zurueck';
  zurueck.textContent = '‹ Zurück';
  zurueck.addEventListener('click', function () { standZu(); render(); });
  var titel = document.createElement('span');
  titel.textContent = stand.item === null ? 'Was soll rein?' : 'Menge und Preis';
  kopf.appendChild(zurueck);
  kopf.appendChild(titel);
  box.appendChild(kopf);

  if (stand.item === null) {
    zeichneWarenwahl(v, box);
    return;
  }
  zeichnePreiswahl(v, box);
}

function zeichneWarenwahl(v, box) {
  var waren = standKaufbar(v);
  var raster = document.createElement('div');
  raster.className = 'stand-raster';

  waren.forEach(function (entry) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'kaestchen wahl' + (entry.locked ? ' gesperrt' : '');
    b.disabled = entry.locked || entry.amount <= 0;
    b.innerHTML = iconTag(entry.id, 'gross') +
      '<span class="n">' + nameOf(entry.id) + '</span>' +
      '<span class="rest">' + (entry.locked
        ? 'ab Stufe ' + entry.unlockLevel
        : 'du hast ' + entry.amount) + '</span>';
    if (!entry.locked && entry.amount > 0) {
      b.addEventListener('click', function () {
        var g = standGrenzen(entry);
        stand = { item: entry.item, amount: g.menge, price: g.max };
        render();
      });
    }
    raster.appendChild(b);
  });

  box.appendChild(raster);
}

function zeichnePreiswahl(v, box) {
  var entry = v.stock[stand.item];
  var g = standGrenzen(entry);
  var amount = clamp(stand.amount, 1, g.menge);
  var price = clamp(stand.price, g.min, g.max);
  var fee = NS.listingFee(rules, entry.item, amount);
  var canPayFee = v.currency.amount >= fee;
  var free = v.orderSlotsFree;

  var karte = document.createElement('div');
  karte.className = 'card trade';

  var head = document.createElement('div');
  head.className = 'head';
  head.innerHTML =
    '<span class="name">' + iconTag(entry.id, 'gross') + nameOf(entry.id) + '</span>' +
    '<span class="have">du hast ' + entry.amount + '</span>';
  karte.appendChild(head);

  karte.appendChild(numberPick(
    'Menge',
    function () { return stand.amount; },
    1,
    g.menge,
    function (n, typing) { stand.amount = n; if (!typing) render(); },
    'max ' + g.menge,
  ));

  karte.appendChild(numberPick(
    'Preis',
    function () { return stand.price; },
    g.min,
    g.max,
    function (n, typing) { stand.price = n; if (!typing) render(); },
  ));

  var schnell = document.createElement('div');
  schnell.className = 'preisknoepfe';
  var mitte = Math.round((g.min + g.max) / 2);
  [['günstig', g.min], ['mittel', mitte], ['Höchstpreis', g.max]].forEach(function (paar) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = paar[0];
    if (price === paar[1]) b.className = 'an';
    b.addEventListener('click', function () { stand.price = paar[1]; render(); });
    schnell.appendChild(b);
  });
  karte.appendChild(schnell);

  var go = document.createElement('button');
  go.type = 'button';
  go.className = 'done';
  go.disabled = free <= 0 || !canPayFee;
  go.textContent = 'Hinstellen · bringt ' + amount * price + ' ' + itemName(v.currency.item);
  go.addEventListener('click', function () {
    var res = client.listOrder(entry.item, amount, price);
    act('Hingestellt · ' + amount + ' ' + nameOf(entry.id), res);
    if (res.ok) { standZu(); render(); }
  });
  karte.appendChild(go);

  var note = document.createElement('div');
  note.className = 'note';
  note.textContent = free <= 0
    ? 'Alle Kästchen sind belegt'
    : !canPayFee
    ? 'Gebühr ' + fee + ' ' + itemName(v.currency.item) + ' — so viel hast du nicht'
    : 'Gebühr ' + fee + ' ' + itemName(v.currency.item) + ' · Preis ' + g.min + '–' + g.max;
  karte.appendChild(note);

  box.appendChild(karte);
}

function renderBadges(v) {
  var punkt = $('zahnrad-punkt');
  if (!punkt) return;
  var offen = (v.erfolge || []).filter(function (e) {
    return e.erfuellt && !e.eingeloest;
  }).length;
  punkt.hidden = offen === 0;
}

function renderBauliste(v) {
  var box = $('bauliste');
  box.textContent = '';

  if (!v.grid) {
    box.innerHTML = '<p class="empty">Dieser Hof läuft noch auf einem Regelwerk ohne Raster. ' +
      'Beim nächsten Sync nach einem Server-Update wandert er darauf.</p>';
    return;
  }
  // Dekoration ist eine eigene Kategorie, getrennt von den Bauwerken.
  var bauwerke = v.buildable.filter(function (b) { return !b.deco; });
  var deko = v.buildable.filter(function (b) { return b.deco; });

  if (bauwerke.length === 0 && deko.length === 0) {
    box.innerHTML = '<p class="empty">Alles gebaut.</p>';
    return;
  }

  bauSektion(box, 'Bauwerke', bauwerke, bauwerke.length === 0 ? 'Alles gebaut.' : null);
  bauSektion(box, 'Dekoration', deko, 'Keine Dekoration verfügbar.');
}

// Eine Kategorie im Baumenü: Überschrift, dann gruppierte Karten. Fehlt Ware,
// erscheint der Leer-Hinweis — aber nur, wenn wirklich nichts da ist.
function bauSektion(box, titel, liste, leerText) {
  var h = document.createElement('h2');
  h.textContent = titel;
  box.appendChild(h);

  if (liste.length === 0) {
    if (leerText) {
      var leer = document.createElement('p');
      leer.className = 'empty';
      leer.textContent = leerText;
      box.appendChild(leer);
    }
    return;
  }

  // Gleiche Bauwerke (z. B. mehrere Apfelbäume) zu einer Karte zusammenfassen.
  var gruppen = [];
  var index = {};
  liste.forEach(function (b) {
    var name = plotName(b.plot);
    if (index[name] === undefined) { index[name] = gruppen.length; gruppen.push({ b: b, name: name, anzahl: 0 }); }
    gruppen[index[name]].anzahl++;
  });

  var lager = lagerJetzt();
  gruppen.forEach(function (g) {
    var b = g.b;
    var karte = document.createElement('button');
    karte.className = 'card';
    karte.disabled = !b.affordable;
    karte.innerHTML =
      '<div class="body">' +
      '<div class="top">' + g.name +
        (g.anzahl > 1 ? ' · noch ' + g.anzahl + ' frei' : '') +
        (b.label && b.label !== g.name && g.name.indexOf(b.label) !== 0
          ? ' · ' + b.label
          : '') + '</div>' +
      '<div class="sub">' + (!b.unlocked
        ? 'ab Stufe ' + b.minPlayerLevel
        : b.packed
          ? 'eingepackt · kostenlos · ' + b.size.w + '×' + b.size.h + ' Felder'
          : b.size.w + '×' + b.size.h + ' Felder') + '</div>' +
      (b.unlocked && !b.packed
        ? zutatenHtml(b.cost, lager, { titel: 'kostet', klasse: 'klein' })
        : '') + '</div>' +
      '<span class="go">' + (!b.unlocked ? '🔒' : b.packed ? 'Aufstellen' : 'Bauen') + '</span>';
    karte.addEventListener('click', function () { baueUndSetze(b.plot); });
    box.appendChild(karte);
  });
}

function renderHofinfo(v) {
  var box = $('hofinfo');
  box.textContent = '';

  var karte = document.createElement('div');
  karte.className = 'note';
  karte.innerHTML =
    'Stufe ' + v.level + ' · ' + v.xp.total + ' XP<br>' +
    'Lager ' + v.silo.used + '/' + v.silo.capacity +
    ' · Auslage ' + (v.orders.length) + '/' + (v.orders.length + v.orderSlotsFree);
  box.appendChild(karte);
}

var CODES = {
  NO_BAIT: 'Kein Köder mehr',
  NO_FISHING: 'Der Angelsee ist noch nicht offen',
  BOAT_DONE: 'Das Boot ist schon repariert',
  NO_REPAIR: 'Hier gibt es nichts zu reparieren',
  NO_CRAFT: 'Das lässt sich hier nicht herstellen',
  NO_SUCH_SPOT: 'Diese Angelstelle gibt es nicht',
  SPOT_BUSY: 'Da liegt schon ein Köder',
  SPOT_EMPTY: 'Hier liegt kein Köder',
  SPOT_NOT_READY: 'Die Reuse zieht noch',
  NO_BAIT_SLOT: 'Alle Sud-Plätze sind belegt',
  BAIT_NOT_READY: 'Der Sud ist noch nicht fertig',
  LAND_LOCKED: 'Erst das Land drumherum freimachen',
  CELL_TAKEN: 'Da steht schon etwas',
  OFF_GRID: 'Da ist kein Platz',
  NOT_PLACED: 'Erst hinstellen',
  TRUCK_AWAY: 'Der Wagen ist unterwegs',
  TRUCK_NOT_FULL: 'Erst vollständig beladen',
  NO_WAYBILL: 'Kein Frachtbrief da',
  TOO_MUCH: 'So viel verlangt der Frachtbrief nicht',
  SILO_FULL: 'Lager voll',
  CANT_AFFORD: 'Zu wenig Gold',
  NOT_ENOUGH_ITEMS: 'Zutaten fehlen',
  NOT_DONE: 'Noch nicht fertig',
  PLAYER_LEVEL_TOO_LOW: 'Stufe zu niedrig',
  NO_ORDER_SLOTS: 'Keine Auslage-Plätze frei',
  NOTHING_TO_COLLECT: 'Postfach ist leer',
  NO_SUCH_OFFER: 'Angebot ist weg',
  NOT_BUYABLE: 'Das führt der Händler nicht',
  SKIP_ON_COOLDOWN: 'Noch zu früh fürs Wegschicken',
  REQUEST_NOT_ACTIVE: 'Der wartet noch hinten',
  PRICE_OUT_OF_BAND: 'Preis außerhalb des Bandes',
  TOO_MANY_PER_SLOT: 'Zu viel für ein Kästchen',
  ITEM_LOCKED: 'Dafür fehlt dir die Stufe',
  NO_ANIMAL: 'Auf dem Platz steht kein Tier',
  ANIMAL_TOO_YOUNG: 'Das Junge ist noch zu klein',
  NO_ANIMAL_SPACE: 'Der Stall ist voll',
  NOT_AN_ANIMAL_PLOT: 'Hier wohnt kein Tier',
  ALREADY_SOLD: 'Schon verkauft — Gold abholen',
  NOT_SOLD: 'Da ist noch nichts verkauft',
  BAD_AMOUNT: 'Ungültige Menge',
  OFFER_GONE: 'Jemand war schneller',
  PLOT_BUSY: 'Läuft noch',
  MAX_LEVEL: 'Voll ausgebaut',
  ALREADY_EXPANDED: 'Schon freigeschaltet',
  NO_SUCH_EXPANSION: 'Kein Land zum Freischalten',
};

// — Als Naechstes ——————————————————————————————————————————————————————
// Ein Hof ohne naechsten Schritt ist ein Hof, den man zumacht. Diese Zeile
// nennt immer genau eine Sache: was gerade bereitliegt, sonst was als Naechstes
// fertig wird, sonst was zu liefern waere, sonst dass Platz zum Saeen ist.
// Sie steht unter dem Hof im Fluss und verdeckt nichts.
function naechsterSchritt(v) {
  if (typeof seeAktiv !== 'undefined' && seeAktiv) return null;

  var reif = [];
  var laeuft = null;
  v.plots.forEach(function (p) {
    if (p.deco || p.level <= 0) return;
    if (p.baum) {
      if (p.baum.stufe === 'reif') reif.push(p);
      else if (p.baum.reifIn > 0 && (laeuft === null || p.baum.reifIn < restVon(laeuft))) {
        laeuft = p;
      }
      return;
    }
    if (p.tap === 'collect') { reif.push(p); return; }
    if (p.busy && p.remaining > 0 && (laeuft === null || p.remaining < restVon(laeuft))) laeuft = p;
  });

  if (reif.length > 0) {
    return {
      icon: '🌾',
      bereit: true,
      text: reif.length === 1
        ? plotName(reif[0].index) + ' ist fertig'
        : reif.length + ' Plätze sind fertig',
      plot: reif[0].index,
    };
  }
  if (laeuft !== null) {
    var was = laeuft.baum
      ? plotName(laeuft.index)
      : (laeuft.producing ? nameOf(laeuft.producing) : plotName(laeuft.index));
    return { icon: '⏳', bereit: false, text: was + ' in ' + timeText(restVon(laeuft)), plot: laeuft.index };
  }

  var zettel = ((v.truck && v.truck.board) || []).filter(function (z) { return z.deliverable; });
  if (zettel.length > 0) return { icon: '🚚', bereit: true, text: 'Zettel lieferbar', blatt: 'brett' };

  var frei = null;
  v.plots.forEach(function (p) {
    if (frei === null && p.level > 0 && !p.deco && !p.baum && p.tap === 'start') frei = p;
  });
  if (frei !== null) return { icon: '🌱', bereit: false, text: 'Nichts läuft — säen?', plot: frei.index };
  return null;
}

function restVon(p) {
  return p && p.baum ? p.baum.reifIn : (p ? p.remaining : 0);
}

var naechstesZiel = null;

function renderNaechstes(v) {
  var knopf = $('naechstes');
  if (!knopf) return;
  var schritt = view === 'farm' ? naechsterSchritt(v) : null;
  naechstesZiel = schritt;
  knopf.hidden = schritt === null;
  if (schritt === null) return;
  $('naechstes-icon').textContent = schritt.icon;
  $('naechstes-text').textContent = schritt.text;
  knopf.classList.toggle('bereit', !!schritt.bereit);
}

// Antippen bringt einen hin, statt bloss zu erzaehlen.
function naechstesHin() {
  var ziel = naechstesZiel;
  if (!ziel) return;
  if (ziel.blatt) { show(ziel.blatt); return; }
  if (typeof ziel.plot !== 'number') return;

  var p = NS.farmView(client.preview(), rules, navigator.onLine).plots[ziel.plot];
  if (p && hatRaster() && p.gx >= 0) {
    zentriere(p.gx + p.size.w / 2, p.gy + p.size.h / 2);
    kameraKlemmen();
    kameraAnwenden();
  }
  var kachel = document.querySelector('#plots .plot[data-platz="' + ziel.plot + '"]');
  if (kachel) {
    kachel.classList.add('zeigt');
    setTimeout(function () { kachel.classList.remove('zeigt'); }, 2600);
  }
}
