function render() {
  if (!client) return;
  client.localTick = tickNow();
  var s = client.preview();
  var v = NS.farmView(s, rules, navigator.onLine);

  renderPurse(v);
  renderPlots(v);
  renderTruck(v);
  renderMoebel(v);
  renderHindernisse(v);
  renderKisten(v);
  renderRequests(v);
  renderMail(v);
  renderMarket(v);
  renderMyOrders(v);

  var typing = document.activeElement
    && document.activeElement.tagName === 'INPUT'
    && $('stand-bg').contains(document.activeElement);
  if (!typing) renderStore(v);
  renderAusbau(v);
  renderHofinfo(v);
  renderBadges(v);
  renderBauliste(v);
  renderSheet(v);
}

function renderPurse(v) {
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
  $('silo-fill').style.width = Math.round((v.silo.used * 100) / v.silo.capacity) + '%';
  $('silo').className = 'silo' + (v.silo.full ? ' full' : '');
}

function plotStatus(p) {
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
    if (n.inputs.length === 0) return 'antippen · +' + n.output.amount + ' ' + itemName(n.output.item);
    return costText(n.inputs) + ' → ' + n.output.amount + ' ' + itemName(n.output.item);
  }
  return 'nichts zu tun';
}

function renderPlots(v) {
  if (ziehen && ziehen.aktiv) return;
  $('hof').classList.toggle('kein-raster', !hatRaster());

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
    var tile = document.createElement('button');
    tile.className = 'plot' + (p.done ? ' ripe' : '') + (p.idle ? ' locked' : '') +
      (p.blocked === 'level' ? ' gated' : '');
    tile.disabled = p.tap === 'none' && !p.busy ? p.blocked !== 'inputs' : false;
    tile.style.left = ort.left + '%';
    tile.style.top = ort.top + '%';
    tile.style.width = ort.width + '%';
    tile.style.height = ort.height + '%';
    tile.style.zIndex = String(1 + Math.round(ort.tiefe * 2));
    tile.setAttribute('aria-label', plotName(p.index) + ' — ' + plotStatus(p));

    var art = document.createElement('div');
    art.innerHTML =
      '<svg class="art" viewBox="0 0 100 80" preserveAspectRatio="none" aria-hidden="true">' +
      artFor(p) + '</svg>';
    tile.appendChild(art.firstChild);

    if (p.done) {
      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = p.capacity > 1
        ? String(p.slots.filter(function (s) { return s.done; }).length)
        : '!';
      tile.appendChild(badge);
    }

    if (p.busy) {
      var bar = document.createElement('div');
      bar.className = 'bar';
      var fill = document.createElement('i');
      fill.style.width = Math.round(p.progress * 100) + '%';
      bar.appendChild(fill);
      tile.appendChild(bar);
    }

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

    if (p.upgrade && !p.idle) {
      var up = document.createElement('button');
      up.className = 'upgrade';
      up.textContent = p.upgrade.unlocked
        ? '+ ' + p.upgrade.cost.map(function (c) { return c.amount; }).join(' ')
        : '+ Stufe ' + p.upgrade.minPlayerLevel;
      up.setAttribute(
        'aria-label',
        p.upgrade.unlocked
          ? p.upgrade.label + ' kaufen für ' + costText(p.upgrade.cost)
          : p.upgrade.label + ' ab Stufe ' + p.upgrade.minPlayerLevel,
      );
      up.title = up.getAttribute('aria-label');
      up.disabled = !p.upgrade.affordable;
      up.addEventListener('click', function (e) { e.stopPropagation(); tapBuy(p.index); });
      tile.appendChild(up);
    }
  });
}

function renderTruck(v) {
  var knopf = $('wagen');
  var t = v.truck;
  if (!t.enabled) { knopf.hidden = true; return; }

  knopf.hidden = false;
  knopf.className = 'moebel wagen' + (t.here ? '' : ' unterwegs');
  knopf.innerHTML =
    '<svg class="art" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">' +
    artTruck(!t.here, false) + '</svg>';
  knopf.setAttribute('aria-label', t.here ? 'Lieferwagen wartet' : 'Lieferwagen unterwegs');
}

function renderMoebel(v) {
  var bereit = v.truck.board.filter(function (z) { return z.deliverable; }).length;
  moebel($('brett'), artBrett(v.truck.board.length), 'Brett', bereit);
  moebel($('lagerhaus'), artLager(v.silo.full), 'Lager',
    v.mail.entries.length + (v.silo.upgrade && v.silo.upgrade.affordable ? 1 : 0));
  moebel($('stand'), artStand(), 'Stand', v.buyable);

  var offen = v.chests.filter(function (k) { return k.ready; });
  var kiste = $('kiste');
  var ohneOrt = offen.filter(function (k) { return k.gx < 0 || !hatRaster(); });
  kiste.hidden = ohneOrt.length === 0;
  if (ohneOrt.length > 0) moebel(kiste, artKiste(), 'Kiste', ohneOrt.length);
}

function renderHindernisse(v) {
  var box = $('hindernisse');
  box.textContent = '';
  if (!hatRaster()) return;

  v.obstacles.forEach(function (h) {
    var kasten = hindernisKasten(h);
    var knopf = document.createElement('button');
    knopf.className = 'moebel hindernis' + (h.removable ? ' raeumbar' : '');
    knopf.style.left = kasten.left + '%';
    knopf.style.top = kasten.top + '%';
    knopf.style.width = kasten.width + '%';
    knopf.style.height = kasten.height + '%';
    knopf.style.zIndex = String(1 + Math.round(kasten.tiefe * 2));
    knopf.innerHTML =
      '<svg class="art" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">' +
      (h.kind === 'tree' ? artBaum() : h.kind === 'rock' ? artStein() : artTuempel()) + '</svg>' +
      (h.removable ? '<span class="badge">✓</span>' : '');
    knopf.setAttribute('aria-label', hindernisName(h.kind));
    knopf.addEventListener('click', function () { tippeHindernis(h); });
    box.appendChild(knopf);
  });
}

function renderKisten(v) {
  var box = $('kisten');
  box.textContent = '';
  if (!hatRaster()) return;

  v.chests.forEach(function (k) {
    if (!k.ready || k.gx < 0) return;
    var kasten = plotKasten(-1, { gx: k.gx, gy: k.gy });
    var knopf = document.createElement('button');
    knopf.className = 'moebel schatz';
    knopf.style.left = kasten.left + '%';
    knopf.style.top = kasten.top + '%';
    knopf.style.width = kasten.width + '%';
    knopf.style.height = kasten.height + '%';
    knopf.style.zIndex = String(40 + Math.round(kasten.tiefe * 2));
    knopf.innerHTML =
      '<svg class="art" viewBox="0 0 100 80" preserveAspectRatio="none" aria-hidden="true">' +
      artKiste() + '</svg>';
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
    '<div class="sub">' + stacksMitBild(v.silo.upgrade.cost) + '</div></div>' +
    '<span class="go">Bauen</span>';
  karte.addEventListener('click', function () {
    act('Lager ausgebaut · ' + v.silo.upgrade.capacity + ' Platz', client.upgradeSilo());
  });
  box.appendChild(karte);
}

function moebel(knopf, bild, name, zahl) {
  knopf.innerHTML =
    '<svg class="art" viewBox="0 0 100 80" preserveAspectRatio="none" aria-hidden="true">' +
    bild + '</svg>' +
    '<span class="meta">' + name + '</span>' +
    (zahl > 0 ? '<span class="badge">' + zahl + '</span>' : '');
  knopf.setAttribute('aria-label', name + (zahl > 0 ? ' — ' + zahl + ' offen' : ''));
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
      act('Abgeschickt nach ' + z.dest + ' · ' + stacks(z.reward), client.sendSlip(z.slot));
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
  card.addEventListener('click', function () { act('Postfach geleert', client.collectMail()); });
  box.appendChild(card);
}

function renderMarket(v) {
  var box = $('market-list');
  var online = navigator.onLine;
  box.textContent = '';
  box.className = online ? '' : 'no-net';
  $('market-note').hidden = online;

  if (v.offers.length === 0) {
    box.innerHTML = '<p class="empty">' + (online
      ? 'Gerade bietet niemand etwas an. Stell selbst etwas ein — unter Lager.'
      : 'Keine Angebote auf dem Gerät. Der Markt kommt mit dem nächsten Sync.') + '</p>';
    return;
  }

  v.offers.forEach(function (o) {
    var card = document.createElement('button');
    card.className = 'card';
    card.disabled = !online || !o.affordable || !o.fits;

    var body = document.createElement('div');
    body.className = 'body';
    var top = document.createElement('div');
    top.className = 'top';
    top.textContent = o.amount + ' ' + itemName(o.item);
    var sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = !o.fits ? 'kein Platz im Lager'
      : !o.affordable ? 'zu teuer für dich'
      : o.price + ' pro Stück';
    body.appendChild(top); body.appendChild(sub);

    var go = document.createElement('span');
    go.className = 'go';
    go.textContent = o.total + ' ' + itemName(rules.currency);

    card.appendChild(body); card.appendChild(go);
    card.addEventListener('click', function () {
      if (!navigator.onLine) return;
      var res = client.buyOffer(o.id);
      act('Gekauft · ' + o.amount + ' ' + itemName(o.item), res);

      if (res.ok) attempt(true);
    });
    box.appendChild(card);
  });
}

function renderMyOrders(v) {
  var box = $('my-orders');
  box.textContent = '';
  if (v.orders.length === 0) {
    box.innerHTML = '<p class="empty">Du bietest nichts an — alle ' +
      v.orderSlotsFree + ' Plätze sind frei. Einstellen geht unter Lager, auch ohne Netz.</p>';
    return;
  }
  v.orders.forEach(function (o) {
    var card = document.createElement('button');
    card.className = 'card';
    var body = document.createElement('div');
    body.className = 'body';
    var top = document.createElement('div');
    top.className = 'top';
    top.textContent = o.amount + ' ' + itemName(o.item) + ' à ' + o.price;
    var sub = document.createElement('div');
    sub.className = 'sub';

    sub.textContent = o.expiresIn === null
      ? 'steht seit ' + timeText(o.listedFor) + ' · läuft nicht ab'
      : 'in ' + timeText(o.expiresIn) + ' zurück ins Postfach';
    body.appendChild(top); body.appendChild(sub);
    var go = document.createElement('span');
    go.className = 'go';
    go.textContent = 'Zurück';
    card.appendChild(body); card.appendChild(go);
    card.addEventListener('click', function () {
      act('Zurückgeholt · ' + o.amount + ' ' + itemName(o.item), client.cancelOrder(o.id));
    });
    box.appendChild(card);
  });
}

var picks = {};

function pickOf(entry) {
  var p = picks[entry.item];
  if (!p) {
    p = { amount: entry.amount, price: entry.bandMax };
    picks[entry.item] = p;
  }
  return p;
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

function renderStore(v) {
  var chips = $('stock');
  chips.textContent = '';
  v.stock.forEach(function (entry) {
    if (entry.item === v.currency.item) return;
    var chip = document.createElement('span');
    chip.className = 'chip';
    if (entry.amount === 0) chip.setAttribute('disabled', '');
    chip.innerHTML = iconTag(entry.id) + '<span>' + nameOf(entry.id) +
      '</span><span class="n">' + entry.amount + '</span>';
    chips.appendChild(chip);
  });

  var listBox = $('list');
  listBox.textContent = '';
  var any = false;

  v.stock.forEach(function (entry) {
    if (!entry.sellable || entry.amount <= 0) return;
    any = true;
    var pick = pickOf(entry);
    var amount = clamp(pick.amount, 1, entry.amount);
    var price = clamp(pick.price, entry.bandMin, entry.bandMax);
    var fee = NS.listingFee(rules, entry.item, amount);
    var free = v.orderSlotsFree;
    var canPayFee = v.currency.amount >= fee;

    var offer = document.createElement('div');
    offer.className = 'card trade';
    var offerHead = document.createElement('div');
    offerHead.className = 'head';
    offerHead.innerHTML =
      '<span class="name">' + iconTag(entry.id) + nameOf(entry.id) + ' anbieten</span>' +
      '<span class="have">du hast ' + entry.amount + ' · ' +
      free + (free === 1 ? ' Platz' : ' Plätze') + ' frei</span>';
    offer.appendChild(offerHead);
    offer.appendChild(numberPick(
      'Menge',
      function () { return picks[entry.item].amount; },
      1,
      entry.amount,
      function (n, typing) { picks[entry.item].amount = n; if (!typing) render(); },
      'alle',
    ));
    offer.appendChild(numberPick(
      'Preis',
      function () { return picks[entry.item].price; },
      entry.bandMin,
      entry.bandMax,
      function (n, typing) { picks[entry.item].price = n; if (!typing) render(); },
    ));

    var offerGo = document.createElement('button');
    offerGo.type = 'button';
    offerGo.className = 'done';
    offerGo.disabled = free <= 0 || !canPayFee;
    offerGo.textContent = 'Anbieten · bringt ' + amount * price + ' ' + itemName(v.currency.item);
    offerGo.addEventListener('click', function () {
      var n = clamp(picks[entry.item].amount, 1, client.preview().items[entry.item] || 0);
      var p = clamp(picks[entry.item].price, entry.bandMin, entry.bandMax);
      if (n <= 0) return;
      act('Angeboten · ' + n + ' ' + nameOf(entry.id), client.listOrder(entry.item, n, p));
    });
    offer.appendChild(offerGo);

    var note = document.createElement('div');
    note.className = 'note';
    note.textContent = free <= 0
      ? 'Alle Auslage-Plätze belegt'
      : !canPayFee
      ? 'Gebühr ' + fee + ' ' + itemName(v.currency.item) + ' — so viel hast du nicht'
      : 'Gebühr ' + fee + ' ' + itemName(v.currency.item) + ' · Band ' +
        entry.bandMin + '–' + entry.bandMax;
    offer.appendChild(note);
    listBox.appendChild(offer);
  });

  if (!any) listBox.innerHTML = '<p class="empty">Nichts anzubieten — erst ernten.</p>';
}

function renderBadges() {}

function renderBauliste(v) {
  var box = $('bauliste');
  box.textContent = '';

  if (!v.grid) {
    box.innerHTML = '<p class="empty">Dieser Hof läuft noch auf einem Regelwerk ohne Raster. ' +
      'Beim nächsten Sync nach einem Server-Update wandert er darauf.</p>';
    return;
  }
  if (v.buildable.length === 0) {
    box.innerHTML = '<p class="empty">Alles gebaut.</p>';
    return;
  }

  v.buildable.forEach(function (b) {
    var karte = document.createElement('button');
    karte.className = 'card';
    karte.disabled = !b.affordable;
    karte.innerHTML =
      '<div class="body">' +
      '<div class="top">' + plotName(b.plot) +
        (b.label && b.label !== plotName(b.plot) && plotName(b.plot).indexOf(b.label) !== 0
          ? ' · ' + b.label
          : '') + '</div>' +
      '<div class="sub">' + (b.unlocked
        ? stacksMitBild(b.cost) + ' · ' + b.size.w + '×' + b.size.h + ' Felder'
        : 'ab Stufe ' + b.minPlayerLevel) + '</div></div>' +
      '<span class="go">' + (b.unlocked ? 'Bauen' : '🔒') + '</span>';
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
  BAD_AMOUNT: 'Ungültige Menge',
  OFFER_GONE: 'Jemand war schneller',
  PLOT_BUSY: 'Läuft noch',
  MAX_LEVEL: 'Voll ausgebaut',
};
