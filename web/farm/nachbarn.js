var eigenerHof = null;
var besuchCode = null;
var besuchDaten = null;
var besuchTimer = null;

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

function besuche(code) {
  besuchCode = code;
  client.besuch = code;
  show('besuch');
  besuchHolen();
  attempt(true);
  if (besuchTimer) clearInterval(besuchTimer);
  besuchTimer = setInterval(besuchHolen, 3000);
}

function besuchEnde() {
  besuchCode = null;
  besuchDaten = null;
  client.besuch = null;
  if (besuchTimer) { clearInterval(besuchTimer); besuchTimer = null; }
}

function besuchHolen() {
  if (!besuchCode || document.hidden) return;
  api('/api/besuch?code=' + encodeURIComponent(besuchCode))
    .then(function (d) {
      besuchDaten = d;
      try {
        zeichneBesuch();
      } catch (e) {
        $('besuch-kopf').innerHTML = '<p class="empty">Fehler beim Zeichnen: ' + e.message + '</p>';
      }
    })
    .catch(function () {
      if (netzWache()) return;
      $('besuch-kopf').innerHTML = '<p class="empty">Der Hof ist gerade nicht erreichbar.</p>';
    });
}

function fremdeUhr() {
  if (!besuchDaten) return 0;
  var vergangen = Math.floor((Date.now() + clockOffsetMs - besuchDaten.serverTs) / 1000);
  return besuchDaten.tick + Math.max(0, vergangen);
}

function fremdeRegeln() {
  return NS.getRuleset(besuchDaten.rulesetVersion);
}

function zeichneBesuch() {
  if (!besuchDaten) return;
  var d = besuchDaten;
  $('besuch-titel').textContent = d.name;

  zeichneFremdeFarm(d);
  zeichneBesuchKopf(d);
  if (view === 'fremdstand') zeichneFremdenStand(d);
}

function zeichneFremdeFarm(d) {
  var regeln = fremdeRegeln();
  var jetzt = fremdeUhr();

  var szene = $('besuch-scene');
  if (szene.dataset.stand !== 'gemalt') {
    szene.innerHTML = artBoden(false);
    szene.dataset.stand = 'gemalt';
  }

  zeichneFremdeHindernisse(d, regeln);

  var box = $('besuch-plots');
  box.textContent = '';

  var sichtbar = [];
  d.plots.forEach(function (p, i) {
    if (p.level <= 0 || p.gx < 0) return;
    sichtbar.push({ index: i, p: p, ort: plotKasten(i, { gx: p.gx, gy: p.gy }) });
  });
  sichtbar.sort(function (a, b) { return a.ort.tiefe - b.ort.tiefe; });

  sichtbar.forEach(function (eintrag) {
    var i = eintrag.index;
    var p = eintrag.p;
    var ort = eintrag.ort;

    var laeuft = null;
    var fertig = 0;
    p.slots.forEach(function (s, j) {
      if (s.recipe < 0) return;
      var dauer = regeln.recipes[s.recipe].durationTicks;
      var rest = dauer - (jetzt - s.startedAt);
      if (rest <= 0) { fertig++; return; }
      if (!laeuft || rest < laeuft.rest) laeuft = { slot: j, rest: rest, dauer: dauer };
    });

    var helfbar = !!laeuft && d.heute < d.proTag;

    var kachel = document.createElement('button');
    kachel.className = 'plot' + (fertig > 0 ? ' ripe' : '') + (helfbar ? ' hilfe' : '');
    kachel.dataset.platz = String(i);
    kachel.style.left = ort.left + '%';
    kachel.style.top = ort.top + '%';
    kachel.style.width = ort.width + '%';
    kachel.style.height = ort.height + '%';
    kachel.style.zIndex = String(1 + Math.round(ort.tiefe * 2));
    kachel.disabled = !helfbar;

    var art = document.createElement('div');
    art.innerHTML =
      '<svg class="art" viewBox="0 0 100 80" preserveAspectRatio="none" aria-hidden="true">' +
      fremdeKunst(regeln, i, p, laeuft, fertig) + '</svg>';
    kachel.appendChild(art.firstChild);

    if (laeuft) {
      var bar = document.createElement('div');
      bar.className = 'bar';
      var fill = document.createElement('i');
      fill.style.width = Math.round((1 - laeuft.rest / laeuft.dauer) * 100) + '%';
      bar.appendChild(fill);
      kachel.appendChild(bar);
    }

    // Nur laufende oder fertige Plätze beschriften — sonst überladen Labels
    // wie „nichts zu tun" den fremden Hof.
    if (laeuft || fertig > 0) {
      var meta = document.createElement('div');
      meta.className = 'meta';
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = fremdName(regeln, i);
      var status = document.createElement('div');
      status.className = 'status';
      status.textContent = laeuft
        ? (helfbar ? 'noch ' + timeText(laeuft.rest) + ' · helfen' : 'noch ' + timeText(laeuft.rest))
        : 'fertig';
      meta.appendChild(name);
      meta.appendChild(status);
      kachel.appendChild(meta);
    }

    if (helfbar) {
      kachel.addEventListener('click', function () { hilf(i, laeuft.slot); });
    }
    box.appendChild(kachel);
  });

  zeichneFremdenStandKnopf(d);
}

function fremdeKunst(regeln, i, p, laeuft, fertig) {
  return artFor({
    id: regeln.plots[i].id,
    busy: !!laeuft,
    done: fertig > 0,
    progress: laeuft ? 1 - laeuft.rest / laeuft.dauer : 0,
    producing: null,
    capacity: p.slots.length,
    stall: regeln.plots[i].animal ? { animals: p.tiere } : null,
  });
}

function fremdName(regeln, i) {
  var id = regeln.plots[i].id;
  if (id.indexOf('field-') === 0) return 'Feld ' + id.slice(6);
  if (id.indexOf('coop-') === 0) return 'Hühnerstall';
  if (id.indexOf('pasture-') === 0) return 'Kuhweide';
  if (id.indexOf('apple-tree') === 0) return 'Apfelbaum';
  return nameOf(id);
}

// Liegt ein Hindernis in noch gesperrtem Land des fremden Hofs? Dann nicht
// zeichnen — sonst wirkt der Besuch mit dem vielen Bewuchs überladen.
function fremdVerborgen(regeln, h, expandiert) {
  var exps = regeln.expansions || [];
  for (var k = 0; k < exps.length; k++) {
    var e = exps[k];
    if (expandiert.indexOf(e.id) >= 0) continue;
    if (h.gx < e.gx + e.w && e.gx < h.gx + h.w && h.gy < e.gy + e.h && e.gy < h.gy + h.h) return true;
  }
  return false;
}

function zeichneFremdeHindernisse(d, regeln) {
  var box = $('besuch-hindernisse');
  box.textContent = '';
  if (!regeln.grid || !regeln.obstacles) return;

  var geraeumt = d.clearedObstacles || [];
  var expandiert = d.expandiert || [];
  regeln.obstacles.forEach(function (h, index) {
    if (geraeumt.indexOf(index) >= 0) return;
    if (fremdVerborgen(regeln, h, expandiert)) return;
    var kasten = hindernisKasten({ gx: h.gx, gy: h.gy, w: h.w, h: h.h, kind: h.kind });
    var ding = document.createElement('div');
    ding.className = 'moebel hindernis';
    ding.style.left = kasten.left + '%';
    ding.style.top = kasten.top + '%';
    ding.style.width = kasten.width + '%';
    ding.style.height = kasten.height + '%';
    ding.style.zIndex = String(1 + Math.round(kasten.tiefe * 2));
    ding.innerHTML =
      '<svg class="art" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">' +
      (h.kind === 'tree' ? artBaum() : h.kind === 'rock' ? artStein() : artTuempel()) + '</svg>';
    box.appendChild(ding);
  });
}

function zeichneFremdenStandKnopf(d) {
  var knopf = $('besuch-stand-knopf');
  var offen = d.stand.filter(function (o) { return o.verkauft <= 0; });
  moebel(knopf, artStand(), 'Sein Stand', offen.length);
  knopf.disabled = offen.length === 0;
  knopf.onclick = function () {
    zeichneFremdenStand(besuchDaten);
    show('fremdstand');
  };
}

function zeichneBesuchKopf(d) {
  var box = $('besuch-kopf');
  box.textContent = '';

  var offen = Math.max(0, d.proTag - d.heute);
  var leiste = document.createElement('div');
  leiste.className = 'besuch-leiste';

  var body = document.createElement('div');
  body.className = 'body';
  body.innerHTML =
    '<div class="top">' + d.name + '</div>' +
    '<div class="sub">' + d.code + ' · ' + (offen > 0
      ? 'tippe auf etwas, das gerade läuft'
      : 'heute schon dreimal geholfen') + '</div>';
  leiste.appendChild(body);

  var punkte = document.createElement('div');
  punkte.className = 'hilfen';
  punkte.setAttribute('aria-label', offen + ' von ' + d.proTag + ' Hilfen offen');
  for (var i = 0; i < d.proTag; i++) {
    var p = document.createElement('i');
    if (i >= offen) p.className = 'weg';
    punkte.appendChild(p);
  }
  leiste.appendChild(punkte);

  var merken = document.createElement('button');
  merken.type = 'button';
  if (d.stand === 'freund') merken.className = 'an';
  merken.textContent = d.stand === 'freund' ? 'Nachbar'
    : d.stand === 'gefragt' ? 'gefragt'
    : d.stand === 'wartet' ? 'Annehmen'
    : 'Anfragen';
  merken.addEventListener('click', function () {
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
  });
  leiste.appendChild(merken);

  box.appendChild(leiste);
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
      zeichneBesuch();
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

  var frei = d.stand.filter(function (o) { return o.verkauft <= 0; });
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
      var item = rules.recipes[i].output.item;
      gaben.push(gabeZeile(itemName(item), '', itemIcon(item)));
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
