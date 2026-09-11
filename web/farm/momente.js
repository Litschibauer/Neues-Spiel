// — Momente ————————————————————————————————————————————————————————————
// Im Spiel passieren gute Dinge, die bisher stumm blieben: Ein Erfolg wird
// fällig, ein Zettel kippt über die Ziellinie, der Tagesabschluss wird frei,
// die Kiste gibt ihre Beute her. Dieses Modul erkennt die Übergänge — es
// vergleicht die Sicht von eben mit der von jetzt — und macht aus jedem einen
// Moment: Klang, Meldung zum Antippen, ein Wink am richtigen Möbel.
//
// Es erfindet nichts. Alles, was hier gefeiert wird, steht schon im Spielstand;
// hier bekommt es nur den Ton, den es verdient.

var momenteGesehen = null;
// Beim Start hat der Empfang Vorrang: Was er aufzählt, muss nicht auch noch
// als Meldung hereinschneien.
var momenteStummBis = 0;
var momenteSchlange = [];
var momenteLaeuft = false;
// Welche Möbel gerade winken (Id → bis wann). Der Neuaufbau der Möbel läuft
// jede Sekunde; die Klasse muss deshalb bei jedem Aufbau neu gesetzt werden.
var momenteWinkt = {};

function lohnText(e) {
  var teile = [];
  if (e.gold > 0) teile.push(e.gold + ' Gold');
  if (e.xp > 0) teile.push(e.xp + ' XP');
  return teile.join(' + ');
}

function momentePruefen(v) {
  var jetzt = {
    erfolge: {}, aufgaben: {}, abschluss: false,
    // Was von aussen kommt, waehrend man spielt: Kaeufe im eigenen Stand, der
    // Wagen, der wiederkommt, eine Kiste, die auftaucht, der neue Tag.
    kasse: {}, wagenDa: !!(v.truck && v.truck.enabled && v.truck.here),
    kisten: {}, tag: (v.aufgaben && v.aufgaben.tag) || 0,
  };
  (v.erfolge || []).forEach(function (e) { if (e.erfuellt && !e.eingeloest) jetzt.erfolge[e.id] = e; });
  ((v.aufgaben && v.aufgaben.liste) || []).forEach(function (a) {
    if (a.erfuellt && !a.eingeloest) jetzt.aufgaben[a.id] = a;
  });
  var ab = v.aufgaben && v.aufgaben.abschluss;
  jetzt.abschluss = !!(ab && ab.erfuellt && !ab.eingeloest);
  jetzt.wochen = {};
  ((v.wochenaufgaben && v.wochenaufgaben.liste) || []).forEach(function (a) {
    if (a.erfuellt && !a.eingeloest) jetzt.wochen[a.id] = a;
  });
  var wab = v.wochenaufgaben && v.wochenaufgaben.abschluss;
  jetzt.wochenAbschluss = !!(wab && wab.erfuellt && !wab.eingeloest);
  jetzt.woche = (v.wochenaufgaben && v.wochenaufgaben.tag) || 0;
  (v.orders || []).forEach(function (o) { jetzt.kasse[o.id] = { sold: o.sold || 0, item: o.item }; });
  (v.chests || []).forEach(function (k) { if (k.ready) jetzt.kisten[k.id] = k; });

  if (momenteGesehen === null) {
    momenteGesehen = jetzt;
    momenteStummBis = Date.now() + 6000;
    return;
  }
  var alt = momenteGesehen;
  momenteGesehen = jetzt;
  if (Date.now() < momenteStummBis) return;

  // „Verkauft!" — ein anderer Mensch hat gerade etwas aus dem Stand gekauft.
  Object.keys(jetzt.kasse).forEach(function (id) {
    var war = alt.kasse[id] ? alt.kasse[id].sold : 0;
    var o = jetzt.kasse[id];
    if (o.sold <= war) return;
    moment({
      klang: 'muenzen', winkt: 'stand', hin: 'stand',
      text: 'Verkauft · ' + itemName(o.item) + ' für ' + (o.sold - war) + ' Gold — Kasse am Stand',
    });
  });

  if (jetzt.wagenDa && !alt.wagenDa) {
    moment({ klang: 'wagen', winkt: 'wagen', hin: 'brett', text: 'Der Wagen ist zurück — neue Zettel am Brett' });
  }

  Object.keys(jetzt.kisten).forEach(function (id) {
    if (alt.kisten[id]) return;
    var k = jetzt.kisten[id];
    momenteFunkeltBis = Date.now() + 3000;
    moment({
      klang: 'kiste', text: 'Eine Kiste ist aufgetaucht',
      hin: function () {
        if (typeof hatRaster === 'function' && hatRaster() && k.gx >= 0) {
          zentriere(k.gx, k.gy);
          kameraKlemmen();
          kameraAnwenden();
        }
        momenteFunkeltBis = Date.now() + 2500;
        winkeAnwenden();
      },
    });
  });

  if (alt.tag > 0 && jetzt.tag !== alt.tag) {
    moment({ klang: 'zettel', winkt: 'abenteuer', hin: 'abenteuer', text: 'Neuer Tag — neue Zettel am Brett' });
  }

  Object.keys(jetzt.wochen).forEach(function (id) {
    if (alt.wochen && alt.wochen[id]) return;
    var a = jetzt.wochen[id];
    moment({
      klang: 'erfolg', winkt: 'abenteuer', hin: 'abenteuer',
      text: 'Wochenzettel erfüllt · ' + a.label + ' — ' + lohnText(a) + ' am Brett',
    });
  });
  if (jetzt.wochenAbschluss && !alt.wochenAbschluss) {
    moment({
      klang: 'erfolg', winkt: 'abenteuer', hin: 'abenteuer',
      text: 'Alle Wochenzettel ab — die Wochentruhe wartet am Brett',
    });
  }
  if (alt.woche > 0 && jetzt.woche !== alt.woche) {
    moment({ klang: 'zettel', winkt: 'abenteuer', hin: 'abenteuer', text: 'Neue Woche — neue Wochenzettel am Brett' });
  }

  Object.keys(jetzt.aufgaben).forEach(function (id) {
    if (alt.aufgaben[id]) return;
    var a = jetzt.aufgaben[id];
    moment({
      klang: 'zettel', winkt: 'abenteuer', hin: 'abenteuer',
      text: 'Zettel erfüllt · ' + a.label + ' — ' + lohnText(a) + ' am Brett',
    });
  });
  if (jetzt.abschluss && !alt.abschluss) {
    moment({
      klang: 'zettel', winkt: 'abenteuer', hin: 'abenteuer',
      text: 'Alle Zettel ab — der Tagesabschluss wartet am Brett',
    });
  }
  Object.keys(jetzt.erfolge).forEach(function (id) {
    if (alt.erfolge[id]) return;
    var e = jetzt.erfolge[id];
    moment({
      klang: 'erfolg', punkt: true, hin: 'ziele',
      text: '★ Erfolg · ' + e.label + ' — ' + lohnText(e) + ' warten',
    });
  });
}

// Eine Warteschlange, damit drei Momente auf einmal nicht drei Meldungen
// übereinander sind, sondern drei nacheinander.
function moment(m) {
  momenteSchlange.push(m);
  momenteWeiter();
}

function momenteWeiter() {
  if (momenteLaeuft || momenteSchlange.length === 0) return;
  var m = momenteSchlange.shift();
  momenteLaeuft = true;
  // Die Aktion, die den Moment ausgelöst hat, hat ihre eigene Meldung. Die
  // darf man erst lesen; der Moment kommt einen Atemzug später obendrauf.
  setTimeout(function () { momentZeigen(m); }, 1300);
}

function momentZeigen(m) {
  // Steht gerade eine frische Meldung — „Geholfen · +12 XP" etwa —, darf der
  // Moment sie nicht wegwischen. Er wartet, bis sie gelesen ist.
  var frisch = Date.now() - toastSeit;
  if (frisch < 1500) {
    setTimeout(function () { momentZeigen(m); }, 1500 - frisch + 50);
    return;
  }
  // Auf einem fremden Hof gehen die Neuigkeiten vom eigenen niemanden an —
  // und der Stand, der winken soll, ist gar nicht im Bild. Sie warten, bis
  // man wieder zu Hause ist.
  if (client && client.besuch) {
    setTimeout(function () { momentZeigen(m); }, 1500);
    return;
  }
  klang(m.klang);
  if (navigator.vibrate) navigator.vibrate(12);
  var hin = typeof m.hin === 'function' ? m.hin : m.hin ? function () { show(m.hin); } : null;
  toast(m.text, false, hin);
  if (m.winkt) winke(m.winkt);
  if (m.punkt) {
    var p = $('zahnrad-punkt');
    if (p) {
      p.hidden = false;
      p.classList.add('neu');
      setTimeout(function () { p.classList.remove('neu'); }, 2800);
    }
  }
  setTimeout(function () { momenteLaeuft = false; momenteWeiter(); }, 3600);
}

function winke(id) {
  momenteWinkt[id] = Date.now() + 3000;
  winkeAnwenden();
}

// Kacheln und Kisten werden bei jedem Neuaufbau frisch erzeugt — was an ihnen
// gerade passiert (ein Bauwerk waechst, eine Kiste funkelt), muss deshalb bei
// jedem Aufbau neu angelegt werden.
var momenteWaechst = {};
var momenteFunkeltBis = 0;

function winkeAnwenden() {
  var jetzt = Date.now();
  Object.keys(momenteWinkt).forEach(function (id) {
    var el = $(id);
    if (!el) return;
    if (momenteWinkt[id] > jetzt) el.classList.add('winkt');
    else { el.classList.remove('winkt'); delete momenteWinkt[id]; }
  });
  Object.keys(momenteWaechst).forEach(function (plot) {
    var kachel = document.querySelector('#plots .plot[data-platz="' + plot + '"]');
    if (momenteWaechst[plot] > jetzt) { if (kachel) kachel.classList.add('waechst'); }
    else { if (kachel) kachel.classList.remove('waechst'); delete momenteWaechst[plot]; }
  });
  var funkelt = momenteFunkeltBis > jetzt;
  document.querySelectorAll('#kisten .schatz').forEach(function (k) { k.classList.toggle('funkelt', funkelt); });
}

// Ein Bauwerk kommt nicht „einfach hin": Es waechst aus dem Boden, Staub
// fliegt, der Hammer klopft. Der groesste Geldmoment im Spiel verdient das.
function bauMoment(plot) {
  momenteWaechst[plot] = Date.now() + 800;
  klang('bau');
  var wo = typeof platzKasten === 'function' ? platzKasten(plot) : null;
  if (wo && wo.width) { funken(wo, 'staub'); setTimeout(function () { funken(wo, 'staub'); }, 160); }
  if (navigator.vibrate) { try { navigator.vibrate([0, 20, 40, 20, 40, 30]); } catch (e) {} }
  winkeAnwenden();
}

// — Die Kiste ————————————————————————————————————————————————————————
// Öffnen heißt bisher: „der Inhalt kommt mit der Post". Der Server würfelt die
// Beute, und irgendwann liegt sie als Karte im Postfach — der Moment, was war
// drin, fand nie statt. Dabei ist er der ganze Witz einer Kiste.
//
// Der Client erkennt ihn am Abgleich: Fällt die Zahl der offenen Kisten und
// wächst zugleich die Post, sind die neuen Einträge die Beute. War die Post
// voll, kommt die Beute erst später — dann wird sie beim nächsten Wachsen
// enthüllt.
var kisteWartet = false;

function momenteNachAbgleich(vorher) {
  if (!vorher || !client) return;
  var nachher = NS.farmView(client.preview(), rules, navigator.onLine);
  var gefallen = nachher.openBoxes < vorher.openBoxes;
  var dazu = nachher.mail.entries.length - vorher.mail.entries.length;
  if ((gefallen || kisteWartet) && dazu > 0) {
    kisteWartet = false;
    kisteEnthuellen(nachher.mail.entries.slice(vorher.mail.entries.length));
  } else if (gefallen) {
    kisteWartet = true;
  }
}

function kisteEnthuellen(beute) {
  var box = $('kiste-beute');
  if (!box || beute.length === 0) return;
  box.innerHTML = beute.map(function (b, i) {
    var gold = b.item === rules.currency;
    return '<div class="zeile" style="animation-delay:' + (0.45 + i * 0.18) + 's">' +
      itemIcon(b.item) + '<span>' + b.amount + (gold ? ' ' : '× ') + stueckName(b.amount, b.item) + '</span></div>';
  }).join('');
  var bild = $('kiste-bild');
  if (bild) bild.innerHTML = moebelSvg('kiste', {});
  $('kiste-feier').hidden = false;
  klang('truhe');
  setTimeout(konfetti, 420);
  if (navigator.vibrate) { try { navigator.vibrate([0, 30, 60, 40]); } catch (e) {} }
}

function kisteEinpacken() {
  // Woher die Stuecke fliegen, muss feststehen, bevor die Karte zugeht.
  var von = $('kiste-beute') ? $('kiste-beute').getBoundingClientRect() : null;
  $('kiste-feier').hidden = true;
  if (!client) return;
  var vorher = NS.farmView(client.preview(), rules, navigator.onLine);
  var beute = vorher.mail.entries;
  var r = client.collectMail();
  if (!r.ok) {
    // Zum Beispiel: Lager voll. Die Beute bleibt im Postfach — sie ist nicht weg.
    toast('Passt gerade nicht ins Lager — die Beute bleibt im Postfach', true);
    render();
    return;
  }
  save();
  scheduleSync();
  var nachher = NS.farmView(client.preview(), rules, navigator.onLine);
  var dazu = nachher.currency.amount - vorher.currency.amount;
  klang('muenzen');
  var muenzen = document.querySelector('.coins');
  if (dazu > 0 && muenzen) {
    muenzenFliegen(von || muenzen, dazu, function () {
      zahlAuf(muenzen.getBoundingClientRect(), '+' + dazu, 'muenzen');
    });
  }
  beute.forEach(function (b, i) {
    if (b.item === rules.currency) return;
    setTimeout(function () { flugZu(von, $('silo'), itemIcon(b.item), 'ware', 1); }, i * 90);
  });
  toast('Eingepackt');
  render();
}

function kisteZu() {
  $('kiste-feier').hidden = true;
}
