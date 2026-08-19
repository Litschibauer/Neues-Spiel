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
    zeichneFreunde(d.freunde);
    return d.freunde;
  }).catch(function () {
    $('freundeliste').innerHTML = '<p class="empty">Nachbarn brauchen Verbindung.</p>';
  });
}

function zeichneFreunde(liste) {
  var box = $('freundeliste');
  box.textContent = '';
  if (!liste || liste.length === 0) {
    box.innerHTML = '<p class="empty">Noch keine Nachbarn. Frag jemanden nach seinem Code.</p>';
    return;
  }

  liste.forEach(function (h) {
    var karte = document.createElement('button');
    karte.className = 'card';
    karte.dataset.hof = h.code;
    var offen = Math.max(0, h.proTag - h.heute);
    karte.innerHTML =
      '<div class="body"><div class="top">' + h.name + '</div>' +
      '<div class="sub">' + h.code + ' · ' +
      (offen > 0 ? offen + '× helfen möglich' : 'heute schon geholfen') + '</div></div>' +
      '<span class="go">Besuchen</span>';
    karte.addEventListener('click', function () { besuche(h.code); });
    box.appendChild(karte);
  });
}

function freundHinzu() {
  var code = ($('freundcode').value || '').trim().toUpperCase();
  if (code.length < 4) { toast('Der Code hat sechs Zeichen', true); return; }
  api('/api/freunde?code=' + encodeURIComponent(code), { method: 'POST' })
    .then(function (d) {
      $('freundcode').value = '';
      toast(d.hof.name + ' ist jetzt Nachbar');
      klang('stufe');
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
      zeichneBesuch();
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
  zeichneFremdenStand(d);
}

function zeichneFremdeFarm(d) {
  var box = $('besuch-plots');
  box.textContent = '';
  var szene = $('besuch-scene');
  if (szene.dataset.stand !== 'gemalt') {
    szene.innerHTML = artBoden(false);
    szene.dataset.stand = 'gemalt';
  }

  var regeln = fremdeRegeln();
  var jetzt = fremdeUhr();

  var sichtbar = [];
  d.plots.forEach(function (p, i) {
    if (p.level <= 0 || p.gx < 0) return;
    sichtbar.push({ index: i, p: p });
  });

  sichtbar.forEach(function (eintrag) {
    var i = eintrag.index;
    var p = eintrag.p;
    var groesse = NS.sizeOf(regeln, i);
    var ort = fremdKasten(regeln, p, groesse);

    var laeuft = null;
    var fertig = 0;
    p.slots.forEach(function (s, j) {
      if (s.recipe < 0) return;
      var dauer = regeln.recipes[s.recipe].durationTicks;
      var rest = dauer - (jetzt - s.startedAt);
      if (rest <= 0) { fertig++; return; }
      if (!laeuft || rest < laeuft.rest) laeuft = { slot: j, rest: rest, dauer: dauer };
    });

    var kachel = document.createElement('button');
    kachel.className = 'plot' + (fertig > 0 ? ' ripe' : '');
    kachel.dataset.platz = String(i);
    kachel.style.left = ort.left + '%';
    kachel.style.top = ort.top + '%';
    kachel.style.width = ort.width + '%';
    kachel.style.height = ort.height + '%';
    kachel.style.zIndex = String(1 + Math.round(ort.tiefe * 2));
    kachel.disabled = !laeuft || d.heute >= d.proTag;

    kachel.innerHTML =
      '<svg class="art" viewBox="0 0 100 80" preserveAspectRatio="none" aria-hidden="true">' +
      fremdeKunst(regeln, i, p, laeuft, fertig) + '</svg>';

    if (laeuft) {
      var bar = document.createElement('div');
      bar.className = 'bar';
      var fill = document.createElement('i');
      fill.style.width = Math.round((1 - laeuft.rest / laeuft.dauer) * 100) + '%';
      bar.appendChild(fill);
      kachel.appendChild(bar);
    }

    var name = regeln.plots[i].id;
    kachel.setAttribute(
      'aria-label',
      name + (laeuft ? ' — noch ' + timeText(laeuft.rest) : ' — nichts zu tun'),
    );
    if (laeuft) {
      kachel.addEventListener('click', function () { hilf(i, laeuft.slot); });
    }
    box.appendChild(kachel);
  });

  if (sichtbar.length === 0) {
    box.innerHTML = '<p class="empty">Auf diesem Hof steht noch nichts.</p>';
  }
}

function fremdKasten(regeln, p, groesse) {
  var raster = regeln.grid;
  if (!raster) return { left: 40, top: 40, width: 18, height: 16, tiefe: 0.5 };
  return feldKasten(p.gx, p.gy, groesse.w, groesse.h);
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
  merken.textContent = d.freund ? 'Nachbar entfernen' : 'Als Nachbar merken';
  merken.addEventListener('click', function () {
    var weg = d.freund;
    api('/api/freunde?code=' + encodeURIComponent(d.code), { method: weg ? 'DELETE' : 'POST' })
      .then(function () {
        toast(weg ? 'Nachbar entfernt' : 'Nachbar gemerkt');
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

  var titel = document.createElement('h2');
  titel.textContent = 'Sein Verkaufsstand';
  box.appendChild(titel);

  var meine = NS.farmView(client.preview(), rules, marktLive());
  var kaufbar = {};
  meine.offers.forEach(function (o) { kaufbar[o.item + ':' + o.amount + ':' + o.price] = o; });

  var frei = d.stand.filter(function (o) { return o.verkauft <= 0; });
  if (frei.length === 0) {
    box.innerHTML += '<p class="empty">Der Stand ist leer.</p>';
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
