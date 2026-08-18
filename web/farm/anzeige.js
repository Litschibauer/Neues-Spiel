function render() {
  if (!client) return;
  client.localTick = tickNow();
  var s = client.preview();
  var v = NS.farmView(s, rules, navigator.onLine);

  renderPurse(v);
  renderPlots(v);
  renderRequests(v);
  renderMail(v);
  renderMarket(v);
  renderMyOrders(v);

  var typing = document.activeElement
    && document.activeElement.tagName === 'INPUT'
    && $('view-store').contains(document.activeElement);
  if (!typing) renderStore(v);
  renderBadges(v);
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
  var box = $('plots');
  box.textContent = '';

  v.plots.forEach(function (p) {
    var tile = document.createElement('button');
    tile.className = 'plot' + (p.done ? ' ripe' : '') + (p.idle ? ' locked' : '') +
      (p.blocked === 'level' ? ' gated' : '');
    tile.disabled = p.tap === 'none' && !p.busy ? p.blocked !== 'inputs' : false;

    var art = document.createElement('div');
    art.innerHTML =
      '<svg class="art" viewBox="0 0 100 80" preserveAspectRatio="none" aria-hidden="true">' +
      artFor(p) + '</svg>';
    tile.appendChild(art.firstChild);

    if (p.done) {
      var badge = document.createElement('span');
      badge.className = 'badge';
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

    tile.addEventListener('click', function () { tapPlot(p.index); });
    box.appendChild(tile);

    if (p.upgrade && !p.idle && !p.busy && !p.done) {
      var up = document.createElement('button');
      up.className = 'upgrade';
      up.textContent = p.upgrade.unlocked
        ? p.upgrade.label + ' · ' + costText(p.upgrade.cost)
        : p.upgrade.label + ' ab Stufe ' + p.upgrade.minPlayerLevel;
      up.disabled = !p.upgrade.affordable;
      up.addEventListener('click', function (e) { e.stopPropagation(); tapBuy(p.index); });
      tile.appendChild(up);
    }
  });
}

function renderRequests(v) {
  var box = $('requests');
  box.textContent = '';

  if (v.requests.length === 0) {
    box.innerHTML = '<p class="empty">Gerade wartet niemand. Neue Kunden kommen beim nächsten Sync.</p>';
    return;
  }

  v.requests.forEach(function (r) {
    var card = document.createElement('button');
    card.className = 'card' + (r.waiting ? ' queued' : '');
    card.disabled = !r.deliverable;

    var body = document.createElement('div');
    body.className = 'body';
    var top = document.createElement('div');
    top.className = 'top';
    top.textContent = stacks(r.wants);
    var sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = r.waiting ? 'wartet noch' : r.deliverable ? 'lieferbar' : 'noch nicht genug da';
    body.appendChild(top); body.appendChild(sub);

    var pay = document.createElement('div');
    pay.className = 'pay';
    var amount = document.createElement('div');
    amount.className = 'amount';
    amount.textContent = stacks(r.reward);
    var xp = document.createElement('div');
    xp.className = 'xp';
    xp.textContent = '+' + r.xp + ' XP';
    pay.appendChild(amount); pay.appendChild(xp);

    card.appendChild(body); card.appendChild(pay);
    if (r.deliverable) {
      card.addEventListener('click', function () {
        act('Geliefert · +' + stacks(r.reward), client.fillRequest(r.id));
      });
    }
    box.appendChild(card);

    if (v.skip.enabled && !r.waiting) {
      var skip = document.createElement('button');
      skip.type = 'button';
      skip.className = 'skip';
      skip.disabled = !r.skippable;
      skip.textContent = r.skippable
        ? 'Wegschicken'
        : 'Wegschicken wieder in ' + timeText(v.skip.readyIn);
      skip.addEventListener('click', function () {
        act('Weggeschickt', client.skipRequest(r.id));
      });
      box.appendChild(skip);
    }
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
    chip.innerHTML = '<span>' + nameOf(entry.id) + '</span><span class="n">' + entry.amount + '</span>';
    chips.appendChild(chip);
  });

  var sellBox = $('sell');
  var listBox = $('list');
  sellBox.textContent = '';
  listBox.textContent = '';
  var any = false;

  v.stock.forEach(function (entry) {
    if (!entry.sellable || entry.amount <= 0) return;
    any = true;
    var pick = pickOf(entry);
    var amount = clamp(pick.amount, 1, entry.amount);

    var sell = document.createElement('div');
    sell.className = 'card trade';
    var sellHead = document.createElement('div');
    sellHead.className = 'head';
    sellHead.innerHTML =
      '<span class="name">' + nameOf(entry.id) + '</span>' +
      '<span class="have">' + entry.npcPrice + ' ' + itemName(v.currency.item) +
      ' pro Stück · du hast ' + entry.amount + '</span>';
    sell.appendChild(sellHead);
    sell.appendChild(numberPick(
      'Menge',
      function () { return picks[entry.item].amount; },
      1,
      entry.amount,
      function (n, typing) { picks[entry.item].amount = n; if (!typing) render(); },
      'alle',
    ));

    var sellGo = document.createElement('button');
    sellGo.type = 'button';
    sellGo.className = 'done';
    sellGo.textContent = 'Verkaufen · ' + amount * entry.npcPrice + ' ' + itemName(v.currency.item);
    sellGo.addEventListener('click', function () {
      var n = clamp(picks[entry.item].amount, 1, client.preview().items[entry.item] || 0);
      if (n <= 0) return;
      act('Verkauft · ' + n + ' ' + nameOf(entry.id), client.sellNpc(entry.item, n));
    });
    sell.appendChild(sellGo);
    sellBox.appendChild(sell);

    var price = clamp(pick.price, entry.bandMin, entry.bandMax);
    var fee = NS.listingFee(rules, entry.item, amount);
    var free = v.orderSlotsFree;
    var canPayFee = v.currency.amount >= fee;

    var offer = document.createElement('div');
    offer.className = 'card trade';
    var offerHead = document.createElement('div');
    offerHead.className = 'head';
    offerHead.innerHTML =
      '<span class="name">' + nameOf(entry.id) + ' anbieten</span>' +
      '<span class="have">' + free + (free === 1 ? ' Platz' : ' Plätze') + ' frei</span>';
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

  renderSeedShop(v);

  if (!any) {
    sellBox.innerHTML = '<p class="empty">Nichts zu verkaufen.</p>';
    listBox.innerHTML = '<p class="empty">Nichts anzubieten.</p>';
  }
}

function renderSeedShop(v) {
  var box = $('buy');
  box.textContent = '';
  var any = false;

  v.stock.forEach(function (entry) {
    if (entry.npcBuyPrice <= 0) return;
    any = true;

    var canPay = Math.floor(v.currency.amount / entry.npcBuyPrice);
    var fits = entry.item === v.currency.item ? canPay : Math.min(canPay, v.silo.free);
    var buyCard = document.createElement('button');
    buyCard.className = 'card';
    buyCard.disabled = fits <= 0;
    buyCard.innerHTML =
      '<div class="body"><div class="top">' + nameOf(entry.id) + ' kaufen</div>' +
      '<div class="sub">' + (canPay <= 0
        ? 'zu wenig ' + itemName(v.currency.item)
        : fits <= 0
        ? 'kein Platz im Lager'
        : entry.npcBuyPrice + ' ' + itemName(v.currency.item) + ' pro Stück · ' +
          'Verkauf bringt ' + entry.npcPrice) + '</div></div>' +
      '<span class="go">+1</span>';
    buyCard.addEventListener('click', function () {
      act('Gekauft · 1 ' + nameOf(entry.id), client.buyNpc(entry.item, 1));
    });
    box.appendChild(buyCard);
  });

  if (!any) box.innerHTML = '<p class="empty">Der Händler hat gerade nichts im Angebot.</p>';
}

function renderBadges(v) {
  var todo = v.requests.filter(function (r) { return r.deliverable; }).length
    + v.mail.entries.length;
  var dotOrders = $('dot-orders');
  dotOrders.hidden = todo === 0;
  dotOrders.textContent = todo;

  var dotMarket = $('dot-market');
  dotMarket.hidden = v.buyable === 0;
  dotMarket.textContent = v.buyable;
}

var CODES = {
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
