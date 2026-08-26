function render() {
  if (!client) return;
  if (netzWache()) return;
  client.localTick = tickNow();
  var s = client.preview();
  var v = NS.farmView(s, rules, marktLive());

  renderPurse(v);
  renderPlots(v);
  renderTruck(v);
  renderMoebel(v);
  renderHindernisse(v);
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
  renderHofinfo(v);
  renderBadges(v);
  renderBauliste(v);
  renderSheet(v);
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
  $('silo-fill').style.width = Math.round((v.silo.used * 100) / v.silo.capacity) + '%';
  $('silo').className = 'silo' + (v.silo.full ? ' full' : '');
}

function plotStatus(p) {
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
    tile.dataset.platz = String(p.index);
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
  moebel($('stand'), artStand(), 'Stand', v.orders.filter(function (o) { return o.sold > 0; }).length);
  moebel($('nachbarn'), artNachbarn(), 'Nachbarn', 0);

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
    act('Lager ausgebaut · ' + v.silo.upgrade.capacity + ' Platz', client.upgradeSilo(), 'stufe');
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
      act('Abgeschickt nach ' + z.dest + ' · ' + stacks(z.reward), client.sendSlip(z.slot), 'wagen');
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

function renderVorrat(v) {
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
}

var stand = null;

function standZu() { stand = null; }

function standWaren(v) {
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
      if (erg.ok) zahlAuf(wo, '+' + geld, 'gold');
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
  var waren = standWaren(v);
  var raster = document.createElement('div');
  raster.className = 'stand-raster';

  waren.forEach(function (entry) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'kaestchen wahl';
    b.innerHTML = iconTag(entry.id, 'gross') +
      '<span class="n">' + nameOf(entry.id) + '</span>' +
      '<span class="rest">du hast ' + entry.amount + '</span>';
    b.addEventListener('click', function () {
      var g = standGrenzen(entry);
      stand = { item: entry.item, amount: g.menge, price: g.max };
      render();
    });
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
  TOO_MANY_PER_SLOT: 'Zu viel für ein Kästchen',
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
};
