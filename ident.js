// Station / frequency identifier: what's on a frequency, from
//   EiBi shortwave schedule (eibispace.de, the data behind shortwave.live-style "on air now" lists): LW, MW and HF
//     broadcasters and utilities, with their hours, days, language and target area. Downloaded per season
//     (A = late March - late October, B = the rest), refreshed weekly, cached in DATA_DIR.
//   OurAirports frequencies for the airports within RADIUS_KM of home (tower, ground, ATIS, approach...).
//   A built-in table for marine VHF, Weatheradio and a few fixed services.
// The FM band is identified live by RDS elsewhere.
'use strict';
const fs = require('fs');
const path = require('path');

const HOME = { lat: Number(process.env.HOME_LAT) || 44.65, lon: Number(process.env.HOME_LON) || -63.83 }; // Hubley NS
const RADIUS_KM = Number(process.env.AIR_RADIUS_KM) || 250;

const LANG = {
  E: 'English', F: 'French', S: 'Spanish', P: 'Portuguese', D: 'German', R: 'Russian', A: 'Arabic', M: 'Mandarin', C: 'Chinese',
  J: 'Japanese', K: 'Korean', I: 'Italian', T: 'Thai', NL: 'Dutch', FS: 'Farsi', HI: 'Hindi', TU: 'Turkish', VN: 'Vietnamese',
  IN: 'Indonesian', UK: 'Ukrainian', PO: 'Polish', RO: 'Romanian', HU: 'Hungarian', CZ: 'Czech', SWA: 'Swahili', HA: 'Hausa',
  AM: 'Amharic', BE: 'Bengali', UR: 'Urdu', PS: 'Pashto', DR: 'Dari', TB: 'Tibetan', CA: 'Cantonese', VO: 'Vernacular', ML: 'Multilingual',
  '-TS': 'Time signal', '-CW': 'Morse', '-MX': 'Music', '-HF': 'HF data', '-TY': 'Teletype', '-EC': 'Empty carrier',
};
const DAYS = { Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6, Su: 7 };

function log(...a) {
  console.log(new Date().toISOString(), 'ident:', ...a);
}

// ---- EiBi -------------------------------------------------------------------------------------------------------------
function season(d = new Date()) {
  // A season: last Sunday of March to last Sunday of October (UTC), B otherwise (B of year y runs Oct y - Mar y+1)
  const y = d.getUTCFullYear();
  const lastSun = (m) => {
    const t = new Date(Date.UTC(y, m + 1, 0));
    t.setUTCDate(t.getUTCDate() - t.getUTCDay());
    return t;
  };
  const yy = String(y % 100).padStart(2, '0'), py = String((y - 1) % 100).padStart(2, '0');
  if (d >= lastSun(2) && d < lastSun(9)) return `a${yy}`;
  return d >= lastSun(9) ? `b${yy}` : `b${py}`;
}
// Days field: "" daily; "Mo-Fr", "Sa", "SaSu", "Tu,Fr", "We-Mo", "156" (1 = Monday); "irr"/"Test"/other: irregular.
function parseDays(s) {
  s = (s || '').trim();
  if (!s) return { all: true };
  const set = new Set();
  for (const tok of s.split(',')) {
    if (/^[1-7]+$/.test(tok)) for (const c of tok) set.add(Number(c));
    else if (/^[A-Z][a-z]-[A-Z][a-z]$/.test(tok) && DAYS[tok.slice(0, 2)] && DAYS[tok.slice(3)]) {
      let a = DAYS[tok.slice(0, 2)];
      const b = DAYS[tok.slice(3)];
      for (let k = 0; k < 7; k++) {
        set.add(a);
        if (a === b) break;
        a = (a % 7) + 1;
      }
    } else if (/^([A-Z][a-z])+$/.test(tok)) {
      for (let i = 0; i < tok.length; i += 2) if (DAYS[tok.slice(i, i + 2)]) set.add(DAYS[tok.slice(i, i + 2)]);
    } else return { irregular: true, text: s };
  }
  return set.size ? { set } : { irregular: true, text: s };
}
function parseEibi(text) {
  const out = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const f = line.split(';');
    if (f.length < 7 || !(Number(f[0]) > 0)) continue;
    const [t0, t1] = (f[1] || '0000-2400').split('-');
    out.push({
      khz: Number(f[0]), from: Number(t0) || 0, to: Number(t1) || 2400, days: parseDays(f[2]), itu: f[3], station: f[4].trim(),
      lang: f[5], target: f[6], remarks: f[7] || '', start: f[9] || '', stop: f[10] || '',
    });
  }
  return out;
}
function onAir(e, d = new Date()) {
  const hm = d.getUTCHours() * 100 + d.getUTCMinutes();
  const inTime = e.from <= e.to ? hm >= e.from && hm < e.to : hm >= e.from || hm < e.to; // across midnight
  if (!inTime) return false;
  if (e.days.all || e.days.irregular) return true;
  const wd = ((d.getUTCDay() + 6) % 7) + 1; // 1 = Monday
  return e.days.set.has(wd);
}
const fmtTime = (n) => String(n).padStart(4, '0');

// ---- airports -------------------------------------------------------------------------------------------------------
function csvRows(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const r = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') (r.push(cur), (cur = ''));
      else cur += c;
    }
    r.push(cur);
    rows.push(r);
  }
  return rows;
}
const km = (a, b, c, d) => {
  const R = 6371, toR = Math.PI / 180, dl = (c - a) * toR, dn = (d - b) * toR;
  const x = Math.sin(dl / 2) ** 2 + Math.cos(a * toR) * Math.cos(c * toR) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

// ---- fixed tables -----------------------------------------------------------------------------------------------------
const FIXED = [
  ...[[16, 156.8, 'Distress, safety and calling'], [9, 156.45, 'Recreational calling'], [6, 156.3, 'Ship-to-ship safety'], [13, 156.65, 'Bridge-to-bridge navigation'],
    [70, 156.525, 'DSC (digital selective calling)'], [12, 156.6, 'Port operations / Vessel Traffic Services'], [14, 156.7, 'Port operations / Vessel Traffic Services'],
    [11, 156.55, 'Vessel Traffic Services'], [68, 156.425, 'Recreational working'], [72, 156.625, 'Ship-to-ship'], ['22A', 157.1, 'Canadian Coast Guard liaison'],
    ['21B', 161.65, 'Continuous Marine Broadcast (Environment Canada weather)'], ['83B', 161.775, 'Continuous Marine Broadcast (Environment Canada weather)'],
    ['87B', 161.975, 'AIS 1 (ship positions, data)'], ['88B', 162.025, 'AIS 2 (ship positions, data)'], [10, 156.5, 'Commercial working'], [26, 161.9, 'Public correspondence (coast station)'],
    [24, 161.8, 'Public correspondence (coast station)'], [84, 161.825, 'Public correspondence (coast station)']]
    .map(([ch, mhz, what]) => ({ hz: Math.round(mhz * 1e6), name: `Marine ch ${ch}`, detail: what, source: 'marine', tol: 6000 })),
  ...[162.4, 162.425, 162.45, 162.475, 162.5, 162.525, 162.55].map((m, i) => ({ hz: Math.round(m * 1e6), name: `Weatheradio WX${i + 1}`, detail: 'Environment Canada Weatheradio / NOAA Weather Radio', source: 'weather', tol: 6000 })),
  { hz: 121.5e6, name: 'Air guard (emergency)', detail: 'International aeronautical emergency', source: 'air', tol: 5000 },
  { hz: 243e6, name: 'Military guard', detail: 'Military aeronautical emergency', source: 'air', tol: 5000 },
  { hz: 123.45e6, name: 'Air-to-air', detail: 'Pilot-to-pilot (North Atlantic)', source: 'air', tol: 5000 },
  { hz: 131.55e6, name: 'ACARS', detail: 'Aircraft datalink (Canada/US primary)', source: 'air', tol: 5000 },
  { hz: 1090e6, name: 'ADS-B', detail: 'Aircraft position broadcasts (decoded by your PiAware)', source: 'air', tol: 1e6 },
  { hz: 145.8e6, name: 'ISS voice / packet downlink', detail: 'International Space Station', source: 'space', tol: 5000 },
  { hz: 144.39e6, name: 'APRS (North America)', detail: 'Amateur packet position reports', source: 'ham', tol: 5000 },
  { hz: 146.52e6, name: '2 m FM national simplex', detail: 'Amateur calling frequency', source: 'ham', tol: 5000 },
  { hz: 446e6, name: '70 cm FM simplex calling', detail: 'Amateur calling frequency', source: 'ham', tol: 5000 },
  ...[[3.33, 'CHU Canada (Ottawa)'], [7.85, 'CHU Canada (Ottawa)'], [14.67, 'CHU Canada (Ottawa)']].map(([m, n]) => ({ hz: m * 1e6, name: n, detail: 'Time signal, NRC Canada', source: 'time', tol: 3000 })),
  ...[2.5, 5, 10, 15, 20, 25].map((m) => ({ hz: m * 1e6, name: 'WWV / WWVH', detail: 'Time signal, NIST (Fort Collins / Hawaii)', source: 'time', tol: 3000 })),
  ...[[2182, 'Marine MF distress'], [4125, 'Marine HF distress (voice)'], [6215, 'Marine HF distress (voice)'], [8291, 'Marine HF distress (voice)'], [12290, 'Marine HF distress (voice)'], [16420, 'Marine HF distress (voice)']]
    .map(([k, n]) => ({ hz: k * 1e3, name: n, detail: 'GMDSS', source: 'marine', tol: 1500 })),
  ...[[4271, 'CFH Halifax weather fax'], [6496.4, 'CFH Halifax weather fax'], [10536, 'CFH Halifax weather fax'], [13510, 'CFH Halifax weather fax']]
    .map(([k, n]) => ({ hz: k * 1e3, name: n, detail: 'Canadian Forces / marine weather charts (USB, tune 1.9 kHz low)', source: 'utility', tol: 3000 })),
];

// ---- the identifier -----------------------------------------------------------------------------------------------
class Ident {
  constructor(dataDir) {
    this.dir = dataDir;
    this.eibi = [];
    this.eibiSeason = null;
    this.air = [];
    this.load().catch((e) => log('load failed:', e.message));
    setInterval(() => this.load().catch(() => {}), 24 * 3600e3);
  }
  async fetchText(url, latin1) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 60000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Pi-SDR station identifier' } });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      const b = Buffer.from(await r.arrayBuffer());
      return latin1 ? b.toString('latin1') : b.toString('utf8');
    } finally {
      clearTimeout(t);
    }
  }
  async cached(name, url, maxAgeDays, latin1) {
    const f = path.join(this.dir, name);
    let st = null;
    try {
      st = fs.statSync(f);
    } catch (e) {}
    if (!st || Date.now() - st.mtimeMs > maxAgeDays * 86400e3) {
      try {
        const t = await this.fetchText(url, latin1);
        fs.writeFileSync(f, t);
        log('downloaded', name, `${(t.length / 1024).toFixed(0)} KB`);
        return t;
      } catch (e) {
        log('download failed', name, e.message);
        if (!st) throw e;
      }
    }
    return fs.readFileSync(f, 'utf8');
  }
  async load() {
    // EiBi: this season's file, else the previous season's (a new season's file appears a few days before it starts)
    const now = new Date();
    for (const s of [season(now), season(new Date(now - 30 * 86400e3)), season(new Date(+now + 30 * 86400e3))]) {
      try {
        const t = await this.cached(`eibi-${s}.csv`, `http://www.eibispace.de/dx/sked-${s}.csv`, 7, true);
        this.eibi = parseEibi(t);
        this.eibiSeason = s.toUpperCase();
        log(`EiBi ${this.eibiSeason}: ${this.eibi.length} entries`);
        break;
      } catch (e) {}
    }
    // airports near home
    try {
      const airF = path.join(this.dir, 'air-local.json');
      let ok = false;
      try {
        ok = Date.now() - fs.statSync(airF).mtimeMs < 30 * 86400e3;
      } catch (e) {}
      if (!ok) {
        const ap = csvRows(await this.fetchText('https://davidmegginson.github.io/ourairports-data/airports.csv'));
        const H = ap[0], ix = (k) => H.indexOf(k);
        const near = new Map();
        for (const r of ap.slice(1)) {
          const lat = Number(r[ix('latitude_deg')]), lon = Number(r[ix('longitude_deg')]);
          if (!Number.isFinite(lat)) continue;
          const d = km(HOME.lat, HOME.lon, lat, lon);
          if (d <= RADIUS_KM) near.set(r[ix('ident')], { name: r[ix('name')], km: Math.round(d), type: r[ix('type')] });
        }
        const fr = csvRows(await this.fetchText('https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv'));
        const F = fr[0], jx = (k) => F.indexOf(k);
        const list = [];
        for (const r of fr.slice(1)) {
          const a = near.get(r[jx('airport_ident')]);
          const mhz = Number(r[jx('frequency_mhz')]);
          if (!a || !(mhz > 0)) continue;
          list.push({ hz: Math.round(mhz * 1e6), name: `${r[jx('airport_ident')]} ${r[jx('description')] || r[jx('type')]}`.trim(), detail: `${a.name} (${a.km} km) · ${r[jx('type')]}`, source: 'air', tol: 5000, km: a.km });
        }
        fs.writeFileSync(airF, JSON.stringify(list));
        log(`airports: ${near.size} within ${RADIUS_KM} km, ${list.length} frequencies`);
      }
      this.air = JSON.parse(fs.readFileSync(airF, 'utf8'));
    } catch (e) {
      log('airports failed:', e.message);
    }
  }
  eibiItem(e, d) {
    const live = onAir(e, d);
    return {
      hz: Math.round(e.khz * 1000), name: e.station, source: 'eibi', onAir: live,
      detail: [LANG[e.lang] || e.lang, e.target && `to ${e.target}`, e.itu && `(${e.itu})`, `${fmtTime(e.from)}-${fmtTime(e.to)} UTC`, e.days.set ? `days ${[...e.days.set].join('')}` : e.days.irregular ? e.days.text : '', e.remarks && e.remarks.startsWith('/') ? `via ${e.remarks.slice(1)}` : '']
        .filter(Boolean).join(' · '),
      lang: e.lang, target: e.target, itu: e.itu, from: e.from, to: e.to,
    };
  }
  // Everything known at f (Hz): on-air first, then the rest of the schedule there, then fixed and airport entries.
  lookup(f, mode) {
    const d = new Date(), out = [];
    if (f < 30e6) {
      const tol = f < 1.8e6 ? 5000 : 2500;
      for (const e of this.eibi) if (Math.abs(e.khz * 1000 - f) <= tol) out.push(this.eibiItem(e, d));
      out.sort((a, b) => b.onAir - a.onAir || Math.abs(a.hz - f) - Math.abs(b.hz - f));
    }
    for (const x of [...FIXED, ...this.air]) if (Math.abs(x.hz - f) <= x.tol) out.push({ ...x, onAir: null });
    return out.slice(0, 40);
  }
  // On-air schedule entries (and fixed / airport entries) within a range, for spectrum labels and the On air list.
  range(a, b, all) {
    const d = new Date(), out = [];
    if (a < 30e6) for (const e of this.eibi) if (e.khz * 1000 >= a && e.khz * 1000 <= b && (all || onAir(e, d))) out.push(this.eibiItem(e, d));
    for (const x of [...FIXED, ...this.air]) if (x.hz >= a && x.hz <= b) out.push({ ...x, onAir: null });
    return out.sort((p, q) => p.hz - q.hz).slice(0, 3000);
  }
  info() {
    return { eibiSeason: this.eibiSeason, eibi: this.eibi.length, air: this.air.length, home: HOME, radiusKm: RADIUS_KM };
  }
}
module.exports = { Ident, season, parseDays, onAir };
