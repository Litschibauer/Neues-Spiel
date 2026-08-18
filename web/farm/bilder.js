function artField(stage, crop) {
  var soil = '<rect x="0" y="0" width="100" height="80" fill="var(--sky)"/>' +
    '<path d="M0 34h100v46H0z" fill="var(--soil)"/>' +
    '<path d="M0 34h100v4H0zM0 46h100v3H0zM0 57h100v3H0zM0 68h100v3H0z" fill="var(--soil-dark)" opacity=".45"/>';
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

function artPasture(level, ready) {
  var out = '<rect x="0" y="0" width="100" height="80" fill="var(--sky)"/>' +
    '<path d="M0 54h100v26H0z" fill="var(--leaf)" opacity=".5"/>' +

    '<path d="M6 44v22M28 44v22M72 44v22M94 44v22" stroke="var(--wood)" stroke-width="3" stroke-linecap="round"/>' +
    '<path d="M2 50h96M2 60h96" stroke="var(--wood)" stroke-width="2.5" stroke-linecap="round"/>';

  if (level >= 2) {
    out += '<g transform="translate(50 58)">' +
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
  return '<rect x="0" y="0" width="100" height="80" fill="var(--sky)"/>' +
    '<path d="M0 62h100v18H0z" fill="var(--soil)"/>' +
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
  return '<rect x="0" y="0" width="100" height="80" fill="var(--sky)"/>' +
    '<path d="M0 62h100v18H0z" fill="var(--soil)"/>' +
    '<path d="M36 62V36h28v26z" fill="var(--wood)"/>' +
    '<path d="M50 24 32 38h36z" fill="var(--wood-dark)"/>' +
    '<rect x="45" y="50" width="10" height="12" rx="1" fill="var(--soil-dark)" opacity=".55"/>' +
    '<g transform="translate(50 40)"><g>' + spin +
    '<path d="M0-20V20M-20 0H20" stroke="var(--wood-dark)" stroke-width="3" stroke-linecap="round"/>' +
    '<circle r="3" fill="var(--wood-dark)"/>' +
    '</g></g>';
}

function artCoop(level, ready) {
  var out = '<rect x="0" y="0" width="100" height="80" fill="var(--sky)"/>' +
    '<path d="M0 62h100v18H0z" fill="var(--leaf)" opacity=".45"/>' +
    '<path d="M28 62V40h44v22z" fill="var(--wood)"/>' +
    '<path d="M50 28 22 42h56z" fill="var(--wood-dark)"/>' +
    '<rect x="44" y="50" width="12" height="12" rx="1" fill="var(--soil-dark)" opacity=".55"/>';

  if (level >= 2) {
    out += '<g transform="translate(16 56)">' +
      '<ellipse cx="0" cy="0" rx="7" ry="5.5" fill="var(--feather)"/>' +
      '<circle cx="5" cy="-5" r="3.6" fill="var(--feather)"/>' +
      '<path d="M8 -5l3 1-3 1z" fill="var(--ripe)"/>' +
      '<circle cx="6" cy="-6" r=".8" fill="var(--ink)"/>' +
      '<path d="M4-8c1-2 3-1 2 1" fill="var(--bad)"/>' +
      '</g>' +
      '<g transform="translate(84 58) scale(-1 1)">' +
      '<ellipse cx="0" cy="0" rx="6" ry="5" fill="var(--feather-2)"/>' +
      '<circle cx="4.5" cy="-4.5" r="3.2" fill="var(--feather-2)"/>' +
      '<path d="M7 -4.5l2.6 1-2.6 1z" fill="var(--ripe)"/>' +
      '</g>';
  }
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
  'coop-': function (p) { return artCoop(p.level, p.done); },
  'pasture-': function (p) { return artPasture(p.level, p.done); },
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
