function artBaum() {
  return '<g><ellipse cx="50" cy="88" rx="26" ry="6" fill="var(--ink)" opacity=".18"/>' +
    '<rect x="44" y="52" width="12" height="36" rx="3" fill="var(--wood-dark)"/>' +
    '<circle cx="50" cy="42" r="30" fill="var(--leaf-dark)"/>' +
    '<circle cx="32" cy="50" r="20" fill="var(--leaf)"/>' +
    '<circle cx="68" cy="50" r="18" fill="var(--leaf)"/>' +
    '<circle cx="50" cy="28" r="18" fill="var(--leaf)"/></g>';
}

function artStein() {
  return '<g><ellipse cx="50" cy="86" rx="30" ry="7" fill="var(--ink)" opacity=".18"/>' +
    '<path d="M18 86c-4-16 4-30 16-36 12-6 28-4 36 6 8 10 10 22 6 30z" fill="#9aa1a6"/>' +
    '<path d="M50 50c8-4 18-2 24 6 6 8 8 18 4 30H50z" fill="#7e858a"/>' +
    '<path d="M30 60c4-6 10-8 14-6" stroke="#b7bec3" stroke-width="4" stroke-linecap="round" fill="none"/></g>';
}

function artTuempel() {
  return '<g><ellipse cx="50" cy="60" rx="44" ry="26" fill="#6f9a5e"/>' +
    '<ellipse cx="50" cy="58" rx="38" ry="21" fill="#4d86a8"/>' +
    '<ellipse cx="50" cy="55" rx="30" ry="15" fill="#63a3c4"/>' +
    '<path d="M28 50c8-4 16-4 24 0" stroke="#a7d3e6" stroke-width="3" stroke-linecap="round" fill="none" opacity=".8"/>' +
    '<ellipse cx="66" cy="63" rx="7" ry="4" fill="#4f8f4a"/>' +
    '<ellipse cx="36" cy="66" rx="5" ry="3" fill="#4f8f4a"/></g>';
}

function artScene() {
  var out = '<rect x="0" y="0" width="100" height="130" fill="var(--meadow)"/>' +
    '<rect x="0" y="0" width="100" height="13" fill="var(--sky)"/>' +
    '<path d="M0 13V9c8-5 16-5 24 0 7-4 14-4 21 1 9-6 18-6 27 0 9-5 19-5 28 1v2z"' +
    ' fill="var(--hill)"/>' +

    (hatRaster() ? '<path d="M0 22h100v6H0z" fill="var(--path)"/>' : '') +

    '<g opacity=".92">' +
    '<path d="M6 22V11h18v11z" fill="var(--surface)"/>' +
    '<path d="M15 5 3 12h24z" fill="var(--roof)"/>' +
    '<rect x="12" y="16" width="6" height="6" rx="1" fill="var(--wood-dark)"/>' +
    '<rect x="21" y="14" width="4" height="4" rx="1" fill="var(--sky)" opacity=".85"/>' +
    '<rect x="21" y="6" width="3" height="6" fill="var(--roof)"/>' +
    '</g>';

  var baeume = [[34, 20, .55], [62, 20, .5], [95, 20, .5]];
  for (var i = 0; i < baeume.length; i++) {
    out += '<g transform="translate(' + baeume[i][0] + ' ' + baeume[i][1] +
      ') scale(' + baeume[i][2] + ')">' +
      '<rect x="-1" y="-3" width="2" height="6" fill="var(--wood-dark)"/>' +
      '<circle cy="-7" r="5" fill="var(--leaf-dark)"/>' +
      '<circle cx="-3" cy="-5" r="3.4" fill="var(--leaf)"/>' +
      '<circle cx="3" cy="-5" r="3" fill="var(--leaf)"/>' +
      '</g>';
  }

  return out + artBoden(bauModus);
}

function artTruck(unterwegs, voll) {
  var ladung = voll
    ? '<rect x="12" y="2" width="44" height="6" rx="2" fill="var(--corn)"/>'
    : '';

  return '<ellipse cx="50" cy="36" rx="46" ry="3.5" fill="var(--ink)" opacity=".18"/>' +
    ladung +
    '<rect x="6" y="7" width="52" height="22" rx="3" fill="var(--truck)"/>' +
    '<rect x="6" y="15" width="52" height="3" fill="var(--ink)" opacity=".1"/>' +
    '<path d="M58 29V12h13l10 9v8z" fill="var(--truck-cab)"/>' +
    '<rect x="63" y="14" width="10" height="7" rx="1.5" fill="var(--sky)" opacity=".9"/>' +
    '<circle cx="22" cy="30" r="6" fill="var(--ink)"/>' +
    '<circle cx="22" cy="30" r="2.6" fill="var(--muted)"/>' +
    '<circle cx="72" cy="30" r="6" fill="var(--ink)"/>' +
    '<circle cx="72" cy="30" r="2.6" fill="var(--muted)"/>' +
    (unterwegs
      ? '<g opacity=".5"><circle cx="2" cy="24" r="4" fill="var(--surface)">' +
        '<animate attributeName="r" values="1.5;6" dur="1.6s" repeatCount="indefinite"/>' +
        '<animate attributeName="opacity" values=".6;0" dur="1.6s" repeatCount="indefinite"/>' +
        '</circle></g>'
      : '');
}

function artBrett(zettel) {
  var out = '<rect x="16" y="52" width="6" height="24" fill="var(--wood-dark)"/>' +
    '<rect x="78" y="52" width="6" height="24" fill="var(--wood-dark)"/>' +
    '<rect x="8" y="10" width="84" height="46" rx="4" fill="var(--wood)"/>' +
    '<rect x="12" y="14" width="76" height="38" rx="3" fill="var(--wood-dark)" opacity=".35"/>';

  var stellen = [[17, 16], [53, 16], [17, 35], [53, 35]];
  for (var i = 0; i < Math.min(zettel, 4); i++) {
    out += '<rect x="' + stellen[i][0] + '" y="' + stellen[i][1] +
      '" width="30" height="15" rx="1.5" fill="var(--surface)"/>' +
      '<path d="M' + (stellen[i][0] + 4) + ' ' + (stellen[i][1] + 5) + 'h20M' +
      (stellen[i][0] + 4) + ' ' + (stellen[i][1] + 10) + 'h13" ' +
      'stroke="var(--muted)" stroke-width="1.6" stroke-linecap="round"/>';
  }
  return out;
}

function artLager(voll) {
  return '<ellipse cx="50" cy="72" rx="42" ry="6" fill="var(--ink)" opacity=".18"/>' +
    '<path d="M14 72V34h72v38z" fill="var(--roof)"/>' +
    '<path d="M50 12 6 38h88z" fill="var(--wood-dark)"/>' +
    '<rect x="38" y="46" width="24" height="26" rx="2" fill="var(--wood)"/>' +
    '<path d="M50 46v26" stroke="var(--wood-dark)" stroke-width="2"/>' +
    '<rect x="44" y="24" width="12" height="10" rx="2" fill="var(--sky)" opacity=".8"/>' +
    (voll
      ? '<circle cx="80" cy="26" r="8" fill="var(--warn)"/>' +
        '<path d="M80 21v6M80 30v1.5" stroke="var(--surface)" stroke-width="2.4" stroke-linecap="round"/>'
      : '');
}

function artStand() {
  return '<ellipse cx="50" cy="72" rx="40" ry="6" fill="var(--ink)" opacity=".18"/>' +
    '<rect x="18" y="40" width="64" height="8" fill="var(--wood-dark)"/>' +
    '<rect x="22" y="48" width="56" height="24" rx="2" fill="var(--wood)"/>' +
    '<path d="M10 40h80l-8-18H18z" fill="var(--truck-cab)"/>' +
    '<path d="M18 22h14l-4 18H10zM46 22h14l-2 18H44zM74 22h8l6 18H72z" fill="var(--surface)" opacity=".55"/>' +
    '<circle cx="36" cy="58" r="5" fill="var(--ripe)"/>' +
    '<circle cx="50" cy="58" r="5" fill="var(--leaf)"/>' +
    '<circle cx="64" cy="58" r="5" fill="var(--corn)"/>';
}

function artKiste() {
  return '<ellipse cx="50" cy="74" rx="34" ry="5" fill="var(--ink)" opacity=".2"/>' +
    '<rect x="16" y="34" width="68" height="38" rx="4" fill="var(--wood)"/>' +
    '<path d="M16 40a34 14 0 0168 0z" fill="var(--wood-dark)"/>' +
    '<rect x="16" y="38" width="68" height="6" fill="var(--wood-dark)"/>' +
    '<rect x="42" y="30" width="16" height="20" rx="2" fill="var(--gold)"/>' +
    '<circle cx="50" cy="42" r="3.5" fill="var(--soil-dark)"/>' +
    '<path d="M24 48v18M76 48v18" stroke="var(--wood-dark)" stroke-width="3"/>' +
    '<g opacity=".9">' +
    '<path d="M50 18l2.5 6 6 2.5-6 2.5L50 35l-2.5-6-6-2.5 6-2.5z" fill="var(--ripe)"/>' +
    '</g>';
}

function artField(stage, crop) {
  var soil = '<rect x="2" y="6" width="96" height="70" rx="7" fill="var(--soil)"/>' +
    '<path d="M6 16h88v4H6zM6 30h88v3H6zM6 44h88v3H6zM6 58h88v3H6z" fill="var(--soil-dark)" opacity=".4"/>';
  if (stage <= 0) return soil;

  var out = soil, x, i;
  var isCorn = crop === 'corn';

  var count = isCorn ? 4 : 5;
  var gap = isCorn ? 22 : 18;
  var left = isCorn ? 18 : 14;

  for (i = 0; i < count; i++) {
    x = left + i * gap;
    if (stage === 1) {
      out += '<path d="M' + x + ' 62v-7" stroke="var(--leaf)" stroke-width="2.5" stroke-linecap="round"/>' +
        '<path d="M' + x + ' 57c-3-2-4-5-4-5s4 0 4 3" fill="var(--leaf)"/>';
    } else if (stage === 2) {
      out += isCorn
        ? '<path d="M' + x + ' 66V38" stroke="var(--corn-leaf)" stroke-width="3" stroke-linecap="round"/>' +
          '<path d="M' + x + ' 50c-7-3-8-9-8-9s8 1 8 6zM' + x + ' 43c7-3 8-9 8-9s-8 1-8 6z" fill="var(--corn-leaf)"/>'
        : '<path d="M' + x + ' 66V42" stroke="var(--leaf)" stroke-width="2.5" stroke-linecap="round"/>' +
          '<path d="M' + x + ' 52c-5-2-6-7-6-7s6 1 6 5zM' + x + ' 46c5-2 6-7 6-7s-6 1-6 5z" fill="var(--leaf-dark)"/>';
    } else if (isCorn) {
      out += '<path d="M' + x + ' 70V26" stroke="var(--corn-leaf)" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M' + x + ' 44c-9-3-10-10-10-10s10 1 10 7zM' + x + ' 36c9-3 10-10 10-10s-10 1-10 7z" fill="var(--corn-leaf)"/>' +
        '<ellipse cx="' + (x + 5) + '" cy="48" rx="4" ry="8" fill="var(--corn)"/>' +
        '<path d="M' + (x + 5) + ' 41v14" stroke="var(--soil-dark)" stroke-width="1" opacity=".35"/>' +
        '<path d="M' + x + ' 26l-3-6M' + x + ' 26l3-6" stroke="var(--ripe)" stroke-width="1.6" stroke-linecap="round"/>';
    } else {
      out += '<path d="M' + x + ' 68V44" stroke="var(--leaf-dark)" stroke-width="2.5" stroke-linecap="round"/>' +
        '<ellipse cx="' + x + '" cy="36" rx="5" ry="10" fill="var(--ripe)"/>' +
        '<path d="M' + x + ' 27v18" stroke="var(--soil-dark)" stroke-width="1.2" opacity=".5"/>';
    }
  }
  return out;
}

function cow(x, y, scale) {
  return '<g transform="translate(' + x + ' ' + y + ') scale(' + scale + ')">' +
    '<ellipse cx="0" cy="0" rx="18" ry="11" fill="var(--hide)"/>' +
    '<ellipse cx="-7" cy="-3" rx="6" ry="4" fill="var(--hide-spot)" opacity=".8"/>' +
    '<ellipse cx="8" cy="3" rx="4.5" ry="3" fill="var(--hide-spot)" opacity=".8"/>' +
    '<path d="M-14 9v6M-5 10v5M5 10v5M14 9v6" stroke="var(--hide-spot)" stroke-width="2.5" stroke-linecap="round"/>' +
    '<circle cx="19" cy="-7" r="7" fill="var(--hide)"/>' +
    '<path d="M13 -12c-3-3-2-6-2-6s4 1 5 4z" fill="var(--hide-spot)"/>' +
    '<circle cx="21" cy="-9" r="1" fill="var(--ink)"/>' +
    '<ellipse cx="24" cy="-4" rx="3.5" ry="2.5" fill="var(--corn)" opacity=".55"/>' +
    '</g>';
}

function artPasture(animals, ready) {
  var out = '<rect x="2" y="40" width="96" height="34" rx="6" fill="var(--leaf)" opacity=".35"/>' +
    '<path d="M6 44v22M28 44v22M72 44v22M94 44v22" stroke="var(--wood)" stroke-width="3" stroke-linecap="round"/>' +
    '<path d="M2 50h96M2 60h96" stroke="var(--wood)" stroke-width="2.5" stroke-linecap="round"/>';

  if (animals === 1) out += cow(50, 58, 1);
  if (animals === 2) out += cow(30, 54, .7) + cow(62, 64, .7);
  if (animals >= 3) out += cow(24, 52, .58) + cow(56, 60, .58) + cow(34, 70, .58);

  if (ready) {
    out += '<g transform="translate(20 66)">' +
      '<path d="M-6 -7h12l-2 9h-8z" fill="var(--milk)" stroke="var(--soil-dark)" stroke-width="1"/>' +
      '<path d="M-6 -7h12" stroke="var(--soil-dark)" stroke-width="1.4"/>' +
      '</g>';
  }
  return out;
}

function artDairy(working) {
  var steam = working
    ? '<g opacity=".7"><circle cx="70" cy="26" r="3" fill="var(--milk)">' +
      '<animate attributeName="cy" values="26;14" dur="2.4s" repeatCount="indefinite"/>' +
      '<animate attributeName="opacity" values=".7;0" dur="2.4s" repeatCount="indefinite"/>' +
      '</circle></g>'
    : '';
  return '<ellipse cx="48" cy="66" rx="42" ry="8" fill="var(--soil)" opacity=".25"/>' +
    '<path d="M22 62V38h50v24z" fill="var(--milk)"/>' +
    '<path d="M47 26 16 40h62z" fill="var(--wood-dark)"/>' +
    '<rect x="64" y="30" width="8" height="12" fill="var(--wood)"/>' +
    steam +
    '<rect x="30" y="48" width="12" height="14" rx="1" fill="var(--soil-dark)" opacity=".5"/>' +

    '<g transform="translate(84 56)">' +
    '<path d="M-6 6h12l-1-12h-10z" fill="var(--feather-2)" stroke="var(--soil-dark)" stroke-width="1"/>' +
    '<rect x="-3" y="-9" width="6" height="4" rx="1" fill="var(--soil-dark)" opacity=".7"/>' +
    '</g>';
}

function artMill(working) {
  var spin = working
    ? '<animateTransform attributeName="transform" type="rotate" from="0" to="360"' +
      ' dur="7s" repeatCount="indefinite"/>'
    : '';
  return '<ellipse cx="50" cy="66" rx="40" ry="8" fill="var(--soil)" opacity=".25"/>' +
    '<path d="M36 62V36h28v26z" fill="var(--wood)"/>' +
    '<path d="M50 24 32 38h36z" fill="var(--wood-dark)"/>' +
    '<rect x="45" y="50" width="10" height="12" rx="1" fill="var(--soil-dark)" opacity=".55"/>' +
    '<g transform="translate(50 40)"><g>' + spin +
    '<path d="M0-20V20M-20 0H20" stroke="var(--wood-dark)" stroke-width="3" stroke-linecap="round"/>' +
    '<circle r="3" fill="var(--wood-dark)"/>' +
    '</g></g>';
}

function chicken(x, y, flip, tone) {
  return '<g transform="translate(' + x + ' ' + y + ')' + (flip ? ' scale(-1 1)' : '') + '">' +
    '<ellipse cx="0" cy="0" rx="7" ry="5.5" fill="var(' + tone + ')"/>' +
    '<circle cx="5" cy="-5" r="3.6" fill="var(' + tone + ')"/>' +
    '<path d="M8 -5l3 1-3 1z" fill="var(--ripe)"/>' +
    '<circle cx="6" cy="-6" r=".8" fill="var(--ink)"/>' +
    '<path d="M4-8c1-2 3-1 2 1" fill="var(--bad)"/>' +
    '</g>';
}

function artCoop(animals, ready) {
  var out = '<ellipse cx="50" cy="68" rx="46" ry="9" fill="var(--soil)" opacity=".25"/>' +
    '<path d="M28 62V40h44v22z" fill="var(--wood)"/>' +
    '<path d="M50 28 22 42h56z" fill="var(--wood-dark)"/>' +
    '<rect x="44" y="50" width="12" height="12" rx="1" fill="var(--soil-dark)" opacity=".55"/>';

  if (animals >= 1) out += chicken(16, 56, false, '--feather');
  if (animals >= 2) out += chicken(84, 58, true, '--feather-2');
  if (animals >= 3) out += chicken(64, 70, true, '--feather');

  if (ready) {
    out += '<g transform="translate(50 70)">' +
      '<ellipse cx="-8" cy="0" rx="4" ry="5" fill="var(--egg)"/>' +
      '<ellipse cx="0" cy="1" rx="4" ry="5" fill="var(--egg)"/>' +
      '<ellipse cx="8" cy="0" rx="4" ry="5" fill="var(--egg)"/>' +
      '</g>';
  }
  return out;
}

var ART = {
  'field-': function (p) {
    if (!p.busy && !p.done) return artField(0, null);
    return artField(p.done ? 3 : p.progress < .4 ? 1 : 2, p.producing);
  },
  'mill': function (p) { return artMill(p.busy); },
  'coop-': function (p) { return artCoop(p.capacity, p.done); },
  'pasture-': function (p) { return artPasture(p.capacity, p.done); },
  'dairy': function (p) { return artDairy(p.busy); },
  fallback: function () { return artField(0, null); },
};

function artFor(p) {
  if (ART[p.id]) return ART[p.id](p);
  for (var prefix in ART) {
    if (prefix !== 'fallback' && p.id.indexOf(prefix) === 0) return ART[prefix](p);
  }
  return ART.fallback(p);
}
