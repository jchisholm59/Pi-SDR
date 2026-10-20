// Ham decoders fed with the engine's 48 kHz audio:
//   ft8 / ft4  15 s (7.5 s) UTC slots, resampled to 12 kHz and handed to ft8_lib's decode_ft8 (FT8_DECODER);
//              messages parsed for calls and grids, with distance and bearing from home.
//   cw         Morse to text in Node: tone search 300-1200 Hz, Goertzel envelope, adaptive threshold, timing with a
//              self-adjusting dot length (WPM estimate).
//   aprs       AFSK1200 packets through multimon-ng (resampled to 22.05 kHz); positions decoded (plain, compressed
//              and Mic-E latitude/longitude) where present.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const FT8_DECODER = process.env.FT8_DECODER || path.join(os.homedir(), 'ft8_lib', 'decode_ft8');
const MULTIMON = process.env.MULTIMON || 'multimon-ng';

// ---- geography --------------------------------------------------------------------------------------------------
function gridToLatLon(g) {
  g = String(g || '').toUpperCase();
  if (!/^[A-R]{2}\d{2}([A-X]{2})?$/.test(g)) return null;
  let lon = (g.charCodeAt(0) - 65) * 20 - 180 + Number(g[2]) * 2;
  let lat = (g.charCodeAt(1) - 65) * 10 - 90 + Number(g[3]);
  if (g.length === 6) {
    lon += (g.charCodeAt(4) - 65) * (2 / 24) + 1 / 24;
    lat += (g.charCodeAt(5) - 65) * (1 / 24) + 1 / 48;
  } else {
    lon += 1;
    lat += 0.5;
  }
  return { lat, lon };
}
function distBearing(a, b) {
  const r = Math.PI / 180, R = 6371;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(x));
  const y = Math.sin(dLon) * Math.cos(b.lat * r), z = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos(dLon);
  return { km: Math.round(km), brg: Math.round(((Math.atan2(y, z) / r) + 360) % 360) };
}
// Callsign prefix -> country (the common ones; longest prefix wins).
const PREFIXES = {
  VE: 'Canada', VA: 'Canada', VO: 'Canada (NL)', VY: 'Canada', CY: 'Canada', CF: 'Canada', XM: 'Canada',
  K: 'USA', W: 'USA', N: 'USA', AA: 'USA', AB: 'USA', AC: 'USA', AD: 'USA', AE: 'USA', AF: 'USA', AG: 'USA', AI: 'USA', AJ: 'USA', AK: 'USA',
  KH6: 'Hawaii', KL7: 'Alaska', KP4: 'Puerto Rico', NP4: 'Puerto Rico', WP4: 'Puerto Rico', XE: 'Mexico', XF: 'Mexico',
  G: 'England', M: 'England', '2E': 'England', GM: 'Scotland', MM: 'Scotland', GW: 'Wales', MW: 'Wales', GI: 'N. Ireland', MI: 'N. Ireland', EI: 'Ireland',
  F: 'France', DL: 'Germany', DA: 'Germany', DB: 'Germany', DC: 'Germany', DD: 'Germany', DF: 'Germany', DG: 'Germany', DH: 'Germany', DJ: 'Germany', DK: 'Germany', DM: 'Germany', DO: 'Germany',
  I: 'Italy', IK: 'Italy', IZ: 'Italy', EA: 'Spain', EB: 'Spain', EC: 'Spain', CT: 'Portugal', CU: 'Azores', PA: 'Netherlands', PD: 'Netherlands', PE: 'Netherlands', ON: 'Belgium',
  OZ: 'Denmark', LA: 'Norway', SM: 'Sweden', SA: 'Sweden', OH: 'Finland', TF: 'Iceland', OY: 'Faroe Is.', OE: 'Austria', HB: 'Switzerland', HB9: 'Switzerland',
  SP: 'Poland', SQ: 'Poland', SO: 'Poland', OK: 'Czechia', OL: 'Czechia', OM: 'Slovakia', HA: 'Hungary', HG: 'Hungary', YO: 'Romania', LZ: 'Bulgaria', SV: 'Greece', '9A': 'Croatia', S5: 'Slovenia',
  YU: 'Serbia', UA: 'Russia', RA: 'Russia', R: 'Russia', UR: 'Ukraine', UT: 'Ukraine', US: 'Ukraine', LY: 'Lithuania', YL: 'Latvia', ES: 'Estonia', EU: 'Belarus', TA: 'Türkiye', '4X': 'Israel',
  JA: 'Japan', JH: 'Japan', JR: 'Japan', JE: 'Japan', JF: 'Japan', JG: 'Japan', JI: 'Japan', JJ: 'Japan', JK: 'Japan', JL: 'Japan', JM: 'Japan', JN: 'Japan', JO: 'Japan', '7K': 'Japan', '7L': 'Japan', '7M': 'Japan', '7N': 'Japan',
  BY: 'China', BG: 'China', BH: 'China', BD: 'China', HL: 'South Korea', DS: 'South Korea', VU: 'India', VK: 'Australia', ZL: 'New Zealand', '9V': 'Singapore', '9M': 'Malaysia', YB: 'Indonesia', DU: 'Philippines', HS: 'Thailand',
  PY: 'Brazil', PU: 'Brazil', PT: 'Brazil', PP: 'Brazil', LU: 'Argentina', CE: 'Chile', CX: 'Uruguay', OA: 'Peru', HK: 'Colombia', YV: 'Venezuela', HC: 'Ecuador', CP: 'Bolivia', ZP: 'Paraguay',
  CO: 'Cuba', CM: 'Cuba', HI: 'Dominican Rep.', HH: 'Haiti', '6Y': 'Jamaica', VP9: 'Bermuda', C6: 'Bahamas', FG: 'Guadeloupe', FM: 'Martinique', PJ: 'Neth. Antilles', '8P': 'Barbados', '9Y': 'Trinidad', J6: 'St Lucia', V2: 'Antigua', TI: 'Costa Rica', YN: 'Nicaragua', HR: 'Honduras', TG: 'Guatemala', YS: 'El Salvador', HP: 'Panama',
  ZS: 'South Africa', '5H': 'Tanzania', '5Z': 'Kenya', '5N': 'Nigeria', SU: 'Egypt', CN: 'Morocco', '7X': 'Algeria', '3V': 'Tunisia', EA8: 'Canary Is.', D4: 'Cape Verde', '9G': 'Ghana', ZD8: 'Ascension', ZD7: 'St Helena',
  A6: 'UAE', A7: 'Qatar', A9: 'Bahrain', HZ: 'Saudi Arabia', '4L': 'Georgia', EK: 'Armenia', '4J': 'Azerbaijan', UN: 'Kazakhstan', EX: 'Kyrgyzstan', AP: 'Pakistan', '4S': 'Sri Lanka', FP: 'St Pierre & Miquelon', OX: 'Greenland',
};
function country(call) {
  const c = String(call || '').toUpperCase().replace(/^[A-Z0-9]+\//, (m) => (m.length <= 4 ? m : '')).replace(/\/.*$/, '');
  for (let n = Math.min(4, c.length); n > 0; n--) if (PREFIXES[c.slice(0, n)]) return PREFIXES[c.slice(0, n)];
  return '';
}
const isCall = (s) => /^(?=.*\d)[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z](\/[A-Z0-9]+)?$/.test(s) || /^<.*>$/.test(s);
const isGrid = (s) => /^[A-R]{2}\d{2}$/.test(s) && s !== 'RR73';

// ---- FT8 / FT4 ----------------------------------------------------------------------------------------------------
class Ft8 {
  constructor(ctx, ft4) {
    this.ctx = ctx;
    this.ft4 = ft4;
    this.slot = ft4 ? 7.5 : 15;
    this.buf = [];       // [{t (ms, time of first sample), s: Int16Array at 12 kHz}]
    this.prev = 0;       // decimator state
    this.lp = new Float32Array(31);
    this.h = (() => { // 31-tap lowpass, cutoff 4.5 kHz at 48 kHz
      const h = [], m = 15, fc = 4500 / 48000;
      let sum = 0;
      for (let i = 0; i < 31; i++) {
        const x = i - m, s = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x), w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / 30);
        h.push(s * w);
        sum += s * w;
      }
      return h.map((v) => v / sum);
    })();
    this.phase = 0;
    this.timer = setInterval(() => this.tick(), 250);
    this.lastSlot = Math.floor(Date.now() / 1000 / this.slot);
    this.busy = false;
  }
  stop() {
    clearInterval(this.timer);
  }
  feed(pcm, ch) {
    // the newest sample is "now" (the engine pipeline adds well under FT8's +-2 s DT tolerance)
    const n = pcm.length / ch, out = new Int16Array(Math.ceil(n / 4) + 1);
    let k = 0;
    for (let i = 0; i < n; i++) {
      this.lp.copyWithin(0, 1);
      this.lp[30] = pcm[i * ch];
      if (++this.phase === 4) {
        this.phase = 0;
        let s = 0;
        for (let j = 0; j < 31; j++) s += this.h[j] * this.lp[j];
        out[k++] = Math.max(-32767, Math.min(32767, s));
      }
    }
    const s = out.subarray(0, k);
    this.buf.push({ t: Date.now() - (s.length / 12000) * 1000, s });
    // keep ~2 slots
    while (this.buf.length && this.buf[0].t < Date.now() - this.slot * 2500) this.buf.shift();
  }
  tick() {
    const slot = Math.floor(Date.now() / 1000 / this.slot);
    if (slot === this.lastSlot) return;
    const start = this.lastSlot * this.slot * 1000;
    this.lastSlot = slot;
    // wait a moment for the slot's last audio, then decode it
    setTimeout(() => this.decode(start), 400);
  }
  decode(start) {
    const end = start + this.slot * 1000, N = Math.round(this.slot * 12000), samples = new Int16Array(N);
    let have = 0;
    for (const c of this.buf) {
      const off = Math.round(((c.t - start) / 1000) * 12000);
      for (let i = 0; i < c.s.length; i++) {
        const j = off + i;
        if (j >= 0 && j < N) (samples[j] = c.s[i]), have++;
      }
    }
    if (have < N * 0.6 || this.busy) return; // retuned or paused mid-slot
    const f = path.join(os.tmpdir(), `pisdr-${this.ft4 ? 'ft4' : 'ft8'}-${start}.wav`);
    fs.writeFileSync(f, wav(samples, 12000));
    this.busy = true;
    execFile(FT8_DECODER, this.ft4 ? ['-ft4', f] : [f], { timeout: 12000 }, (err, stdout) => {
      this.busy = false;
      fs.unlink(f, () => {});
      if (err && !stdout) return this.ctx.log('ft8 decoder:', err.message);
      const msgs = [];
      for (const line of String(stdout).split('\n')) {
        const m = /^\d{6}\s+([+-]?\d+\.\d)\s+([+-]?\d+\.\d+)\s+(\d+)\s+~\s+(.+)$/.exec(line.trim());
        if (m) msgs.push(this.parse({ t: start, snr: Number(m[1]), dt: Number(m[2]), df: Number(m[3]), msg: m[4].trim() }));
      }
      this.ctx.emit({ type: 'decode', mode: this.ft4 ? 'ft4' : 'ft8', slot: start, dial: this.ctx.freq(), items: msgs });
    });
  }
  parse(d) {
    const w = d.msg.split(/\s+/);
    let from = '', to = '', grid = '', cq = false;
    if (w[0] === 'CQ') {
      cq = true;
      const i = isCall(w[1]) ? 1 : 2; // "CQ DX K1ABC FN42"
      from = w[i] || '';
      if (isGrid(w[i + 1])) grid = w[i + 1];
    } else {
      to = w[0];
      from = w[1] || '';
      if (isGrid(w[2])) grid = w[2];
    }
    from = from.replace(/[<>]/g, '');
    const out = { ...d, from, to, cq, grid, country: country(from) };
    const ll = gridToLatLon(grid);
    if (ll) Object.assign(out, distBearing(this.ctx.home, ll));
    return out;
  }
}
function wav(samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2).copy(b, 44);
  return b;
}

// ---- CW -----------------------------------------------------------------------------------------------------------
const MORSE = {
  '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E', '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J', '-.-': 'K', '.-..': 'L', '--': 'M',
  '-.': 'N', '---': 'O', '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T', '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y', '--..': 'Z',
  '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4', '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9',
  '.-.-.-': '.', '--..--': ',', '..--..': '?', '-..-.': '/', '-...-': '=', '.-.-.': '+', '-....-': '-', '.--.-.': '@', '---...': ':', '-.--.': '(', '-.--.-': ')',
  '...-.-': '<SK>', '-.-.-': '<KA>', '.-...': '<AS>', '...---...': '<SOS>', '........': '<HH>',
};
class Cw {
  constructor(ctx) {
    this.ctx = ctx;
    this.rate = 48000;
    this.blk = 240; // 5 ms
    this.acc = [];
    this.freq = 700;
    this.search = [];
    this.on = false;
    this.run = 0;      // blocks in the current state
    this.dot = 12;     // dot length in blocks (60 ms = 20 WPM)
    this.sym = '';
    this.text = '';
    this.noise = 1e-6;
    this.peak = 1e-3;
    this.wordSent = true;
    this.pending = '';
    this.timer = setInterval(() => this.flush(), 400);
  }
  stop() {
    clearInterval(this.timer);
  }
  goertzel(x, f) {
    const w = (2 * Math.PI * f) / this.rate, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i++) {
      const s = x[i] + c * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    return (s1 * s1 + s2 * s2 - c * s1 * s2) / (x.length * x.length);
  }
  feed(pcm, ch) {
    for (let i = 0; i < pcm.length; i += ch) this.acc.push(pcm[i] / 32768);
    // tone search every ~0.5 s over 1024 samples
    this.search.push(...this.acc.slice(-Math.min(this.acc.length, 2048)));
    if (this.search.length > 24000) {
      const x = this.search.slice(-2048);
      let best = this.freq, bp = 0;
      for (let f = 300; f <= 1200; f += 20) {
        const p = this.goertzel(x, f);
        if (p > bp) (bp = p), (best = f);
      }
      if (bp > this.noise * 8) this.freq += (best - this.freq) * 0.5;
      this.search = [];
    }
    while (this.acc.length >= this.blk) {
      const b = this.acc.splice(0, this.blk);
      this.block(this.goertzel(b, this.freq));
    }
  }
  block(p) {
    // envelope trackers: noise follows the quiet level, peak the keyed level
    if (p < this.noise * 3) this.noise += (p - this.noise) * 0.05;
    else this.noise *= 1.002;
    if (p > this.peak) this.peak += (p - this.peak) * 0.3;
    else this.peak *= 0.9995;
    const snr = this.peak / Math.max(this.noise, 1e-12);
    const thr = this.noise + (this.peak - this.noise) * (this.on ? 0.35 : 0.5);
    const key = snr > 6 && p > thr;
    if (key === this.on) {
      this.run++;
      if (!this.on) this.gap(this.run, false);
      return;
    }
    // state change: classify what just ended
    if (this.on) this.mark(this.run);
    else this.gap(this.run, true);
    this.on = key;
    this.run = 1;
  }
  mark(n) {
    if (n < 2) return; // glitch
    if (n < this.dot * 2) {
      this.sym += '.';
      this.dot += (n - this.dot) * 0.15;
    } else {
      this.sym += '-';
      this.dot += (n / 3 - this.dot) * 0.15;
    }
    this.dot = Math.max(4, Math.min(60, this.dot)); // 4..60 blocks = 60..4 WPM
    this.wordSent = false;
  }
  gap(n, ended) {
    // called for a finished gap (ended) and while a gap grows
    if (this.sym && n >= this.dot * 2.2) {
      this.pending += MORSE[this.sym] || '*';
      this.sym = '';
    }
    if (!this.wordSent && !this.sym && n >= this.dot * 5.5) {
      this.pending += ' ';
      this.wordSent = true;
    }
  }
  flush() {
    if (!this.pending) return;
    this.text = (this.text + this.pending).slice(-2000);
    this.ctx.emit({ type: 'decode', mode: 'cw', add: this.pending, wpm: Math.round(1200 / (this.dot * 5)), tone: Math.round(this.freq) });
    this.pending = '';
  }
}

// ---- APRS -----------------------------------------------------------------------------------------------------------
class Aprs {
  constructor(ctx) {
    this.ctx = ctx;
    this.pos = 0;
    this.proc = spawn(MULTIMON, ['-t', 'raw', '-a', 'AFSK1200', '-A', '-q', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc.on('error', (e) => ctx.log('multimon-ng:', e.message));
    this.proc.stdin.on('error', () => {});
    let rest = '';
    this.proc.stdout.on('data', (d) => {
      rest += d;
      const lines = rest.split('\n');
      rest = lines.pop();
      for (const l of lines) this.line(l.trim());
    });
  }
  stop() {
    try {
      this.proc.kill();
    } catch (e) {}
  }
  feed(pcm, ch) {
    // 48 kHz -> 22.05 kHz by linear interpolation (the AFSK tones are 1.2 and 2.2 kHz)
    const step = 48000 / 22050, n = pcm.length / ch, out = [];
    for (; this.pos < n - 1; this.pos += step) {
      const i = Math.floor(this.pos), f = this.pos - i;
      out.push(pcm[i * ch] * (1 - f) + pcm[(i + 1) * ch] * f);
    }
    this.pos -= n;
    if (out.length && this.proc.stdin.writable) this.proc.stdin.write(Buffer.from(Int16Array.from(out).buffer));
  }
  line(l) {
    const m = /^APRS: ([^>]+)>([^,:]+)([^:]*):(.*)$/.exec(l);
    if (!m) return;
    // the same packet again within 30 s is a digipeater's copy: skip it
    const key = m[1] + '|' + m[4], now = Date.now();
    this.seen = this.seen || new Map();
    for (const [k, t] of this.seen) if (now - t > 30000) this.seen.delete(k);
    if (this.seen.has(key)) return;
    this.seen.set(key, now);
    const p = { t: now, from: m[1], to: m[2], path: m[3].replace(/^,/, ''), info: m[4] };
    Object.assign(p, aprsPosition(p));
    if (p.lat != null) Object.assign(p, distBearing(this.ctx.home, p));
    p.country = country(p.from);
    this.ctx.emit({ type: 'decode', mode: 'aprs', items: [p] });
  }
}
// Positions: uncompressed "!4439.12N/06349.78W>comment", compressed, timestamped variants and Mic-E.
function aprsPosition(p) {
  let s = p.info;
  const dti = s[0];
  if ('!=/@'.includes(dti)) {
    s = dti === '/' || dti === '@' ? s.slice(8) : s.slice(1);
    const u = /^(\d{2})(\d{2}\.\d{2})([NS])(.)(\d{3})(\d{2}\.\d{2})([EW])(.)(.*)$/.exec(s);
    if (u) {
      const lat = (Number(u[1]) + Number(u[2]) / 60) * (u[3] === 'S' ? -1 : 1), lon = (Number(u[5]) + Number(u[6]) / 60) * (u[7] === 'W' ? -1 : 1);
      return { lat, lon, symbol: u[4] + u[8], comment: u[9].trim(), kind: 'position' };
    }
    if (/^[\/\\A-Za-j][\x21-\x7b]{8}/.test(s)) {
      const b91 = (t) => [...t].reduce((a, c) => a * 91 + c.charCodeAt(0) - 33, 0);
      return { lat: 90 - b91(s.slice(1, 5)) / 380926, lon: -180 + b91(s.slice(5, 9)) / 190463, symbol: s[0] + s[9], comment: s.slice(13).trim(), kind: 'position' };
    }
  }
  if ((dti === '`' || dti === "'") && p.to.length >= 6) {
    // Mic-E: latitude digits and N/S, longitude offset and W/E are in the destination field
    const d = p.to.slice(0, 6), dig = [...d].map((c) => (/[0-9]/.test(c) ? +c : /[A-J]/.test(c) ? c.charCodeAt(0) - 65 : /[P-Y]/.test(c) ? c.charCodeAt(0) - 80 : /[KLZ]/.test(c) ? 0 : 0));
    const lat = (dig[0] * 10 + dig[1] + (dig[2] * 10 + dig[3] + (dig[4] * 10 + dig[5]) / 100) / 60) * (/[P-Z]/.test(d[3]) ? 1 : -1);
    const info = p.info;
    let lonDeg = info.charCodeAt(1) - 28;
    if (/[P-Z]/.test(d[4])) lonDeg += 100;
    if (lonDeg >= 180 && lonDeg <= 189) lonDeg -= 80;
    else if (lonDeg >= 190 && lonDeg <= 199) lonDeg -= 190;
    let lonMin = info.charCodeAt(2) - 28;
    if (lonMin >= 60) lonMin -= 60;
    const lonHun = info.charCodeAt(3) - 28;
    const lon = (lonDeg + (lonMin + lonHun / 100) / 60) * (/[P-Z]/.test(d[5]) ? -1 : 1);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon, symbol: info[8] + info[7], comment: micEComment(info.slice(9)), kind: 'Mic-E' };
  }
  if (dti === '>') return { kind: 'status', comment: s.slice(1) };
  if (dti === ':') return { kind: 'message', comment: s.slice(1) };
  if (dti === '_') return { kind: 'weather', comment: s.slice(1) };
  return { kind: 'other', comment: s };
}

// Mic-E comment: optional altitude ("xxx}" in base 91, metres + 10000) and a radio-model code at either end.
const MICE_RADIOS = { '_%': 'Yaesu FTM-400', '_)': 'Yaesu FTM-100', '_"': 'Yaesu FTM-350', '_#': 'Yaesu VX-8G', '_$': 'Yaesu FT1D', '_(': 'Yaesu FT2D', '_0': 'Yaesu FT3D', '_3': 'Yaesu FT5D', '_1': 'Yaesu FTM-300', '_5': 'Yaesu FTM-500',
  ']=': 'Kenwood TM-D710', ']': 'Kenwood TM-D700', '>=': 'Kenwood TH-D72', '>^': 'Kenwood TH-D74', '>&': 'Kenwood TH-D75', '>': 'Kenwood TH-D7' };
function micEComment(c) {
  let s = c.replace(/^[`' ]/, ''), extra = [];
  const alt = /^(.{3})\}/.exec(s);
  if (alt) {
    const m = [...alt[1]].reduce((a, ch) => a * 91 + ch.charCodeAt(0) - 33, 0) - 10000;
    extra.push(`${m} m`);
    s = s.slice(4);
  }
  for (const k of Object.keys(MICE_RADIOS).sort((a, b) => b.length - a.length)) {
    if (s.endsWith(k)) {
      extra.push(MICE_RADIOS[k]);
      s = s.slice(0, -k.length);
      break;
    }
  }
  return [s.trim(), ...extra].filter(Boolean).join(' · ');
}

// ---- manager --------------------------------------------------------------------------------------------------------
class Decoders {
  // ctx: { log, emit(obj), freq() -> Hz, home: {lat, lon} }
  constructor(ctx) {
    this.ctx = ctx;
    this.mode = 'off';
    this.d = null;
    // decode history, kept across restarts in DATA_DIR/decodes.json
    this.file = ctx.dataDir && path.join(ctx.dataDir, 'decodes.json');
    this.history = { ft8: [], ft4: [], cw: '', aprs: [] };
    try {
      Object.assign(this.history, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (e) {}
    const emit = ctx.emit;
    ctx.emit = (o) => {
      if (o.mode === 'cw') this.history.cw = (this.history.cw + o.add).slice(-3000);
      else if (o.items) this.history[o.mode] = [...o.items.slice().reverse(), ...this.history[o.mode]].slice(0, 500);
      clearTimeout(this.saveTimer);
      if (this.file) this.saveTimer = setTimeout(() => fs.writeFile(this.file, JSON.stringify(this.history), () => {}), 3000);
      emit(o);
    };
  }
  available() {
    return { ft8: fs.existsSync(FT8_DECODER), aprs: true, cw: true };
  }
  start(mode) {
    this.stop();
    this.mode = mode;
    if (mode === 'ft8' || mode === 'ft4') this.d = new Ft8(this.ctx, mode === 'ft4');
    else if (mode === 'cw') this.d = new Cw(this.ctx);
    else if (mode === 'aprs') this.d = new Aprs(this.ctx);
    else this.mode = 'off';
  }
  stop() {
    this.d?.stop();
    this.d = null;
    this.mode = 'off';
  }
  feed(pcm, ch) {
    this.d?.feed(pcm, ch);
  }
  info() {
    return { mode: this.mode, available: this.available() };
  }
}
module.exports = { Decoders, gridToLatLon, distBearing, country, aprsPosition, Cw };
