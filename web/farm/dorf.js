// Das Dorfprojekt: Alle Höfe des Servers bauen zusammen an einem Bauwerk.
// Der Stand kommt vom Server. Waren gehen als Beitrag an die Baustelle und
// verlassen den Hof wie ein Geschenk — der Server bucht ab, der nächste
// Abgleich zieht es nach. Ohne Netz sieht man den zuletzt geholten Stand.

var dorfStand = null;

function dorfSchluessel() {
  return 'ns-dorf-' + (eigenerHof && eigenerHof.code ? eigenerHof.code : 'x');
}

function dorfMarke(d) {
  return d.nr + ':' + d.etappe + ':' + (d.fertig ? 1 : 0) + ':' + (d.zug ? d.zug.woche + ':' + (d.zug.fertig ? 1 : 0) : '');
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
  var altZugWoche = Number(teile[3] || -1);
  var altZugFertig = teile[4] === '1';
  if (neu.zug && neu.zug.fertig && !(altZugWoche === neu.zug.woche && altZugFertig)) {
    moment({ klang: 'stufe', hin: 'dorf', eilig: true, text: 'Der Zug ist abgefahren — voll beladen. Dank kommt mit der Post' });
  } else if (neu.zug && altZugWoche >= 0 && neu.zug.woche !== altZugWoche) {
    moment({ klang: 'zettel', hin: 'dorf', text: 'Ein neuer Zug steht im Bahnhof' });
  }
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
  } else if (dorfStand.zug && !dorfStand.zug.fertig) {
    var voll = dorfStand.zug.bestellung.filter(function (b) { return b.geliefert >= b.menge; }).length;
    sub.textContent = 'Der Zug wartet · ' + voll + ' von ' + dorfStand.zug.bestellung.length + ' Waren voll';
    zahl.textContent = '🚂';
  } else if (dorfStand.zug && dorfStand.zug.fertig) {
    sub.textContent = 'Der Zug ist abgefahren · Montag kommt der nächste';
    zahl.textContent = '✓';
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

// Ein Zettel mit Waren: je Zeile Bild, Stand, Balken, und Knöpfe zum Geben.
function dorfZettel(bedarf, geben) {
  var zettel = document.createElement('div');
  zettel.className = 'card dorf-zettel';
  bedarf.forEach(function (b) {
    var idx = dorfItemIndex(b.item, true);
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
      knoepfe.appendChild(dorfKnopf('+1', netz && habe >= 1, function () { geben(b.item, 1, this); }));
      knoepfe.appendChild(dorfKnopf('+5', netz && habe >= 5 && fehlt >= 5, function () { geben(b.item, 5, this); }));
      knoepfe.appendChild(dorfKnopf('Alles', netz && habe >= 1, function () { geben(b.item, Math.min(habe, fehlt), this); }));
      zeile.appendChild(knoepfe);
    }
    zettel.appendChild(zeile);
  });
  return zettel;
}

function dorfHelferListe(box, helfer, mein, leerText) {
  var ht = document.createElement('div');
  ht.className = 'ziel-gruppe';
  ht.innerHTML = '<span>Helfer</span><span class="ziel-gruppe-zahl">' + helfer.length + '</span>';
  box.appendChild(ht);
  var liste = document.createElement('div');
  liste.className = 'card dorf-helfer';
  if (helfer.length === 0) liste.innerHTML = '<p class="leer">' + leerText + '</p>';
  helfer.forEach(function (h, i) {
    var zeile = document.createElement('div');
    zeile.className = 'zeile' + (h.du ? ' du' : '');
    var platz = document.createElement('span'); platz.className = 'platz'; platz.textContent = (i + 1) + '.';
    var name = document.createElement('span'); name.className = 'name'; name.textContent = h.du ? 'Du' : h.name;
    var wert = document.createElement('span'); wert.className = 'wert'; wert.textContent = h.menge + ' Stück';
    zeile.appendChild(platz); zeile.appendChild(name); zeile.appendChild(wert);
    liste.appendChild(zeile);
  });
  box.appendChild(liste);
  var m = document.createElement('p');
  m.className = 'tiny dorf-mein';
  m.textContent = mein > 0 ? 'Du hast ' + mein + ' Stück beigetragen.' : 'Bring, was du entbehren kannst — jedes Stück zählt.';
  box.appendChild(m);
}

function dorfRestText(ms) {
  var s = Math.max(0, Math.floor(ms / 1000));
  var t = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (t > 0) return t + (t === 1 ? ' Tag ' : ' Tage ') + h + ' Std';
  if (h > 0) return h + ' Std ' + m + ' Min';
  return m + ' Min';
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

  // Der Zug: steht der Bahnhof, ist er das Wochenprojekt des ganzen Dorfs.
  if (d.zug) {
    var z = d.zug;
    var zt = document.createElement('div');
    zt.className = 'ziel-gruppe';
    zt.innerHTML = '<span>Der Zug</span><span class="ziel-gruppe-zahl">' +
      (z.fertig ? 'abgefahren' : 'fährt in ' + dorfRestText(z.abfahrtMs - Date.now())) + '</span>';
    box.appendChild(zt);
    if (z.fertig) {
      var ab = document.createElement('div');
      ab.className = 'note dorf-dank';
      ab.textContent = 'Voll beladen abgefahren! ' + (z.mein > 0 ? 'Dein Dank liegt im Postfach. ' : '') +
        'Am Montag steht der nächste Zug im Bahnhof.';
      box.appendChild(ab);
    } else {
      var hinweis = document.createElement('p');
      hinweis.className = 'tiny dorf-mein';
      hinweis.textContent = 'Andere Dörfer bestellen. Ist alles eingeladen, fährt er — und jeder Helfer bekommt ' +
        z.dank.map(function (x) { return x.menge + ' ' + (x.item === 'gold' ? 'Gold' : nameOf(x.item)); }).join(', ') + '.';
      box.appendChild(hinweis);
      box.appendChild(dorfZettel(z.bestellung, zugGeben));
    }
    dorfHelferListe(box, z.helfer, z.mein, 'Noch ist nichts eingeladen. Mach den Anfang.');
    return;
  }

  if (d.fertig) {
    var dank = document.createElement('div');
    dank.className = 'note dorf-dank';
    dank.textContent = d.projekt.name + ' steht! Dankeswoche bis ' + dorfDatum(d.dankeswocheBis) +
      ': Tagesbonus doppelt für alle.' + (d.mein > 0 ? ' Dein Dank liegt im Postfach.' : '') +
      (d.alleGebaut ? ' Danach kommt der Zug.' : ' Danach beginnt das nächste Projekt.');
    box.appendChild(dank);
  } else {
    var etappe = d.etappen[d.etappe];
    var titel = document.createElement('div');
    titel.className = 'ziel-gruppe';
    titel.innerHTML = '<span>Bauzettel · ' + etappe.name + '</span>';
    box.appendChild(titel);
    box.appendChild(dorfZettel(etappe.bedarf, dorfGeben));
  }
  dorfHelferListe(box, d.helfer, d.mein, 'Noch hat niemand etwas gebracht. Mach den Anfang.');
}

function dorfGeben(item, menge, knopf) {
  dorfSchicken('/api/dorf/beitrag', item, menge, knopf, function (r) {
    return r.projektFertig
      ? r.stand.projekt.name + ' steht! Dein Dank kommt mit der Post'
      : r.etappeFertig
        ? 'Etappe fertig — das Dorf baut weiter'
        : r.angenommen + ' ' + stueckName(r.angenommen, dorfItemIndex(item)) + ' an die Baustelle';
  });
}

function zugGeben(item, menge, knopf) {
  dorfSchicken('/api/zug/beitrag', item, menge, knopf, function (r) {
    return r.fertig
      ? 'Der Zug ist voll und fährt ab! Dein Dank kommt mit der Post'
      : r.angenommen + ' ' + stueckName(r.angenommen, dorfItemIndex(item)) + ' eingeladen';
  });
}

function dorfSchicken(pfad, item, menge, knopf, meldung) {
  if (!netzOk()) { toast('Ohne Netz geht das nicht', true); return; }
  if (!(menge > 0)) return;
  if (knopf) knopf.disabled = true;
  api(pfad + '?item=' + encodeURIComponent(item) + '&amount=' + menge, { method: 'POST' })
    .then(function (r) {
      dorfStand = r.stand;
      try { localStorage.setItem(dorfSchluessel(), dorfMarke(r.stand)); } catch (e) {}
      klang(r.projektFertig || r.fertig ? 'stufe' : r.etappeFertig ? 'erfolg' : 'bestaetigt');
      toast(meldung(r));
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

function dorfItemIndex(id, sonstMinus) {
  for (var i = 0; i < rules.items.length; i++) if (rules.items[i].id === id) return i;
  return sonstMinus ? -1 : 0;
}

// Das Bild der Baustelle: je Etappe wächst etwas dazu. Pixelkunst aus
// Rechtecken in einem 64×34-Pixel-Raum (vier Kacheln breit), damit dasselbe
// Motiv auf dem Blatt und als Bauwerk auf dem Hof steht. Jedes Teil ist
// [x, y, Breite, Höhe, Farbe]; die Grundlinie liegt bei y = 34.
function dorfTeile(d) {
  var stufe = d.fertig ? d.etappen.length : d.etappe;
  var holz = '#8d5a35', dunkel = '#6b4326', stein = '#9c9a94', steinD = '#6f6d68', dach = '#b5473a', dachD = '#8a3128', erde = '#a0764c', eisen = '#5a6470', wasser = '#4a90c2';
  var teile = [];
  // Schild „Baustelle" — solange nichts steht.
  if (stufe === 0) teile.push([28, 20, 2, 14, dunkel], [22, 14, 14, 8, holz], [23, 15, 12, 6, '#f4ecd8']);
  if (d.projekt.id === 'brunnen') {
    if (stufe >= 1) teile.push([24, 28, 16, 6, steinD], [26, 30, 12, 4, wasser]);
    if (stufe >= 2) teile.push([22, 24, 20, 6, stein], [22, 24, 20, 1, '#c9c7c0'], [20, 29, 24, 2, steinD]);
    if (stufe >= 3) teile.push([23, 8, 2, 16, dunkel], [39, 8, 2, 16, dunkel], [18, 4, 28, 5, dach], [20, 2, 24, 3, dachD], [30, 12, 4, 3, holz], [31, 15, 2, 9, '#e2d5b5']);
  } else if (d.projekt.id === 'bruecke') {
    teile.push([0, 30, 64, 4, wasser]);
    if (stufe >= 1) teile.push([14, 22, 4, 12, dunkel], [30, 22, 4, 12, dunkel], [46, 22, 4, 12, dunkel]);
    if (stufe >= 2) teile.push([6, 20, 52, 4, holz], [6, 20, 52, 1, '#a8714a']);
    if (stufe >= 3) { for (var x = 8; x < 58; x += 8) teile.push([x, 12, 2, 8, dunkel]); teile.push([6, 12, 52, 2, holz]); }
  } else {
    if (stufe >= 1) teile.push([0, 30, 64, 4, erde], [0, 31, 64, 1, eisen], [0, 33, 64, 1, eisen]);
    if (stufe >= 2) teile.push([8, 24, 48, 6, stein], [8, 24, 48, 1, '#c9c7c0']);
    if (stufe >= 3) teile.push([18, 12, 28, 12, holz], [20, 14, 6, 6, '#f4ecd8'], [38, 14, 6, 6, '#f4ecd8'], [29, 16, 6, 8, dunkel], [14, 8, 36, 5, dach], [16, 6, 32, 3, dachD]);
    // Der Zug steht vor dem Bahnhof, solange er beladen wird.
    if (d.zug && !d.zug.fertig) {
      teile.push([4, 22, 26, 9, '#b5473a'], [4, 22, 26, 2, '#8a3128'], [30, 17, 11, 14, dunkel], [33, 19, 5, 5, '#f4ecd8'],
        [35, 12, 3, 5, '#3b2b3c'], [6, 30, 5, 4, '#3b2b3c'], [14, 30, 5, 4, '#3b2b3c'], [22, 30, 5, 4, '#3b2b3c'], [32, 30, 5, 4, '#3b2b3c'],
        [37, 7, 4, 3, '#e2d5b5'], [40, 4, 3, 2, '#e2d5b5']);
    }
  }
  return teile;
}

function dorfRects(teile, px, py, e) {
  return teile.map(function (t) {
    return '<rect x="' + ((px + t[0]) * e) + '" y="' + ((py + t[1]) * e) + '" width="' + (t[2] * e + 0.03) +
      '" height="' + (t[3] * e + 0.03) + '" fill="' + t[4] + '"/>';
  }).join('');
}

function dorfBild(d) {
  return '<svg viewBox="0 0 64 40" shape-rendering="crispEdges" aria-hidden="true">' +
    '<rect x="0" y="34" width="64" height="6" fill="#7bbf5a"/>' + dorfRects(dorfTeile(d), 0, 0, 1) + '</svg>';
}
