// Das Dorfprojekt: Alle Höfe des Servers bauen zusammen an einem Bauwerk.
// Der Stand kommt vom Server. Waren gehen als Beitrag an die Baustelle und
// verlassen den Hof wie ein Geschenk — der Server bucht ab, der nächste
// Abgleich zieht es nach. Ohne Netz sieht man den zuletzt geholten Stand.

var dorfStand = null;

function dorfSchluessel() {
  return 'ns-dorf-' + (eigenerHof && eigenerHof.code ? eigenerHof.code : 'x');
}

function dorfMarke(d) {
  return d.nr + ':' + d.etappe + ':' + (d.fertig ? 1 : 0);
}

function dorfLaden() {
  if (!token || !netzOk()) return Promise.resolve(null);
  return api('/api/dorf').then(function (d) {
    dorfStand = d;
    dorfMomente(d);
    dorfAnzeigen();
    return d;
  }).catch(function () { return null; });
}

// Momente: eine Etappe wurde fertig, das Bauwerk steht, ein neues beginnt.
// Verglichen wird mit dem Stand, den dieses Gerät zuletzt gesehen hat.
function dorfMomente(neu) {
  var marke = dorfMarke(neu);
  var gesehen = null;
  try { gesehen = localStorage.getItem(dorfSchluessel()); } catch (e) {}
  try { localStorage.setItem(dorfSchluessel(), marke); } catch (e) {}
  if (!gesehen || gesehen === marke || typeof moment !== 'function') return;
  var teile = gesehen.split(':');
  var altNr = Number(teile[0]);
  var altEtappe = Number(teile[1]);
  var altFertig = teile[2] === '1';
  if (neu.fertig && !(altNr === neu.nr && altFertig)) {
    moment({ klang: 'stufe', hin: 'dorf', eilig: true, text: 'Das Dorf hat gebaut: ' + neu.projekt.name + ' steht!' });
  } else if (neu.nr !== altNr) {
    moment({ klang: 'zettel', hin: 'dorf', text: 'Neues Dorfprojekt: ' + neu.projekt.name });
  } else if (neu.etappe > altEtappe && neu.etappen[altEtappe]) {
    moment({ klang: 'erfolg', hin: 'dorf', text: neu.projekt.name + ' · ' + neu.etappen[altEtappe].name + ' fertig' });
  }
}

function dorfProzent(d) {
  var soll = 0, ist = 0;
  d.etappen.forEach(function (e) {
    e.bedarf.forEach(function (b) { soll += b.menge; ist += b.geliefert; });
  });
  return soll > 0 ? Math.floor((ist * 100) / soll) : 0;
}

function dorfDatum(ms) {
  try { return new Date(ms).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }); } catch (e) { return ''; }
}

// Die Karte in den Einstellungen: eine Zeile, was gerade gebaut wird.
function dorfAnzeigen() {
  var sub = $('dorf-sub');
  var zahl = $('dorf-zahl');
  if (!sub || !zahl) return;
  if (!dorfStand) {
    sub.textContent = 'Alle Höfe bauen zusammen';
    zahl.textContent = '▶';
  } else if (dorfStand.fertig) {
    sub.textContent = dorfStand.projekt.name + ' steht · Dankeswoche';
    zahl.textContent = '✓';
  } else {
    sub.textContent = dorfStand.projekt.name + ' · Etappe ' + (dorfStand.etappe + 1) + ' von ' + dorfStand.etappen.length;
    zahl.textContent = dorfProzent(dorfStand) + ' %';
  }
  if (view === 'dorf') renderDorf();
}

function dorfKnopf(text, an, tu) {
  var k = document.createElement('button');
  k.type = 'button';
  k.className = 'go';
  k.textContent = text;
  k.disabled = !an;
  k.addEventListener('click', tu);
  return k;
}

function renderDorf() {
  var box = $('dorf-liste');
  if (!box) return;
  box.textContent = '';
  var d = dorfStand;
  if (!d) {
    box.innerHTML = '<p class="empty">' + (netzOk() ? 'Der Stand kommt gleich …' : 'Ohne Netz kein Blick ins Dorf.') + '</p>';
    return;
  }

  var kopf = document.createElement('div');
  kopf.className = 'card dorf-kopf';
  kopf.innerHTML =
    '<div class="dorf-bild">' + dorfBild(d) + '</div>' +
    '<div class="dorf-name">' + d.projekt.name + '</div>' +
    '<p class="dorf-text">' + d.projekt.text + '</p>' +
    '<span class="balken"><i style="width:' + dorfProzent(d) + '%"></i></span>' +
    '<div class="dorf-etappen">' +
    d.etappen.map(function (e, i) {
      var art = e.fertig ? ' fertig' : (i === d.etappe && !d.fertig) ? ' jetzt' : '';
      return '<span class="dorf-etappe' + art + '">' + (i + 1) + ' · ' + e.name + '</span>';
    }).join('') +
    '</div>';
  box.appendChild(kopf);

  if (d.fertig) {
    var dank = document.createElement('div');
    dank.className = 'note dorf-dank';
    dank.textContent = d.projekt.name + ' steht! Dankeswoche bis ' + dorfDatum(d.dankeswocheBis) +
      ': Tagesbonus doppelt für alle.' + (d.mein > 0 ? ' Dein Dank liegt im Postfach.' : '') +
      ' Danach beginnt das nächste Projekt.';
    box.appendChild(dank);
  } else {
    var etappe = d.etappen[d.etappe];
    var titel = document.createElement('div');
    titel.className = 'ziel-gruppe';
    titel.innerHTML = '<span>Bauzettel · ' + etappe.name + '</span>';
    box.appendChild(titel);

    var zettel = document.createElement('div');
    zettel.className = 'card dorf-zettel';
    etappe.bedarf.forEach(function (b) {
      var idx = -1;
      for (var i = 0; i < rules.items.length; i++) if (rules.items[i].id === b.item) { idx = i; break; }
      var habe = idx >= 0 && client ? (client.preview().items[idx] || 0) : 0;
      var fehlt = b.menge - b.geliefert;
      var zeile = document.createElement('div');
      zeile.className = 'dorf-zeile' + (fehlt <= 0 ? ' voll' : '');
      zeile.innerHTML =
        '<span class="dorf-ware">' + iconTag(b.item) + '<span>' + nameOf(b.item) + '</span></span>' +
        '<span class="dorf-stand">' + b.geliefert + ' / ' + b.menge + '</span>' +
        '<span class="balken"><i style="width:' + Math.floor((b.geliefert * 100) / b.menge) + '%"></i></span>' +
        '<span class="dorf-habe">' + (fehlt <= 0 ? 'voll' : 'du hast ' + habe) + '</span>';
      if (fehlt > 0) {
        var knoepfe = document.createElement('span');
        knoepfe.className = 'dorf-knoepfe';
        var netz = netzOk();
        knoepfe.appendChild(dorfKnopf('+1', netz && habe >= 1, function () { dorfGeben(b.item, 1, this); }));
        knoepfe.appendChild(dorfKnopf('+5', netz && habe >= 5 && fehlt >= 5, function () { dorfGeben(b.item, 5, this); }));
        knoepfe.appendChild(dorfKnopf('Alles', netz && habe >= 1, function () { dorfGeben(b.item, Math.min(habe, fehlt), this); }));
        zeile.appendChild(knoepfe);
      }
      zettel.appendChild(zeile);
    });
    box.appendChild(zettel);
  }

  var ht = document.createElement('div');
  ht.className = 'ziel-gruppe';
  ht.innerHTML = '<span>Helfer</span><span class="ziel-gruppe-zahl">' + d.helfer.length + '</span>';
  box.appendChild(ht);
  var helfer = document.createElement('div');
  helfer.className = 'card dorf-helfer';
  if (d.helfer.length === 0) {
    helfer.innerHTML = '<p class="leer">Noch hat niemand etwas gebracht. Mach den Anfang.</p>';
  }
  d.helfer.forEach(function (h, i) {
    var zeile = document.createElement('div');
    zeile.className = 'zeile' + (h.du ? ' du' : '');
    var platz = document.createElement('span'); platz.className = 'platz'; platz.textContent = (i + 1) + '.';
    var name = document.createElement('span'); name.className = 'name'; name.textContent = h.du ? 'Du' : h.name;
    var wert = document.createElement('span'); wert.className = 'wert'; wert.textContent = h.menge + ' Stück';
    zeile.appendChild(platz); zeile.appendChild(name); zeile.appendChild(wert);
    helfer.appendChild(zeile);
  });
  box.appendChild(helfer);
  var mein = document.createElement('p');
  mein.className = 'tiny dorf-mein';
  mein.textContent = d.mein > 0
    ? 'Du hast ' + d.mein + ' Stück beigetragen.'
    : 'Bring, was du entbehren kannst — jedes Stück zählt.';
  box.appendChild(mein);
}

function dorfGeben(item, menge, knopf) {
  if (!netzOk()) { toast('Ohne Netz geht das nicht', true); return; }
  if (!(menge > 0)) return;
  if (knopf) knopf.disabled = true;
  api('/api/dorf/beitrag?item=' + encodeURIComponent(item) + '&amount=' + menge, { method: 'POST' })
    .then(function (r) {
      dorfStand = r.stand;
      try { localStorage.setItem(dorfSchluessel(), dorfMarke(r.stand)); } catch (e) {}
      klang(r.projektFertig ? 'stufe' : r.etappeFertig ? 'erfolg' : 'bestaetigt');
      toast(r.projektFertig
        ? r.stand.projekt.name + ' steht! Dein Dank kommt mit der Post'
        : r.etappeFertig
          ? 'Etappe fertig — das Dorf baut weiter'
          : r.angenommen + ' ' + stueckName(r.angenommen, dorfItemIndex(item)) + ' an die Baustelle');
      dorfAnzeigen();
      // Der Server hat abgebucht; der Abgleich zieht es auf dem Gerät nach —
      // erst danach stimmt „du hast" wieder.
      var zusage = attempt(true);
      if (zusage && zusage.then) zusage.then(dorfAnzeigen, dorfAnzeigen);
    })
    .catch(function (e) {
      var code = (e && e.message) || '';
      toast(/409/.test(code) ? 'Das braucht die Baustelle gerade nicht' : 'Ging nicht — später nochmal', true);
      dorfLaden();
    });
}

function dorfItemIndex(id) {
  for (var i = 0; i < rules.items.length; i++) if (rules.items[i].id === id) return i;
  return 0;
}

// Das Bild der Baustelle: je Etappe wächst etwas dazu. Pixelkunst aus
// Rechtecken, damit es zu den Sprites passt und keine Datei braucht.
function dorfBild(d) {
  var stufe = d.fertig ? d.etappen.length : d.etappe;
  var r = function (x, y, w, h, f) { return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + f + '"/>'; };
  var holz = '#8d5a35', dunkel = '#6b4326', stein = '#9c9a94', steinD = '#6f6d68', dach = '#b5473a', dachD = '#8a3128', gras = '#7bbf5a', erde = '#a0764c', eisen = '#5a6470', wasser = '#4a90c2';
  var teile = [r(0, 34, 64, 6, gras)];
  // Schild „Baustelle" — solange nichts steht.
  if (stufe === 0) {
    teile.push(r(28, 20, 2, 14, dunkel), r(22, 14, 14, 8, holz), r(23, 15, 12, 6, '#f4ecd8'));
  }
  if (d.projekt.id === 'brunnen') {
    if (stufe >= 1) teile.push(r(24, 28, 16, 6, steinD), r(26, 30, 12, 4, wasser));
    if (stufe >= 2) teile.push(r(22, 24, 20, 6, stein), r(22, 24, 20, 1, '#c9c7c0'), r(20, 29, 24, 2, steinD));
    if (stufe >= 3) teile.push(r(23, 8, 2, 16, dunkel), r(39, 8, 2, 16, dunkel), r(18, 4, 28, 5, dach), r(20, 2, 24, 3, dachD), r(30, 12, 4, 3, holz), r(31, 15, 2, 9, '#e2d5b5'));
  } else if (d.projekt.id === 'bruecke') {
    teile.push(r(0, 30, 64, 4, wasser));
    if (stufe >= 1) teile.push(r(14, 22, 4, 12, dunkel), r(30, 22, 4, 12, dunkel), r(46, 22, 4, 12, dunkel));
    if (stufe >= 2) teile.push(r(6, 20, 52, 4, holz), r(6, 20, 52, 1, '#a8714a'));
    if (stufe >= 3) { for (var x = 8; x < 58; x += 8) teile.push(r(x, 12, 2, 8, dunkel)); teile.push(r(6, 12, 52, 2, holz)); }
  } else {
    if (stufe >= 1) teile.push(r(0, 30, 64, 4, erde), r(0, 31, 64, 1, eisen), r(0, 33, 64, 1, eisen));
    if (stufe >= 2) teile.push(r(8, 24, 48, 6, stein), r(8, 24, 48, 1, '#c9c7c0'));
    if (stufe >= 3) teile.push(r(18, 12, 28, 12, holz), r(20, 14, 6, 6, '#f4ecd8'), r(38, 14, 6, 6, '#f4ecd8'), r(29, 16, 6, 8, dunkel), r(14, 8, 36, 5, dach), r(16, 6, 32, 3, dachD));
  }
  return '<svg viewBox="0 0 64 40" shape-rendering="crispEdges" aria-hidden="true">' + teile.join('') + '</svg>';
}
