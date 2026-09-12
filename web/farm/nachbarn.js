var eigenerHof = null;
var besuchCode = null;
var besuchDaten = null;
var besuchTimer = null;

function ladeBestenliste() {
  api('/api/bestenliste').then(zeichneBestenliste).catch(function () {
    $('bestenliste-liste').innerHTML = '<p class="empty">Bestenliste gerade nicht erreichbar.</p>';
  });
}

function zeichneBestenliste(d) {
  $('bestenliste-eigen').innerHTML = d.ich
    ? '<div class="rang-eigen">Du: Platz ' + d.ich.platz + ' von ' + d.gesamt + '</div>'
    : '';
  var box = $('bestenliste-liste');
  box.textContent = '';
  var top = d.top || [];
  if (top.length === 0) {
    box.innerHTML = '<p class="empty">Noch niemand auf der Tafel.</p>';
    return;
  }

  // Das Podest: die ersten drei, der Erste in der Mitte und am hoechsten.
  var podest = document.createElement('div');
  podest.className = 'podest';
  var stufen = ['eins', 'zwei', 'drei'];
  top.slice(0, 3).forEach(function (e, i) {
    var platz = document.createElement('div');
    platz.className = 'podest-platz ' + stufen[i] + (e.ich ? ' ich' : '');
    platz.innerHTML =
      '<div class="podest-medaille">' + e.platz + '</div>' +
      '<div class="podest-name">' + e.name + '</div>' +
      '<div class="podest-stufe">Stufe ' + e.level + '</div>' +
      '<div class="podest-block">' + e.platz + '</div>';
    podest.appendChild(platz);
  });
  box.appendChild(podest);

  // Der Rest: eine Liste auf einem Blatt Papier.
  var rest = top.slice(3);
  if (rest.length === 0) return;
  var liste = document.createElement('div');
  liste.className = 'rang-liste';
  rest.forEach(function (e) {
    var row = document.createElement('div');
    row.className = 'rang' + (e.ich ? ' ich' : '');
    row.innerHTML =
      '<span class="rang-platz">' + e.platz + '.</span>' +
      '<span class="rang-name">' + e.name + '</span>' +
      '<span class="rang-wert">Stufe ' + e.level + '</span>';
    liste.appendChild(row);
  });
  box.appendChild(liste);
}

function hofLaden() {
  return api('/api/hof').then(function (h) {
    eigenerHof = h;
    zeichneEigenenHof();
    return h;
  }).catch(function () {});
}

function zeichneEigenenHof() {
  var box = $('eigenerhof');
  if (!box) return;
  box.textContent = '';
  if (!eigenerHof) {
    box.innerHTML = '<p class="empty">Dein Hofcode kommt mit der Verbindung.</p>';
    return;
  }

  var karte = document.createElement('div');
  karte.className = 'hofkarte';

  var zeile = document.createElement('div');
  zeile.className = 'zeile';
  var wer = document.createElement('span');
  wer.className = 'wer';
  wer.textContent = 'Dein Hof';
  var code = document.createElement('span');
  code.className = 'code';
  code.textContent = eigenerHof.code;
  zeile.appendChild(wer);
  zeile.appendChild(code);
  karte.appendChild(zeile);

  var reihe = document.createElement('div');
  reihe.className = 'eingabe';
  var feld = document.createElement('input');
  feld.type = 'text';
  feld.id = 'hofnamefeld';
  feld.maxLength = eigenerHof.maxName || 24;
  feld.value = eigenerHof.name;
  feld.setAttribute('aria-label', 'Name deines Hofs');
  var knopf = document.createElement('button');
  knopf.type = 'button';
  knopf.textContent = 'Merken';
  knopf.addEventListener('click', function () {
    api('/api/hof?name=' + encodeURIComponent(feld.value), { method: 'POST' })
      .then(function (h) { eigenerHof = h; toast('Hof heißt jetzt ' + h.name); zeichneEigenenHof(); })
      .catch(function () { toast('Der Name geht so nicht', true); });
  });
  reihe.appendChild(feld);
  reihe.appendChild(knopf);
  karte.appendChild(reihe);

  var fuss = document.createElement('p');
  fuss.className = 'fuss';
  fuss.textContent = 'Gib den Code weiter — damit kann dich jemand besuchen.';
  karte.appendChild(fuss);

  box.appendChild(karte);
}

var freundeTimer = null;

function freundeWachen(an) {
  if (freundeTimer) { clearInterval(freundeTimer); freundeTimer = null; }
  if (an) freundeTimer = setInterval(function () {
    if (!document.hidden && netzOk()) freundeLaden();
  }, 5000);
}

function freundeLaden() {
  return api('/api/freunde').then(function (d) {
    zeichneFreunde(d);
    return d;
  }).catch(function () {
    $('freundeliste').innerHTML = '<p class="empty">Nachbarn brauchen Verbindung.</p>';
  });
}

function wappenFuer(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function hofZeile(h, art) {
  var karte = document.createElement('div');
  karte.className = 'nachbar';
  karte.dataset.hof = h.code;

  var wappen = document.createElement('div');
  wappen.className = 'wappen';
  wappen.textContent = wappenFuer(h.name);
  karte.appendChild(wappen);

  var offen = Math.max(0, h.proTag - h.heute);
  var body = document.createElement('div');
  body.className = 'body';
  body.innerHTML =
    '<div class="top">' + h.name + '</div><div class="sub">' + h.code + ' · ' +
    (art === 'anfrage' ? 'möchte dein Nachbar sein'
      : art === 'gefragt' ? 'wartet auf Antwort'
      : offen > 0 ? offen + '× helfen möglich'
      : 'heute schon geholfen') + '</div>';
  karte.appendChild(body);

  var tun = document.createElement('div');
  tun.className = 'tun';

  // Nachbarn kann man beschenken — einmal am Tag, aus dem eigenen Lager.
  if (art === 'freund') {
    var schenken = document.createElement('button');
    schenken.type = 'button';
    schenken.className = 'leise schenken';
    schenken.disabled = !!h.beschenkt;
    schenken.textContent = h.beschenkt ? 'heute beschenkt' : 'Schenken';
    schenken.addEventListener('click', function () { geschenkWahl(h, karte); });
    tun.appendChild(schenken);
  }

  var knopf = document.createElement('button');
  knopf.type = 'button';
  knopf.className = 'go';
  knopf.textContent = art === 'anfrage' ? 'Annehmen' : 'Besuchen';
  knopf.addEventListener('click', function () {
    if (art === 'anfrage') {
      api('/api/freunde?code=' + encodeURIComponent(h.code), { method: 'POST' })
        .then(function () { toast(h.name + ' ist jetzt Nachbar'); klang('stufe'); freundeLaden(); })
        .catch(function () { toast('Ging nicht', true); });
      return;
    }
    besuche(h.code);
  });
  tun.appendChild(knopf);

  if (art !== 'freund') {
    var weg = document.createElement('button');
    weg.type = 'button';
    weg.className = 'leise';
    weg.textContent = art === 'anfrage' ? 'Nein' : 'Zurück';
    weg.addEventListener('click', function () {
      api('/api/freunde?code=' + encodeURIComponent(h.code), { method: 'DELETE' })
        .then(function () { freundeLaden(); })
        .catch(function () { toast('Ging nicht', true); });
    });
    tun.appendChild(weg);
  }

  karte.appendChild(tun);
  return karte;
}

function zeichneFreunde(d) {
  var box = $('freundeliste');
  box.textContent = '';

  var abschnitt = function (titel, liste, art) {
    if (!liste || liste.length === 0) return;
    var kopf = document.createElement('h2');
    kopf.textContent = titel;
    box.appendChild(kopf);
    liste.forEach(function (h) { box.appendChild(hofZeile(h, art)); });
  };

  abschnitt('Möchten dein Nachbar sein', d.anfragen, 'anfrage');
  abschnitt('Deine Nachbarn', d.freunde, 'freund');
  abschnitt('Angefragt', d.gefragt, 'gefragt');

  if (box.children.length === 0) {
    box.innerHTML = '<h2>Deine Nachbarn</h2>' +
      '<p class="empty">Noch keine Nachbarn. Frag jemanden nach seinem Code.</p>';
  }
}

function freundHinzu() {
  var code = ($('freundcode').value || '').trim().toUpperCase();
  if (code.length < 4) { toast('Der Code hat sechs Zeichen', true); return; }
  api('/api/freunde?code=' + encodeURIComponent(code), { method: 'POST' })
    .then(function (d) {
      $('freundcode').value = '';
      toast(d.stand === 'freund'
        ? d.hof.name + ' ist jetzt Nachbar'
        : 'Anfrage an ' + d.hof.name + ' — er muss zustimmen');
      klang(d.stand === 'freund' ? 'stufe' : 'tipp');
      freundeLaden();
    })
    .catch(function () { toast('Diesen Code kennt niemand', true); });
}

// — Besuch: der fremde Hof in voller Groesse ——————————————————————————————
// Kein Vorschaubild mehr: Der Hof des Nachbarn steht im Hof selbst, mit
// Kamera, Zoom und Landschaft wie daheim. Man kann sich umsehen, bei Laufendem
// helfen, an seinem Stand kaufen und — wenn sein Boot faehrt — an seinen See.
// Alles andere ist nur zum Schauen: keine Ernte, keine Saat, kein Bauen.
var hofSicht = null; // die Sicht, die der Hof gerade zeigt — eigen oder Besuch

function besuchAktiv() { return besuchCode !== null; }

// Der Hof muss von Grund auf neu gemalt werden, wenn ein anderer Hof drankommt.
function hofNeuAufbauen() {
  kamera.gesetzt = false;
  var sc = $('scene');
  if (sc) sc.dataset.stand = '';
  hindernisStand = null;
  sperrStand = null;
}

function besuche(code) {
  besuchCode = code;
  besuchDaten = null;
  client.besuch = code;
  if (typeof seeAktiv !== 'undefined' && seeAktiv) wechselZone(false);
  hofNeuAufbauen();
  show('besuch');
  besuchLeisteMalen();
  besuchHolen();
  attempt(true);
  if (besuchTimer) clearInterval(besuchTimer);
  besuchTimer = setInterval(besuchHolen, 3000);
}

function besuchEnde() {
  if (besuchCode === null && besuchDaten === null) return;
  besuchCode = null;
  besuchDaten = null;
  client.besuch = null;
  if (besuchTimer) { clearInterval(besuchTimer); besuchTimer = null; }
  if (typeof seeAktiv !== 'undefined' && seeAktiv) seeAktiv = false;
  hofNeuAufbauen();
  besuchLeisteMalen();
}

function besuchHolen() {
  if (!besuchCode || document.hidden) return;
  var code = besuchCode;
  api('/api/besuch?code=' + encodeURIComponent(code))
    .then(function (d) {
      if (besuchCode !== code) return;
      if (d.rulesetVersion !== rules.version) {
        toast('Dieser Hof läuft auf einer neueren Fassung — bitte das Spiel aktualisieren', true);
        show('farm');
        return;
      }
      var erster = besuchDaten === null;
      besuchDaten = d;
      besuchLeisteMalen();
      if (erster) hofNeuAufbauen();
      if (view === 'fremdstand') zeichneFremdenStand(d);
      render();
    })
    .catch(function () {
      if (netzWache()) return;
      toast('Der Hof ist gerade nicht erreichbar', true);
      show('farm');
    });
}

function fremdeUhr() {
  if (!besuchDaten) return 0;
  var vergangen = Math.floor((Date.now() + clockOffsetMs - besuchDaten.serverTs) / 1000);
  return besuchDaten.tick + Math.max(0, vergangen);
}

// Die Sicht auf den fremden Hof — dieselbe Rechnung wie fuer den eigenen, nur
// mit seiner Uhr.
function besuchSicht() {
  if (!besuchDaten || !besuchDaten.zustand) return null;
  var zustand = Object.assign({}, besuchDaten.zustand, { tick: fremdeUhr() });
  return NS.farmView(zustand, rules, true);
}

function besuchHilfenOffen() {
  if (!besuchDaten) return 0;
  return Math.max(0, besuchDaten.proTag - besuchDaten.heute);
}

function besuchLeisteMalen() {
  var leiste = $('besuch-leiste');
  if (!leiste) return;
  leiste.hidden = !besuchAktiv();
  if (!besuchAktiv()) return;
  var d = besuchDaten;
  $('besuch-name').textContent = d ? d.name : 'Zu Besuch';
  var offen = besuchHilfenOffen();
  $('besuch-sub').textContent = !d ? 'lädt …'
    : d.code + ' · ' + (offen > 0 ? 'tippe auf etwas, das gerade läuft' : 'heute schon ' + d.proTag + '-mal geholfen');
  var punkte = $('besuch-hilfen');
  punkte.textContent = '';
  var proTag = d ? d.proTag : 0;
  punkte.setAttribute('aria-label', offen + ' von ' + proTag + ' Hilfen offen');
  for (var i = 0; i < proTag; i++) {
    var pt = document.createElement('i');
    if (i >= offen) pt.className = 'weg';
    punkte.appendChild(pt);
  }
  var knopf = $('besuch-nachbar');
  knopf.hidden = !d;
  if (d) {
    knopf.className = d.stand === 'freund' ? 'an' : '';
    knopf.textContent = d.stand === 'freund' ? 'Nachbar'
      : d.stand === 'gefragt' ? 'gefragt'
      : d.stand === 'wartet' ? 'Annehmen'
      : 'Anfragen';
  }
}

function besuchNachbarschaft() {
  var d = besuchDaten;
  if (!d) return;
  var weg = d.stand === 'freund' || d.stand === 'gefragt';
  api('/api/freunde?code=' + encodeURIComponent(d.code), { method: weg ? 'DELETE' : 'POST' })
    .then(function (a) {
      toast(weg ? 'Nachbarschaft beendet'
        : a && a.stand === 'freund' ? 'Ihr seid jetzt Nachbarn'
        : 'Anfrage geschickt — er muss zustimmen');
      besuchHolen();
      freundeLaden();
    })
    .catch(function () { toast('Ging nicht', true); });
}

// Ein Tipp auf einen fremden Platz: Laeuft dort etwas und ist noch Hilfe
// uebrig, hilft man. Sonst gibt es nur ein Wort.
function besuchTap(p) {
  if (!besuchDaten) return;
  var laufend = null;
  p.slots.forEach(function (s) {
    if (s.busy && (!laufend || s.remaining < laufend.remaining)) laufend = s;
  });
  if (!laufend) { toast('Hier läuft gerade nichts — nur zum Schauen'); return; }
  if (besuchHilfenOffen() <= 0) { toast('Heute schon ' + besuchDaten.proTag + '-mal geholfen', true); return; }
  hilf(p.index, laufend.index);
}

// Die Moebel zu Besuch: die eigenen weichen, sein Stand und sein Boot bleiben.
function besuchMoebel(v) {
  ['brett', 'lagerhaus', 'nachbarn', 'abenteuer', 'wagen', 'kiste'].forEach(function (id) {
    var e = $(id); if (e) e.hidden = true;
  });
  var offen = besuchDaten ? besuchDaten.angebote.filter(function (o) { return o.verkauft <= 0; }) : [];
  var stand = $('stand');
  stand.hidden = false;
  moebel(stand, {}, 'Sein Stand', offen.length, 'stand');
  setzeMoebel('stand');
  var boot = $('boot');
  if (boot) {
    var heil = !!(v.angeln && v.angeln.boot && v.angeln.boot.repariert && hatRaster());
    boot.hidden = !heil;
    if (heil) {
      boot.classList.remove('kaputt');
      boot.innerHTML = moebelSvg('boot', { heil: true });
      boot.setAttribute('aria-label', 'Zu seinem Angelsee');
      setzeMoebel('boot');
    }
  }
}

function fremdenStandOeffnen() {
  if (!besuchDaten) return;
  var offen = besuchDaten.angebote.filter(function (o) { return o.verkauft <= 0; });
  if (offen.length === 0) { toast('Sein Stand ist leer'); return; }
  zeichneFremdenStand(besuchDaten);
  show('fremdstand');
}

function hilf(plot, slot) {
  if (!besuchCode) return;
  api('/api/helfen?code=' + encodeURIComponent(besuchCode) + '&plot=' + plot + '&slot=' + slot, {
    method: 'POST',
  })
    .then(function (d) {
      besuchDaten = d.besuch;
      toast('Geholfen · +' + d.xp + ' XP');
      klang('stufe');
      var kachel = document.querySelector('#plots .plot[data-platz="' + plot + '"]');
      if (kachel && typeof funken === 'function') funken(kachel.getBoundingClientRect(), 'fund');
      besuchLeisteMalen();
      render();
      attempt(true);
    })
    .catch(function () {
      toast('Hier ist gerade nichts zu tun', true);
      besuchHolen();
    });
}

function zeichneFremdenStand(d) {
  var box = $('besuch-stand');
  box.textContent = '';
  $('fremdstand-titel').textContent = d.name + ' — Verkaufsstand';

  var meine = NS.farmView(client.preview(), rules, marktLive());
  var meineStufe = meine.level;
  var kaufbar = {};
  meine.offers.forEach(function (o) { kaufbar[o.item + ':' + o.amount + ':' + o.price] = o; });

  var frei = d.angebote.filter(function (o) { return o.verkauft <= 0; });
  if (frei.length === 0) {
    box.innerHTML = '<p class="empty">Der Stand ist leer.</p>';
    return;
  }

  var raster = document.createElement('div');
  raster.className = 'stand-raster';

  frei.forEach(function (o) {
    var angebot = kaufbar[o.item + ':' + o.amount + ':' + o.price];
    var stufe = rules.buyNeedsLevel ? NS.itemUnlockLevel(rules, o.item) : 0;
    var gesperrt = meineStufe < stufe;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'kaestchen voll fremd' + (gesperrt ? ' gesperrt' : '');
    b.dataset.ware = rules.items[o.item] ? rules.items[o.item].id : String(o.item);
    b.disabled = gesperrt || !angebot || !marktLive() || !angebot.affordable || !angebot.fits;
    b.innerHTML = itemIcon(o.item, 'gross') +
      '<span class="n">' + o.amount + '×</span>' +
      '<span class="p">' + o.amount * o.price + itemIcon(rules.currency) + '</span>' +
      '<span class="rest">' + (gesperrt ? 'ab Stufe ' + stufe
        : !angebot ? 'gleich verfügbar'
        : !angebot.fits ? 'kein Platz'
        : !angebot.affordable ? 'zu teuer'
        : o.price + ' je Stück') + '</span>';
    b.addEventListener('click', function () {
      if (gesperrt || !angebot || !marktLive()) return;
      var res = client.buyOffer(angebot.id);
      act('Gekauft · ' + o.amount + ' ' + itemName(o.item), res, 'kauf');
      if (res.ok) { attempt(true); besuchHolen(); }
    });
    raster.appendChild(b);
  });

  box.appendChild(raster);
}

function pfadStufen() {
  var t = rules.levelThresholds || [];
  var max = t.length + 1;
  var stufen = [];
  for (var l = 1; l <= max; l++) {
    var von = l === 1 ? 0 : t[l - 2];
    var bis = l <= t.length ? t[l - 1] : null;
    stufen.push({ level: l, von: von, bis: bis, frei: NS.freischaltungenAb(rules, l) });
  }
  return stufen;
}

function gabeZeile(pn, art, bild) {
  return '<span class="gabe">' + (bild || '') + '<span>' + pn + '</span></span>';
}

function renderPfad(v) {
  var kopf = $('pfad-kopf');
  var stufen = pfadStufen();
  var jetzt = v.level;
  var xp = v.xp.total;

  var akt = stufen[jetzt - 1];
  if (v.xp.atMax || !akt || akt.bis === null) {
    kopf.innerHTML = '<div class="gross"><span class="stufe">Stufe ' + jetzt +
      '</span><span class="rest">Höchststufe</span></div>' +
      '<div class="zahlen"><span class="hast">' + xp + ' XP</span></div>';
  } else {
    var into = xp - akt.von;
    var span = akt.bis - akt.von;
    var fehlt = akt.bis - xp;
    var pct = Math.max(0, Math.min(100, Math.round((into * 100) / span)));
    kopf.innerHTML =
      '<div class="gross"><span class="stufe">Stufe ' + jetzt + '</span>' +
      '<span class="rest">' + pct + ' % bis Stufe ' + (jetzt + 1) + '</span></div>' +
      '<div class="balken"><i style="width:' + pct + '%"></i><span class="mitte"></span></div>' +
      '<div class="zahlen"><span class="hast">' + into + ' / ' + span + ' XP</span>' +
      '<span class="fehlt">noch ' + fehlt + ' XP</span></div>';
  }

  var box = $('pfad-liste');
  box.textContent = '';
  var pfad = document.createElement('div');
  pfad.className = 'pfad';

  stufen.forEach(function (s) {
    var gaben = [];
    (s.frei.plots || []).forEach(function (id) {
      var pn = plotIdName(id);
      gaben.push(gabeZeile(pn.name, pn.art, '<span class="ic">🔨</span>'));
    });
    (s.frei.recipes || []).forEach(function (i) {
      var r = rules.recipes[i];
      gaben.push(gabeZeile(
        itemName(r.output.item) + zutatenHtml(r.inputs, null, { klasse: 'klein' }),
        '', itemIcon(r.output.item)));
    });

    var zustand = s.level < jetzt ? 'fertig' : s.level === jetzt ? 'jetzt' : '';
    var leer = gaben.length === 0;

    var stein = document.createElement('div');
    stein.className = 'stein ' + zustand + (leer ? ' leer' : '');

    var knoten = document.createElement('div');
    knoten.className = 'knoten';
    knoten.textContent = s.level;
    stein.appendChild(knoten);

    var karte = document.createElement('div');
    karte.className = 'karte';
    var titel = s.level === jetzt ? 'Du bist hier'
      : leer ? 'Stufe ' + s.level
      : 'Schaltet frei';
    karte.innerHTML = '<div class="titel">' + titel +
      (leer ? '' : ' <span class="lvl">· Stufe ' + s.level + '</span>') + '</div>' +
      (leer ? '' : '<div class="gaben">' + gaben.join('') + '</div>');
    stein.appendChild(karte);

    pfad.appendChild(stein);
  });

  box.appendChild(pfad);

  var hier = pfad.querySelector('.stein.jetzt');
  if (hier) setTimeout(function () {
    hier.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, 30);
}

// — Geschenke ————————————————————————————————————————————————————————
// Etwas aus dem eigenen Lager an einen Nachbarn schicken. Der Waehler haengt
// sich unter die Karte: Ware antippen, Menge, Schicken. Vor dem Schicken wird
// abgeglichen, damit der Server denselben Bestand sieht wie das Geraet.
var GESCHENK_MAX = 5;

function geschenkWahl(h, karte) {
  var alt = karte.querySelector('.geschenk-wahl');
  if (alt) { alt.remove(); return; }
  var v = NS.farmView(client.preview(), rules, navigator.onLine);
  var waren = v.stock.filter(function (e) {
    return e.amount > 0 && e.item !== rules.currency && rules.items[e.item].storable;
  }).sort(function (a, b) { return b.amount - a.amount; }).slice(0, 10);

  var box = document.createElement('div');
  box.className = 'geschenk-wahl';
  if (waren.length === 0) {
    box.innerHTML = '<p class="empty">Nichts im Lager, das man verschenken könnte.</p>';
    karte.appendChild(box);
    return;
  }
  var gewaehlt = waren[0].item;
  var menge = Math.min(GESCHENK_MAX, waren[0].amount);

  var chips = document.createElement('div');
  chips.className = 'chips';
  waren.forEach(function (e) {
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (e.item === gewaehlt ? ' an' : '');
    chip.innerHTML = itemIcon(e.item) + '<span>' + itemName(e.item) + '</span><span class="n">' + e.amount + '</span>';
    chip.addEventListener('click', function () {
      gewaehlt = e.item;
      menge = Math.min(GESCHENK_MAX, e.amount);
      chips.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('an'); });
      chip.classList.add('an');
      zeigeMenge();
    });
    chips.appendChild(chip);
  });
  box.appendChild(chips);

  var reihe = document.createElement('div');
  reihe.className = 'geschenk-menge';
  reihe.innerHTML = '<button type="button" class="leise" data-tu="-1">−</button>' +
    '<b class="zahl"></b><button type="button" class="leise" data-tu="1">+</button>' +
    '<button type="button" class="go schicken">Schicken</button>';
  box.appendChild(reihe);
  function zeigeMenge() {
    var have = (v.stock.find(function (e) { return e.item === gewaehlt; }) || { amount: 0 }).amount;
    menge = Math.max(1, Math.min(menge, GESCHENK_MAX, have));
    reihe.querySelector('.zahl').textContent = menge + '× ' + stueckName(menge, gewaehlt);
  }
  reihe.querySelectorAll('[data-tu]').forEach(function (b) {
    b.addEventListener('click', function () { menge += Number(b.getAttribute('data-tu')); zeigeMenge(); });
  });
  reihe.querySelector('.schicken').addEventListener('click', function () {
    reihe.querySelector('.schicken').disabled = true;
    geschenkSenden(h, gewaehlt, menge, karte);
  });
  zeigeMenge();
  karte.appendChild(box);
}

function geschenkSenden(h, item, menge, karte) {
  if (!netzOk()) { toast('Ohne Verbindung geht das nicht', true); return; }
  var zielKarte = karte;
  attempt(true).then(function () {
    return api('/api/geschenk?code=' + encodeURIComponent(h.code) + '&item=' +
      encodeURIComponent(rules.items[item].id) + '&amount=' + menge, { method: 'POST' });
  }).then(function () {
    toast('Geschenk an ' + h.name + ' unterwegs · ' + menge + '× ' + stueckName(menge, item));
    klang('stufe');
    flugZu($('silo'), zielKarte, itemIcon(item), 'ware', Math.min(menge, 3));
    h.beschenkt = true;
    attempt(true);
    setTimeout(freundeLaden, 700);
  }).catch(function (e) {
    var code = (e && e.message) || '';
    toast(/429/.test(code) ? h.name + ' hast du heute schon beschenkt'
      : /409/.test(code) ? 'So viel hast du nicht mehr'
      : /403/.test(code) ? 'Nur Nachbarn kann man beschenken'
      : 'Geschenk ging nicht', true);
    freundeLaden();
  });
}

// Was einem geschenkt wurde: einmal abholen, je Geschenk ein Moment.
function geschenkeHolen() {
  if (!token || !netzOk()) return;
  api('/api/geschenke').then(function (d) {
    (d.geschenke || []).forEach(function (g) {
      moment({
        klang: 'truhe', winkt: 'lagerhaus', hin: 'lager',
        text: '🎁 Geschenk von ' + g.von + ' · ' + g.amount + '× ' + stueckName(g.amount, g.item) + ' — im Postfach',
      });
    });
  }).catch(function () {});
}
