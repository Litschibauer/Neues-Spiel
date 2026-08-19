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
  karte.className = 'card trade';
  karte.innerHTML =
    '<div class="head"><span class="name">Dein Hof</span>' +
    '<span class="have">Code ' + eigenerHof.code + '</span></div>';

  var reihe = document.createElement('div');
  reihe.className = 'pick';
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

  var hinweis = document.createElement('div');
  hinweis.className = 'note';
  hinweis.textContent = 'Gib den Code weiter, dann kann dich jemand besuchen.';
  karte.appendChild(hinweis);

  box.appendChild(karte);
}

function freundeLaden() {
  return api('/api/freunde').then(function (d) {
    zeichneFreunde(d);
    return d;
  }).catch(function () {
    $('freundeliste').innerHTML = '<p class="empty">Nachbarn brauchen Verbindung.</p>';
  });
}

function hofZeile(h, art) {
  var karte = document.createElement('div');
  karte.className = 'card';
  karte.dataset.hof = h.code;

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
  karte.appendChild(knopf);

  if (art !== 'freund') {
    var weg = document.createElement('button');
    weg.type = 'button';
    weg.className = 'go weg';
    weg.textContent = art === 'anfrage' ? 'Nein' : 'Zurückziehen';
    weg.addEventListener('click', function () {
      api('/api/freunde?code=' + encodeURIComponent(h.code), { method: 'DELETE' })
        .then(function () { freundeLaden(); })
        .catch(function () { toast('Ging nicht', true); });
    });
    karte.appendChild(weg);
  }

  return karte;
}

function zeichneFreunde(d) {
  var box = $('freundeliste');
  box.textContent = '';

  (d.anfragen || []).forEach(function (h) { box.appendChild(hofZeile(h, 'anfrage')); });
  (d.freunde || []).forEach(function (h) { box.appendChild(hofZeile(h, 'freund')); });
  (d.gefragt || []).forEach(function (h) { box.appendChild(hofZeile(h, 'gefragt')); });

  if (box.children.length === 0) {
    box.innerHTML = '<p class="empty">Noch keine Nachbarn. Frag jemanden nach seinem Code.</p>';
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

    var meta = document.createElement('div');
    meta.className = 'meta';
    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = fremdName(regeln, i);
    var status = document.createElement('div');
    status.className = 'status';
    status.textContent = laeuft
      ? (helfbar ? 'noch ' + timeText(laeuft.rest) + ' · helfen' : 'noch ' + timeText(laeuft.rest))
      : fertig > 0 ? 'fertig' : 'nichts zu tun';
    meta.appendChild(name);
    meta.appendChild(status);
    kachel.appendChild(meta);

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
  if (id === 'mill') return 'Mühle';
  if (id === 'dairy') return 'Molkerei';
  return id;
}

function zeichneFremdeHindernisse(d, regeln) {
  var box = $('besuch-hindernisse');
  box.textContent = '';
  if (!regeln.grid || !regeln.obstacles) return;

  var geraeumt = d.clearedObstacles || [];
  regeln.obstacles.forEach(function (h, index) {
    if (geraeumt.indexOf(index) >= 0) return;
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
  var karte = document.createElement('div');
  karte.className = 'card trade';
  karte.innerHTML =
    '<div class="head"><span class="name">' + d.name + '</span>' +
    '<span class="have">' + d.code + '</span></div>' +
    '<div class="note">' + (offen > 0
      ? 'Tippe auf etwas, das gerade läuft — ' + offen + '× heute möglich.'
      : 'Heute hast du hier schon dreimal geholfen. Morgen wieder.') + '</div>';

  var reihe = document.createElement('div');
  reihe.className = 'preisknoepfe';
  var merken = document.createElement('button');
  merken.type = 'button';
  merken.textContent = d.stand === 'freund' ? 'Nachbarschaft beenden'
    : d.stand === 'gefragt' ? 'Anfrage zurückziehen'
    : d.stand === 'wartet' ? 'Nachbarschaft annehmen'
    : 'Als Nachbar anfragen';
  merken.addEventListener('click', function () {
    var weg = d.stand === 'freund' || d.stand === 'gefragt';
    api('/api/freunde?code=' + encodeURIComponent(d.code), { method: weg ? 'DELETE' : 'POST' })
      .then(function (a) {
        toast(weg ? 'Erledigt'
          : a && a.stand === 'freund' ? 'Ihr seid jetzt Nachbarn'
          : 'Anfrage geschickt — er muss zustimmen');
        besuchHolen();
        freundeLaden();
      })
      .catch(function () { toast('Ging nicht', true); });
  });
  reihe.appendChild(merken);
  karte.appendChild(reihe);
  box.appendChild(karte);
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
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'kaestchen voll fremd';
    b.dataset.ware = rules.items[o.item] ? rules.items[o.item].id : String(o.item);
    b.disabled = !angebot || !marktLive() || !angebot.affordable || !angebot.fits;
    b.innerHTML = itemIcon(o.item, 'gross') +
      '<span class="n">' + o.amount + '×</span>' +
      '<span class="p">' + o.amount * o.price + itemIcon(rules.currency) + '</span>' +
      '<span class="rest">' + (!angebot ? 'gleich verfügbar'
        : !angebot.fits ? 'kein Platz'
        : !angebot.affordable ? 'zu teuer'
        : o.price + ' je Stück') + '</span>';
    b.addEventListener('click', function () {
      if (!angebot || !marktLive()) return;
      var res = client.buyOffer(angebot.id);
      act('Gekauft · ' + o.amount + ' ' + itemName(o.item), res, 'kauf');
      if (res.ok) { attempt(true); besuchHolen(); }
    });
    raster.appendChild(b);
  });

  box.appendChild(raster);
}
