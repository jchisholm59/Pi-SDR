// Pi-SDR server: runs sdr-engine (the RSPduo and all the DSP), shares one radio between any number of browsers over a
// WebSocket (spectrum, audio, RDS, status), keeps memories and FM favourites, and runs the scanners:
//   search     sweep a range, list the active channels (save them to memories)
//   scan       classic scanner: step through channels (a range, a memory group or the last search), stop on signals
//   fm         FM broadcast band: sweep, snap to the channel grid, identify each station by RDS
// Config: PORT (8073), DATA_DIR (./data), ENGINE (./engine/sdr-engine).
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { Ident } = require('./ident');
const { Decoders } = require('./decoders');

const PORT = Number(process.env.PORT) || 8073;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ENGINE = process.env.ENGINE || path.join(__dirname, 'engine', 'sdr-engine');
fs.mkdirSync(DATA_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), ...a);
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
  } catch (e) {
    return d;
  }
};
const writeJson = (f, v) => {
  const p = path.join(DATA_DIR, f);
  fs.writeFileSync(p + '.tmp', JSON.stringify(v, null, 1));
  fs.renameSync(p + '.tmp', p);
};

// ---- radio state (persisted) --------------------------------------------------------------------------------------
const MODE_BW = { wfm: 180000, nfm: 12500, am: 10000, usb: 2700, lsb: 2700, cw: 500 };
const DEFAULT = {
  freq: 101300000, lo: 101000000, mode: 'wfm', bw: 180000, sq: null, stereo: true, deemph: 75e-6,
  lna: 4, gr: 40, lnaAuto: true, lnaByTuner: { A: 4, B: 0 }, // lnaAuto: step the LNA state up (less gain) while the RSPduo reports overload agc: true, agcSet: -30, tuner: 'A', hiz: false, fmNotch: false, dabNotch: false, amNotch: false,
  biasT: false, ppm: 0, fs: 2400000,
  // Auto antenna: below antSplit the MLA-30 active loop on tuner 2, above it the multiband antenna on tuner 1. The
  // loop has its own external bias injector, so the RSPduo's bias-T stays off.
  antAuto: true, antSplit: 30e6, fftN: 4096, fps: 20, cwPitch: 700, step: 100000, fmGrid: 'na',
  modeBw: {}, // remembered bandwidth per mode
  modeSq: {}, // remembered squelch per mode
};
let state = { ...DEFAULT, ...readJson('state.json', {}) };
let saveTimer = null;
const saveState = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson('state.json', state), 1000);
};
let memories = readJson('memories.json', []); // [{id, name, freq, mode, bw, group, sq, tuner, hiz, note, lockout}]
let fm = readJson('fm.json', { stations: [], scanned: 0 }); // stations: [{freq, level, snr, pi, ps, pty, rt, fav, name}]
let lastSearch = readJson('search.json', null);
let hits = readJson('hits.json', []); // scanner log
const ident = new Ident(DATA_DIR);
const HOME = { lat: Number(process.env.HOME_LAT) || 44.65, lon: Number(process.env.HOME_LON) || -63.83 };
// ---- recordings: audio (WAV, what you hear) and IQ (the whole captured span, replayable) ---------------------------
const REC_DIR = path.join(DATA_DIR, 'recordings');
fs.mkdirSync(REC_DIR, { recursive: true });
const recs = {
  audio: null, // {fd, file, ch, samples, meta}
  iq: null, // {file, meta} while the engine records
  list() {
    const out = [];
    for (const f of fs.readdirSync(REC_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(REC_DIR, f), 'utf8'));
        const st = fs.statSync(path.join(REC_DIR, m.file));
        out.push({ ...m, size: st.size });
      } catch (e) {}
    }
    return out.sort((a, b) => b.t - a.t);
  },
  free() {
    try {
      const st = fs.statfsSync(REC_DIR);
      return st.bavail * st.bsize;
    } catch (e) {
      return Infinity;
    }
  },
  name(kind) {
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
    return `${kind}-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${(state.freq / 1e6).toFixed(4)}MHz-${state.mode}`;
  },
  meta(kind, file) {
    return { kind, file, t: Date.now(), freq: state.freq, mode: state.mode, bw: state.bw, lo: state.lo, fs: state.fs, ps: rds?.freq === state.freq ? (rds.ps || '').trim() : '', band: '' };
  },
  startAudio() {
    if (this.audio) return;
    if (this.free() < 1e9) throw new Error('less than 1 GB free on the Pi');
    const base = this.name('audio'), file = base + '.wav';
    const fd = fs.openSync(path.join(REC_DIR, file), 'w');
    fs.writeSync(fd, Buffer.alloc(44)); // header written on stop
    this.audio = { fd, file, base, samples: 0, meta: this.meta('audio', file) };
    updateAudioFlag();
  },
  feedAudio(pcm, ch) {
    const a = this.audio;
    if (!a) return;
    // always stereo in the file (mono modes duplicated)
    const n = pcm.length / ch, out = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      out.writeInt16LE(pcm[i * ch], i * 4);
      out.writeInt16LE(pcm[i * ch + (ch - 1)], i * 4 + 2);
    }
    fs.writeSync(a.fd, out);
    a.samples += n;
  },
  stopAudio() {
    const a = this.audio;
    if (!a) return null;
    this.audio = null;
    const h = Buffer.alloc(44), bytes = a.samples * 4;
    h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
    h.writeUInt32LE(48000, 24); h.writeUInt32LE(48000 * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(bytes, 40);
    fs.writeSync(a.fd, h, 0, 44, 0);
    fs.closeSync(a.fd);
    const meta = { ...a.meta, dur: a.samples / 48000 };
    fs.writeFileSync(path.join(REC_DIR, a.base + '.json'), JSON.stringify(meta));
    updateAudioFlag();
    return meta;
  },
  startIq(maxSec) {
    if (this.iq || playback) return;
    const sec = Math.max(5, Math.min(3600, Number(maxSec) || 300));
    const need = sec * state.fs * 4;
    if (this.free() < need + 2e9) throw new Error(`not enough space for ${sec} s (${(need / 1e9).toFixed(1)} GB needed)`);
    const base = this.name('iq'), file = base + '.iq';
    this.iq = { base, file, meta: this.meta('iq', file) };
    send({ cmd: 'iqRecStart', path: path.join(REC_DIR, file), maxSec: sec });
  },
  stopIq() {
    if (this.iq) send({ cmd: 'iqRecStop' });
  },
  onEngine(j) {
    // engine finished an IQ recording (stopped by us, by the length limit, or by playback starting)
    if (j.state !== 'stopped' || !this.iq) return;
    const meta = { ...this.iq.meta, samples: j.samples, fs: j.fs, events: j.events, dur: j.samples / j.fs };
    fs.writeFileSync(path.join(REC_DIR, this.iq.base + '.json'), JSON.stringify(meta));
    this.iq = null;
    broadcastJson({ type: 'recordings', list: this.list() });
    broadcastState();
  },
  remove(file) {
    if (!/^[\w.-]+$/.test(file) || this.audio?.file === file || this.iq?.file === file || playback?.file === file) return false;
    const base = file.replace(/\.(wav|iq)$/, '');
    for (const f of [file, base + '.json']) fs.rmSync(path.join(REC_DIR, f), { force: true });
    return true;
  },
};
// IQ playback: the engine reads a recording instead of the RSPduo; tuning moves only the listening point inside it.
let playback = null; // {file, meta, saved: {lo, fs, freq}}
function startPlayback(file, at) {
  const meta = recs.list().find((r) => r.file === file && r.kind === 'iq');
  if (!meta) throw new Error('no such IQ recording');
  scanner.stop();
  if (playback) send({ cmd: 'playStop' });
  const saved = playback?.saved || { lo: state.lo, fs: state.fs, freq: state.freq };
  playback = { file, meta, saved };
  state.lo = Number(String(meta.events || '').split(',')[0].split(':')[1]) || meta.lo;
  state.fs = meta.fs;
  send({ cmd: 'play', path: path.join(REC_DIR, file), fs: meta.fs, events: meta.events || `0:${meta.lo}`, samples: meta.samples, at: at || 0, loop: false });
  if (meta.mode && meta.mode !== state.mode) setMode(meta.mode, meta.bw);
  tune(meta.freq);
  broadcastState();
}
function stopPlayback() {
  if (!playback) return;
  const { saved } = playback;
  playback = null;
  state.lo = saved.lo;
  state.fs = saved.fs;
  send({ cmd: 'playStop', lo: saved.lo, fs: saved.fs });
  tune(saved.freq);
  broadcastState();
}

const decoders = new Decoders({ log: (...a) => log(...a), emit: (o) => broadcastJson(o), freq: () => state.freq, home: HOME, dataDir: DATA_DIR });
let identTimer = null;
function sendIdent(target) {
  const items = ident.lookup(state.freq, state.mode).slice(0, 12);
  const msg = JSON.stringify({ type: 'ident', freq: state.freq, items });
  if (target) target.send(msg);
  else for (const c of clients) if (c.ws.readyState === 1) c.ws.send(msg);
}

// ---- engine ---------------------------------------------------------------------------------------------------------
let engine = null, engineBuf = Buffer.alloc(0), engineUp = false, restartTimer = null, stopping = false;
let status = {}, rds = null, device = null, lastSpectrum = null;
const sweepWaiters = new Map(); // id -> {resolve, reject, onProgress}

function engineSettings() {
  const s = state;
  return {
    cmd: 'set', lo: s.lo, vfo: s.freq - s.lo, mode: s.mode, bw: s.bw, sq: s.sq, stereo: s.stereo, deemph: s.deemph,
    lna: s.lna, gr: s.gr, agc: s.agc, agcSet: s.agcSet, tuner: s.tuner, hiz: s.hiz, fmNotch: s.fmNotch,
    dabNotch: s.dabNotch, amNotch: s.amNotch, biasT: s.biasT, ppm: s.ppm, fs: s.fs, fftN: s.fftN, fps: s.fps,
    cwPitch: s.cwPitch, audio: listeners() > 0 || decoders.mode !== 'off',
  };
}
function send(obj) {
  if (engine && engineUp) engine.stdin.write(JSON.stringify(obj) + '\n');
}
function startEngine() {
  if (!fs.existsSync(ENGINE)) {
    log('engine binary missing:', ENGINE, '(run make in engine/)');
    return;
  }
  engine = spawn(ENGINE, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  engineUp = true;
  engineBuf = Buffer.alloc(0);
  engine.stdin.on('error', () => {});
  send(engineSettings());
  engine.stdout.on('data', onEngineData);
  engine.on('exit', (code, sig) => {
    engineUp = false;
    engine = null;
    log('engine exited', code, sig || '');
    broadcastJson({ type: 'engine', up: false, code });
    for (const [, w] of sweepWaiters) w.reject(new Error('engine stopped'));
    sweepWaiters.clear();
    if (!stopping) restartTimer = setTimeout(startEngine, code === 1 ? 5000 : 1500);
  });
  log('engine started');
}
function onEngineData(chunk) {
  engineBuf = engineBuf.length ? Buffer.concat([engineBuf, chunk]) : chunk;
  let off = 0;
  while (engineBuf.length - off >= 5) {
    const len = engineBuf.readUInt32LE(off);
    if (engineBuf.length - off - 4 < len) break;
    const type = engineBuf[off + 4];
    const payload = engineBuf.subarray(off + 5, off + 4 + len);
    off += 4 + len;
    if (type === 1) onSpectrum(payload);
    else if (type === 2) onAudio(payload);
    else if (type === 3) onJson(payload.toString());
  }
  engineBuf = off ? engineBuf.subarray(off) : engineBuf;
}
function onJson(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    return;
  }
  if (j.type === 'status') {
    status = j;
    scanner.onStatus(j);
    autoLna(j);
  } else if (j.type === 'rds') {
    rds = { ...j, freq: state.freq, t: Date.now() };
    fmIdent.onRds(rds);
    j = rds;
  } else if (j.type === 'iqrec') {
    recs.onEngine(j);
  } else if (j.type === 'playEnd') {
    stopPlayback();
  } else if (j.type === 'device') {
    device = j;
    deviceReady();
  }
  else if (j.type === 'log') log('engine', j.level + ':', j.msg);
  else if (j.type === 'sweep') {
    const w = sweepWaiters.get(j.id);
    if (w) {
      sweepWaiters.delete(j.id);
      j.cancelled ? w.reject(new Error(j.restart ? 'restart' : 'cancelled')) : w.resolve(j);
    }
    return; // big; the scanners report their own results
  } else if (j.type === 'sweepProgress') {
    sweepWaiters.get(j.id)?.onProgress?.(j);
    return;
  }
  broadcastJson(j);
}
// Spectrum: header (lo f64, fs f64, n u32) + n int8 dB. Clients get [1][payload].
function onSpectrum(p) {
  lastSpectrum = { lo: p.readDoubleLE(0), fs: p.readDoubleLE(8), n: p.readUInt32LE(16), db: new Int8Array(p.buffer, p.byteOffset + 20, p.readUInt32LE(16)).slice() };
  scanner.onSpectrum(lastSpectrum);
  watch.onSpectrum(lastSpectrum);
  const out = Buffer.allocUnsafe(1 + p.length);
  out[0] = 1;
  p.copy(out, 1);
  for (const c of clients) if (c.ws.readyState === 1 && c.ws.bufferedAmount < 2e6 && !c.noSpectrum) c.ws.send(out);
}
function onAudio(p) {
  if (recs.audio || decoders.mode !== 'off') {
    const b = Buffer.from(p.subarray(4)); // a copy: Int16Array needs an aligned offset
    const pcm = new Int16Array(b.buffer, b.byteOffset, b.length >> 1);
    if (recs.audio) recs.feedAudio(pcm, p[0]);
    if (decoders.mode !== 'off') decoders.feed(pcm, p[0]);
  }
  const out = Buffer.allocUnsafe(1 + p.length);
  out[0] = 2;
  p.copy(out, 1);
  for (const c of clients) if (c.audio && c.ws.readyState === 1 && c.ws.bufferedAmount < 1e6) c.ws.send(out);
}
// After a tuner or sample-rate change the engine reopens the RSPduo (about a second); sweeps wait for that.
let readyWaiters = [], reopening = false;
function deviceReady() {
  reopening = false;
  for (const r of readyWaiters) r();
  readyWaiters = [];
}
function whenReady() {
  if (!reopening) return Promise.resolve();
  return new Promise((r) => {
    readyWaiters.push(r);
    setTimeout(r, 20000);
  });
}
async function sweep(start, stop, binHz) {
  await whenReady();
  try {
    return await sweepOnce(start, stop, binHz);
  } catch (e) {
    if (!/restart/.test(e.message)) throw e;
    await whenReady(); // interrupted by a device reopen: once more
    return sweepOnce(start, stop, binHz);
  }
}
function sweepOnce(start, stop, binHz) {
  const id = 's' + Date.now() + Math.random().toString(36).slice(2, 6);
  return new Promise((resolve, reject) => {
    sweepWaiters.set(id, { resolve, reject, onProgress: (j) => broadcastJson({ type: 'sweepProgress', i: j.i, n: j.n }) });
    send({ cmd: 'sweep', id, start, stop, binHz });
    setTimeout(() => {
      if (sweepWaiters.has(id)) {
        sweepWaiters.delete(id);
        reject(new Error('sweep timed out'));
      }
    }, 600000);
  });
}

// Overload protection: while the RSPduo flags overload, raise the LNA state (more attenuation) every 1.5 s.
let lnaChangedAt = 0;
function autoLna(s) {
  if (!state.lnaAuto || !s.overload || s.sweeping || s.lna >= s.lnaMax || Date.now() - lnaChangedAt < 1500) return;
  lnaChangedAt = Date.now();
  setRadio({ lna: s.lna + 1 });
  log('overload: LNA state ->', s.lna + 1);
}
function antennaFor(freq) {
  return freq < state.antSplit ? { tuner: 'B', biasT: false, hiz: false } : { tuner: 'A', biasT: false, hiz: false };
}
function pickAntenna(freq) {
  if (!state.antAuto) return;
  const a = antennaFor(freq);
  if (a.tuner !== state.tuner || a.biasT !== state.biasT || a.hiz !== state.hiz) setRadio(a);
}

// ---- tuning policy --------------------------------------------------------------------------------------------------
// The engine listens at lo + vfo inside the captured span. Tune without moving the hardware when the new frequency is
// comfortably inside the span (and clear of the DC spike at the centre); otherwise move the hardware so the signal
// sits a quarter span above the centre.
function tune(freq, opts = {}) {
  freq = Math.round(Math.max(1000, Math.min(2000e6, freq)));
  if (playback) {
    // inside the recorded span only; the centre frequency comes from the file
    const half = state.fs * 0.45;
    freq = Math.round(Math.max(state.lo - half, Math.min(state.lo + half, freq)));
    state.freq = freq;
    send({ cmd: 'set', vfo: state.freq - state.lo });
    saveState();
    broadcastState();
    return;
  }
  pickAntenna(freq);
  const half = state.fs / 2, margin = Math.max(state.bw, 20000);
  const off = freq - state.lo;
  const inside = Math.abs(off) < half * 0.9 - margin / 2 && Math.abs(off) > Math.max(margin / 2, 15000);
  if (opts.lo != null) state.lo = opts.lo;
  else if (!inside) state.lo = freq - state.fs / 4;
  state.lo = Math.max(1000, state.lo);
  state.freq = freq;
  send({ cmd: 'set', lo: state.lo, vfo: state.freq - state.lo });
  if (freq !== rds?.freq) rds = null;
  saveState();
  broadcastState();
  clearTimeout(identTimer);
  identTimer = setTimeout(() => sendIdent(), 150);
}
function setMode(mode, bw) {
  if (!MODE_BW[mode]) return;
  state.modeBw[state.mode] = state.bw;
  state.modeSq[state.mode] = state.sq;
  state.mode = mode;
  state.bw = bw || state.modeBw[mode] || MODE_BW[mode];
  if (state.modeSq[mode] !== undefined) state.sq = state.modeSq[mode];
  send({ cmd: 'set', mode: state.mode, bw: state.bw, sq: state.sq });
  saveState();
  broadcastState();
}
const PASS = ['sq', 'stereo', 'deemph', 'lna', 'gr', 'agc', 'agcSet', 'tuner', 'hiz', 'fmNotch', 'dabNotch', 'amNotch', 'biasT', 'ppm', 'fs', 'fftN', 'fps', 'cwPitch'];
function setRadio(p) {
  const out = { cmd: 'set' };
  if (('tuner' in p && p.tuner !== state.tuner) || ('fs' in p && p.fs !== state.fs)) reopening = true;
  // each antenna keeps its own LNA state (the loop on HF wants far more gain than the multiband near FM stations)
  if ('tuner' in p && p.tuner !== state.tuner && !('lna' in p)) p = { ...p, lna: state.lnaByTuner?.[p.tuner] ?? state.lna };
  for (const k of PASS) if (k in p) state[k] = out[k] = p[k];
  if ('lna' in p) state.lnaByTuner = { ...state.lnaByTuner, [state.tuner]: Number(p.lna) };
  if ('bw' in p) {
    state.bw = out.bw = Math.max(100, Math.min(250000, Number(p.bw)));
    out.mode = state.mode;
  }
  if ('lnaAuto' in p) state.lnaAuto = !!p.lnaAuto;
  if ('step' in p) state.step = Number(p.step) || state.step;
  if ('fmGrid' in p) state.fmGrid = p.fmGrid;
  if ('antSplit' in p) state.antSplit = Math.max(1e6, Math.min(200e6, Number(p.antSplit) || 30e6));
  if ('antAuto' in p) {
    state.antAuto = !!p.antAuto;
    if (state.antAuto) {
      const a = antennaFor(state.freq);
      if (a.tuner !== state.tuner) reopening = true;
      for (const k of ['tuner', 'biasT', 'hiz']) state[k] = out[k] = a[k];
    }
  }
  if ('fs' in p) {
    // a new span: keep the listening frequency inside it
    send(out);
    tune(state.freq);
  } else send(out);
  saveState();
  broadcastState();
}

// ---- clients --------------------------------------------------------------------------------------------------------
const clients = new Set();
const listeners = () => [...clients].filter((c) => c.audio).length;
function broadcastJson(o) {
  const s = JSON.stringify(o);
  for (const c of clients) if (c.ws.readyState === 1) c.ws.send(s);
}
function publicState() {
  return {
    type: 'state', state, device, engine: engineUp, clients: clients.size, listeners: listeners(), rds,
    scan: scanner.info(), fmScan: fmIdent.info(), decoder: decoders.info(), survey: hamSurvey.result,
    rec: { audio: recs.audio ? { file: recs.audio.file, t: recs.audio.meta.t } : null, iq: recs.iq ? { file: recs.iq.file, t: recs.iq.meta.t } : null },
    playback: playback && { file: playback.file, meta: playback.meta }, memories, fm, lastSearch: lastSearch && { ...lastSearch, spectrum: undefined },
  };
}
function broadcastState() {
  broadcastJson(publicState());
}
function updateAudioFlag() {
  send({ cmd: 'set', audio: listeners() > 0 || decoders.mode !== 'off' || !!recs.audio });
}

async function onClientMessage(c, msg) {
  let m;
  try {
    m = JSON.parse(msg);
  } catch (e) {
    return;
  }
  const reply = (o) => c.ws.readyState === 1 && c.ws.send(JSON.stringify(o));
  try {
    switch (m.cmd) {
      case 'tune':
        if (!m.keepScan) scanner.pauseForUser();
        tune(m.freq, m);
        watch.userTuned(m.freq);
        break;
      case 'watchStart':
      case 'watchStop':
      case 'watchScan':
      case 'watchLock':
      case 'watchTune':
      case 'watchSkip':
        await watch.command(c, m);
        break;
      case 'mode':
        setMode(m.mode, m.bw);
        break;
      case 'set':
        if ('sq' in m) watch.sqSet = false; // the listener's own squelch now: kept when the watch ends
        setRadio(m);
        break;
      case 'audio':
        c.audio = !!m.on;
        updateAudioFlag();
        broadcastJson({ type: 'clients', clients: clients.size, listeners: listeners() });
        break;
      case 'spectrum':
        c.noSpectrum = !m.on;
        break;
      case 'memorySave': {
        const mem = {
          id: m.id || 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          name: String(m.name || '').slice(0, 60), freq: Math.round(m.freq ?? state.freq), mode: m.mode || state.mode,
          bw: m.bw || state.bw, group: String(m.group || 'General').slice(0, 40), sq: m.sq ?? state.sq, tuner: m.tuner || state.tuner,
          hiz: m.hiz ?? state.hiz, note: String(m.note || '').slice(0, 200), lockout: !!m.lockout,
        };
        const i = memories.findIndex((x) => x.id === mem.id);
        if (i >= 0) memories[i] = { ...memories[i], ...mem };
        else memories.push(mem);
        memories.sort((a, b) => a.group.localeCompare(b.group) || a.freq - b.freq);
        writeJson('memories.json', memories);
        broadcastState();
        break;
      }
      case 'memoryBulk': {
        // save many (e.g. search results); skip ones already stored on the same frequency and mode
        let n = 0;
        for (const x of m.items || []) {
          if (memories.some((y) => Math.abs(y.freq - x.freq) < 500 && y.mode === (x.mode || state.mode))) continue;
          memories.push({
            id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: String(x.name || '').slice(0, 60),
            freq: Math.round(x.freq), mode: x.mode || state.mode, bw: x.bw || MODE_BW[x.mode || state.mode], group: String(m.group || 'Search').slice(0, 40),
            sq: null, tuner: state.tuner, hiz: state.hiz, note: x.note || '', lockout: false,
          });
          n++;
        }
        memories.sort((a, b) => a.group.localeCompare(b.group) || a.freq - b.freq);
        writeJson('memories.json', memories);
        reply({ type: 'toast', msg: `Saved ${n} new memor${n === 1 ? 'y' : 'ies'} to "${m.group || 'Search'}"` });
        broadcastState();
        break;
      }
      case 'memoryDelete':
        memories = memories.filter((x) => !(m.ids || [m.id]).includes(x.id));
        writeJson('memories.json', memories);
        broadcastState();
        break;
      case 'memoryRecall': {
        const x = memories.find((y) => y.id === m.id);
        if (!x) break;
        scanner.pauseForUser();
        recall(x);
        break;
      }
      case 'search':
        runSearch(m).catch((e) => reply({ type: 'toast', msg: 'Search: ' + e.message, error: true }));
        break;
      case 'searchCancel':
        send({ cmd: 'sweepCancel' });
        break;
      case 'scanStart':
        watch.stop(false);
        scanner.start(m);
        break;
      case 'scanStop':
        scanner.stop();
        break;
      case 'scanSkip':
        scanner.skip(m.lockout);
        break;
      case 'scanResume':
        scanner.resume();
        break;
      case 'decoderStart': {
        const mode = m.mode;
        scanner.stop();
        if (mode === 'ft8' || mode === 'ft4') {
          setMode('usb', 3000);
          setRadio({ sq: null });
          if (m.dial) tune(Number(m.dial));
        } else if (mode === 'cw') {
          if (state.mode !== 'cw') setMode('cw', 500);
          setRadio({ sq: null });
        } else if (mode === 'aprs') {
          setMode('nfm', 12500);
          tune(Number(m.dial) || 144390000);
        }
        decoders.start(mode);
        updateAudioFlag();
        broadcastState();
        break;
      }
      case 'decoderStop':
        decoders.stop();
        updateAudioFlag();
        broadcastState();
        break;
      case 'decodeHistory':
        reply({ type: 'decodeHistory', history: decoders.history });
        break;
      case 'hamSurvey':
        hamSurvey.run(m).catch((e) => reply({ type: 'toast', msg: 'Survey: ' + e.message, error: true }));
        break;
      case 'scanHold':
        scanner.hold();
        break;
      case 'recStart':
        if (m.kind === 'iq') recs.startIq(m.maxSec);
        else recs.startAudio();
        broadcastState();
        break;
      case 'recStop':
        if (m.kind === 'iq') recs.stopIq();
        else {
          const meta = recs.stopAudio();
          if (meta) reply({ type: 'toast', msg: `Saved ${meta.dur.toFixed(0)} s of audio on the Pi (Recordings tab)` });
          broadcastJson({ type: 'recordings', list: recs.list() });
        }
        broadcastState();
        break;
      case 'recList':
        reply({ type: 'recordings', list: recs.list(), free: recs.free() });
        break;
      case 'recDelete':
        if (!recs.remove(String(m.file))) reply({ type: 'toast', msg: "Can't delete that one now", error: true });
        broadcastJson({ type: 'recordings', list: recs.list() });
        break;
      case 'playStart':
        startPlayback(String(m.file), Number(m.at) || 0);
        break;
      case 'playStop':
        stopPlayback();
        break;
      case 'playPause':
        send({ cmd: 'playPause', on: m.on });
        break;
      case 'playSeek':
        send({ cmd: 'playSeek', sec: Number(m.sec) || 0 });
        break;
      case 'lockoutsClear':
        scanner.lockouts.clear();
        writeJson('lockouts.json', []);
        reply({ type: 'toast', msg: 'Lock-outs cleared' });
        break;
      case 'hitsClear':
        hits = [];
        writeJson('hits.json', hits);
        broadcastJson({ type: 'hits', hits });
        break;
      case 'fmScan':
        fmIdent.start(m).catch((e) => reply({ type: 'toast', msg: 'FM scan: ' + e.message, error: true }));
        break;
      case 'fmScanStop':
        fmIdent.stop();
        break;
      case 'fmFav': {
        const s = fm.stations.find((x) => x.freq === m.freq);
        if (s) s.fav = !!m.fav;
        else if (m.fav) fm.stations.push({ freq: m.freq, fav: true, ps: rds?.freq === m.freq ? rds.ps?.trim() : '', pi: rds?.pi });
        fm.stations.sort((a, b) => a.freq - b.freq);
        writeJson('fm.json', fm);
        broadcastState();
        break;
      }
      case 'fmName': {
        const s = fm.stations.find((x) => x.freq === m.freq);
        if (s) s.name = String(m.name || '').slice(0, 40);
        writeJson('fm.json', fm);
        broadcastState();
        break;
      }
      case 'fmDelete':
        fm.stations = fm.stations.filter((x) => x.freq !== m.freq);
        writeJson('fm.json', fm);
        broadcastState();
        break;
      case 'fmTune':
        scanner.pauseForUser();
        if (state.mode !== 'wfm') setMode('wfm');
        tune(m.freq);
        break;
      case 'rdsReset':
        send({ cmd: 'rdsReset' });
        break;
      case 'hits':
        reply({ type: 'hits', hits });
        break;
      case 'searchResult':
        reply({ type: 'search', search: lastSearch });
        break;
    }
  } catch (e) {
    log('client command failed', m.cmd, e.message);
    reply({ type: 'toast', msg: e.message, error: true });
  }
}

function recall(x) {
  for (const k of ['tuner', 'hiz']) if (x[k] !== undefined && x[k] !== state[k]) setRadio({ [k]: x[k] });
  if (x.mode && (x.mode !== state.mode || (x.bw && x.bw !== state.bw))) setMode(x.mode, x.bw);
  if (x.sq !== undefined && x.sq !== state.sq) setRadio({ sq: x.sq });
  tune(x.freq);
}

// ---- search: sweep a range and list active channels -----------------------------------------------------------------
let searching = false;
function findPeaks(sw, start, stop, step, thr) {
  const db = sw.db.map((v) => v / 10), s0 = sw.start, st = sw.step;
  const chans = [];
  const first = Math.ceil(start / step) * step;
  for (let f = first; f <= stop; f += step) {
    const i0 = Math.max(0, Math.floor((f - step / 2 - s0) / st)), i1 = Math.min(db.length - 1, Math.ceil((f + step / 2 - s0) / st));
    let pk = -200;
    for (let i = i0; i <= i1; i++) pk = Math.max(pk, db[i]);
    chans.push({ freq: f, level: pk });
  }
  // Noise reference: the typical channel peak (each channel is judged by its loudest bin, so compare like with like).
  const sorted = chans.map((c) => c.level).filter((v) => v > -190).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.4)] ?? -100;
  const out = [];
  for (let i = 0; i < chans.length; i++) {
    const c = chans[i];
    if (c.level < floor + thr) continue;
    // keep local maxima only (a strong signal spills into the neighbouring channels)
    const l = chans[i - 1]?.level ?? -999, r = chans[i + 1]?.level ?? -999;
    if (c.level < l || c.level < r || (c.level === l && i > 0 && out.length && out[out.length - 1].freq === chans[i - 1].freq)) continue;
    out.push({ freq: c.freq, level: Math.round(c.level * 10) / 10, snr: Math.round((c.level - floor) * 10) / 10 });
  }
  return { floor, channels: out };
}
async function runSearch(m) {
  if (searching) throw new Error('a search is already running');
  if (playback) throw new Error('stop the IQ playback first');
  const start = Math.max(1000, Number(m.start)), stop = Math.min(2000e6, Number(m.stop));
  if (!(stop > start)) throw new Error('bad range');
  const step = Math.max(100, Number(m.step) || 12500), thr = Number(m.threshold) || 10;
  const native = state.fs / state.fftN;
  const binHz = Math.max(native, Math.min(step / 2, (stop - start) / 40000));
  searching = true;
  scanner.stop();
  watch.stop(false);
  broadcastJson({ type: 'search', running: true, start, stop });
  try {
    const t0 = Date.now();
    // With the auto antenna, a range across the split is swept in two parts, each on its own antenna.
    const parts = state.antAuto && start < state.antSplit && stop > state.antSplit ? [[start, state.antSplit], [state.antSplit, stop]] : [[start, stop]];
    let channels = [], floor = 0, sw = null;
    for (const [a, b] of parts) {
      pickAntenna((a + b) / 2);
      const part = await sweep(a, b, binHz);
      const r = findPeaks(part, a, b, step, thr);
      channels = channels.concat(r.channels);
      floor = parts.length > 1 ? Math.min(floor || r.floor, r.floor) : r.floor;
      if (!sw) sw = part;
      else {
        // join the spectra (same bin width)
        const gap = Math.max(0, Math.round((part.start - (sw.start + sw.db.length * sw.step)) / sw.step));
        sw = { ...sw, db: sw.db.concat(new Array(gap).fill(-2000), part.db) };
      }
    }
    const mode = m.mode || state.mode;
    lastSearch = {
      t: Date.now(), start, stop, step, threshold: thr, mode, bw: m.bw || MODE_BW[mode], floor: Math.round(floor * 10) / 10,
      took: Date.now() - t0, channels: channels.slice(0, 2000),
      spectrum: { start: sw.start, step: sw.step, db: downsample(sw.db, 4000) },
    };
    writeJson('search.json', lastSearch);
    broadcastJson({ type: 'search', running: false, search: lastSearch });
    tune(state.freq);
  } finally {
    searching = false;
  }
}
function downsample(db, max) {
  if (db.length <= max) return db;
  const k = Math.ceil(db.length / max), out = [];
  for (let i = 0; i < db.length; i += k) out.push(Math.max(...db.slice(i, i + k)));
  return out;
}

// ---- scanner: step through channels, stop on activity ---------------------------------------------------------------
const scanner = {
  on: false, list: [], idx: -1, phase: 'idle', since: 0, cfg: {}, holdUntil: 0, sawOpen: 0, statusN: 0, paused: false,
  lockouts: new Set(readJson('lockouts.json', [])), // frequencies the scanner always skips (birdies, the RSPduo's own spurs)
  info() {
    return { on: this.on, phase: this.phase, idx: this.idx, n: this.list.length, cur: this.list[this.idx] || null, cfg: this.cfg, paused: this.paused };
  },
  start(m) {
    const cfg = {
      source: m.source || 'range', start: Number(m.start), stop: Number(m.stop), step: Number(m.step) || 12500,
      mode: m.mode || state.mode, bw: Number(m.bw) || 0, group: m.group || null, threshold: Number(m.threshold) || 10,
      dwell: Math.max(80, Number(m.dwell) || 150), hang: Math.max(0, Number(m.hang ?? 2000)), sq: m.sq ?? null,
      maxListen: Number(m.maxListen) || 0,
      onHit: m.onHit === 'lock' ? 'lock' : 'resume', // lock: stay on the signal until Resume
    };
    let list = [];
    if (cfg.source === 'memories') list = memories.filter((x) => !x.lockout && (!cfg.group || x.group === cfg.group)).map((x) => ({ ...x }));
    else if (cfg.source === 'search') list = (lastSearch?.channels || []).map((x) => ({ freq: x.freq, mode: lastSearch.mode, bw: lastSearch.bw }));
    else {
      if (!(cfg.stop > cfg.start)) return broadcastJson({ type: 'toast', msg: 'Scanner: bad range', error: true });
      for (let f = Math.ceil(cfg.start / cfg.step) * cfg.step; f <= cfg.stop && list.length < 100000; f += cfg.step) list.push({ freq: f, mode: cfg.mode, bw: cfg.bw || MODE_BW[cfg.mode] });
    }
    list = list.filter((x) => !this.lockouts.has(Math.round(x.freq)));
    if (!list.length) return broadcastJson({ type: 'toast', msg: 'Scanner: nothing to scan', error: true });
    this.list = list;
    this.cfg = cfg;
    this.on = true;
    this.paused = false;
    this.idx = -1;
    // squelch: the scanner needs one; default to the noise floor + threshold
    if (cfg.sq != null) setRadio({ sq: Number(cfg.sq) });
    this.next();
    broadcastJson({ type: 'scan', scan: this.info() });
  },
  stop() {
    if (!this.on) return;
    this.on = false;
    this.phase = 'idle';
    clearTimeout(this.timer);
    broadcastJson({ type: 'scan', scan: this.info() });
  },
  pauseForUser() {
    if (this.on) this.stop();
  },
  resume() {
    if (this.on && (this.paused || this.phase === 'locked')) {
      this.paused = false;
      this.next();
    }
  },
  hold() {
    if (!this.on) return;
    clearTimeout(this.timer);
    this.phase = 'locked';
    broadcastJson({ type: 'scan', scan: this.info() });
  },
  skip(lockout) {
    if (!this.on) return;
    if (lockout) {
      const cur = this.list[this.idx];
      if (cur) {
        this.lockouts.add(Math.round(cur.freq));
        writeJson('lockouts.json', [...this.lockouts]);
      }
    }
    this.paused = false;
    this.next();
  },
  // In range scans, channels inside the current span whose spectrum bin is quiet are skipped without dwelling.
  quietInSpectrum(f) {
    const sp = lastSpectrum;
    if (!sp || this.cfg.source !== 'range') return false;
    const bin = sp.fs / sp.n, i = Math.round((f - sp.lo) / bin + sp.n / 2);
    if (i < sp.n * 0.06 || i > sp.n * 0.94) return false;
    const w = Math.max(1, Math.round(this.cfg.step / 2 / bin));
    let pk = -128;
    for (let k = i - w; k <= i + w; k++) if (k >= 0 && k < sp.n) pk = Math.max(pk, sp.db[k]);
    return pk < (status.floor ?? -100) + this.cfg.threshold;
  },
  next() {
    clearTimeout(this.timer);
    if (!this.on) return;
    let guard = 0;
    do {
      this.idx = (this.idx + 1) % this.list.length;
      if (++guard > this.list.length) break;
    } while (this.quietInSpectrum(this.list[this.idx].freq) && this.fresh());
    const ch = this.list[this.idx];
    if (ch.mode && (ch.mode !== state.mode || (ch.bw && ch.bw !== state.bw))) setMode(ch.mode, ch.bw);
    tune(ch.freq);
    this.phase = 'dwell';
    this.since = Date.now();
    this.statusN = 0;
    this.sawOpen = 0;
    this.timer = setTimeout(() => this.onDwellEnd(), this.cfg.dwell);
    broadcastJson({ type: 'scan', scan: this.info() });
  },
  fresh() {
    // spectrum data must be from the current hardware tuning (not before a retune)
    return lastSpectrum && Math.abs(lastSpectrum.lo - state.lo) < 1;
  },
  onDwellEnd() {
    if (!this.on || this.phase !== 'dwell') return;
    if (this.open()) this.listen();
    else this.next();
  },
  open() {
    // squelch and threshold are both dB above the channel noise
    const sq = (status.noise ?? -100) + (state.sq ?? this.cfg.threshold);
    return (status.level ?? -200) > sq;
  },
  listen() {
    this.phase = this.cfg.onHit === 'lock' ? 'locked' : 'listen';
    this.since = Date.now();
    this.lastOpen = Date.now();
    const ch = this.list[this.idx];
    const hit = { t: Date.now(), freq: ch.freq, mode: state.mode, level: status.level, name: ch.name || '', ps: '' };
    hits.unshift(hit);
    hits = hits.slice(0, 500);
    writeJson('hits.json', hits);
    broadcastJson({ type: 'hit', hit });
    broadcastJson({ type: 'scan', scan: this.info() });
  },
  onStatus(s) {
    if (!this.on || this.paused) return;
    if (this.phase === 'listen') { // ('locked' stays put until Resume or Skip)
      if (this.open()) this.lastOpen = Date.now();
      const tooLong = this.cfg.maxListen && Date.now() - this.since > this.cfg.maxListen;
      if (Date.now() - this.lastOpen > this.cfg.hang || tooLong) this.next();
    }
  },
  onSpectrum() {},
};

// ---- watch: a few channels inside one span, all at once (the Planes / Ships cards' Listen panel) ------------------
// Every spectrum frame (20/s) gives each channel's level, so all of them light up within ~0.1 s of a transmission,
// with no retuning. The span is chosen to hold them all (the RSPduo's IF filter: 1.536 MHz at 2.4 MS/s, 5 MHz at 6,
// 7 MHz at 8). Scan: the receiver follows the first active channel (list order = priority) and stays HANG ms after it
// goes quiet. Threshold = the squelch (dB above the noise), so one slider sets both. The client that started it owns
// it: when it stops or disconnects, the receiver goes back to how it was.
const WATCH_FS = [[2.4e6, 1.536e6], [6e6, 5e6], [8e6, 7e6]];
const SQ_DEFAULT = { am: 6, nfm: 4 }; // when the mode has no squelch of its own
const LIGHT_MIN_DB = 6; // channel lights: at least this far over the channel's own noise
const watch = {
  on: false, owner: null, list: [], mode: 'am', scan: true, locked: false, cur: -1, hang: 2000, saved: null, sqSet: false, lo: 0,
  info() {
    return { type: 'watch', on: this.on, scan: this.scan, locked: this.locked, cur: this.cur, mode: this.mode,
      ch: this.list.map((c) => ({ name: c.name, freq: c.freq, active: c.active, scan: c.scan })) };
  },
  send() {
    broadcastJson(this.info());
  },
  async start(c, m) {
    const list = (Array.isArray(m.channels) ? m.channels : []).map((x) => ({ name: String(x.name || x.freq).slice(0, 30), freq: Math.round(Number(x.freq)), scan: x.scan !== false }))
      .filter((x) => x.freq > 1e6).slice(0, 24);
    if (!list.length) return;
    if (playback) return broadcastJson({ type: 'toast', msg: 'Stop the IQ playback first', error: true });
    scanner.stop();
    const mode = MODE_BW[m.mode] ? m.mode : 'am';
    const lo = Math.min(...list.map((x) => x.freq)), hi = Math.max(...list.map((x) => x.freq)), half = MODE_BW[mode];
    const fsPick = WATCH_FS.find(([, bw]) => hi - lo + 2 * half + 60e3 < bw * 0.9);
    if (!fsPick) return broadcastJson({ type: 'toast', msg: `Listen: channels span ${((hi - lo) / 1e6).toFixed(1)} MHz, more than the receiver's 6.3 MHz`, error: true });
    if (!this.on) this.saved = { freq: state.freq, mode: state.mode, bw: state.bw, fs: state.fs, sq: state.sq };
    this.on = true;
    this.owner = c;
    this.list = list.map((x) => ({ ...x, active: false, raw: 0, lastRaw: 0, hist: [], base: null }));
    this.frames = 0;
    this.mode = mode;
    this.scan = m.scan !== false;
    this.locked = false;
    this.cur = -1;
    this.hang = Math.max(0, Number(m.hang ?? 2000));
    // centre between the outer channels, nudged off any channel (the DC spike sits at the centre)
    let centre = Math.round((lo + hi) / 2);
    while (list.some((x) => Math.abs(x.freq - centre) < 30e3)) centre += 50e3;
    this.lo = centre;
    if (state.fs !== fsPick[0]) {
      setRadio({ fs: fsPick[0] });
      await whenReady();
    }
    if (state.mode !== mode) setMode(mode);
    this.sqSet = state.sq == null;
    if (this.sqSet) setRadio({ sq: SQ_DEFAULT[mode] ?? 6 });
    this.tuneTo(m.start != null ? Number(m.start) : 0);
    this.send();
  },
  tuneTo(i) {
    const ch = this.list[i];
    if (!ch) return;
    this.cur = i;
    tune(ch.freq, { lo: this.lo });
  },
  stop(restore = true) {
    if (!this.on) return;
    this.on = false;
    this.owner = null;
    const sv = this.saved;
    this.saved = null;
    if (restore && sv) {
      if (this.sqSet && state.mode === this.mode) setRadio({ sq: null });
      if (state.fs !== sv.fs) setRadio({ fs: sv.fs });
      if (state.mode !== sv.mode) setMode(sv.mode, sv.bw);
      tune(sv.freq);
    }
    this.send();
  },
  // Someone tuned by hand (Pi-SDR's own page): inside the span, scanning pauses on it; elsewhere, the watch ends.
  userTuned(freq) {
    if (!this.on) return;
    const i = this.list.findIndex((x) => Math.abs(x.freq - freq) < 3000);
    if (i >= 0) {
      this.cur = i;
      this.locked = true;
      this.send();
    } else this.stop(false);
  },
  onSpectrum(sp) {
    if (!this.on || !sp || Math.abs(sp.lo - state.lo) > 1 || sp.fs !== state.fs || state.lo !== this.lo) return;
    const bin = sp.fs / sp.n, w = Math.max(1, Math.round(Math.min(8000, MODE_BW[this.mode] / 2) / bin)), db = sp.db;
    const peakAt = (i) => {
      let pk = -128;
      for (let k = Math.max(0, i - w); k <= Math.min(sp.n - 1, i + w); k++) if (db[k] > pk) pk = db[k];
      return pk;
    };
    // Each channel against its own noise: the median of its last ~15 s (channels near the filter's edges, or with
    // a birdie, sit a few dB apart even when silent, measured 2026-10-21). Silent channels never went more than 5 dB
    // over theirs, so the lights need at least LIGHT_MIN_DB; the squelch slider raises it.
    const thr = Math.max(LIGHT_MIN_DB, state.sq ?? SQ_DEFAULT[this.mode] ?? 6), now = Date.now();
    this.frames = (this.frames || 0) + 1;
    let changed = false;
    for (const c of this.list) {
      const i = Math.round((c.freq - sp.lo) / bin + sp.n / 2);
      c.level = peakAt(i);
      (c.hist ||= []).push(c.level);
      if (c.hist.length > 300) c.hist.shift();
      if (c.base == null || this.frames % 10 === 0) c.base = [...c.hist].sort((x, y) => x - y)[c.hist.length >> 1];
      const raw = c.hist.length >= 20 && c.level > c.base + thr;
      c.raw = raw ? c.raw + 1 : 0;
      if (raw) c.lastRaw = now;
      const act = c.raw >= 2 || (c.active && now - c.lastRaw < 600); // on after 2 frames, off after 0.6 s quiet
      if (act !== c.active) (c.active = act), (changed = true);
    }
    if (this.scan && !this.locked) {
      const cur = this.list[this.cur];
      if (!cur || now - cur.lastRaw > this.hang) {
        const i = this.list.findIndex((c) => c.scan && c.active);
        if (i >= 0 && i !== this.cur) {
          this.tuneTo(i);
          changed = true;
        }
      }
    }
    if (changed) this.send();
  },
  command(c, m) {
    if (m.cmd === 'watchStart') return this.start(c, m);
    if (!this.on) return;
    if (m.cmd === 'watchStop') this.stop(true);
    else if (m.cmd === 'watchScan') (this.scan = !!m.on), (this.locked = false), this.send();
    else if (m.cmd === 'watchLock') (this.locked = !!m.on), this.send();
    else if (m.cmd === 'watchSkip') {
      // a channel in or out of the scan (e.g. a continuous weather broadcast)
      const ch = this.list[Number(m.i)];
      if (ch) (ch.scan = !!m.scan), this.send();
    }
    else if (m.cmd === 'watchTune') {
      this.locked = m.lock !== false;
      this.tuneTo(Number(m.i));
      this.send();
    }
  },
  clientGone(c) {
    if (this.on && this.owner === c) this.stop(true);
  },
};

// ---- ham band survey: how busy is each HF band right now ----------------------------------------------------------
const HAM_HF = [['160 m', 1.8e6, 2.0e6], ['80 m', 3.5e6, 4.0e6], ['60 m', 5.3305e6, 5.4065e6], ['40 m', 7.0e6, 7.3e6], ['30 m', 10.1e6, 10.15e6], ['20 m', 14.0e6, 14.35e6],
  ['17 m', 18.068e6, 18.168e6], ['15 m', 21.0e6, 21.45e6], ['12 m', 24.89e6, 24.99e6], ['10 m', 28.0e6, 29.7e6], ['6 m', 50.0e6, 54.0e6]];
const hamSurvey = {
  running: false, result: readJson('survey.json', null),
  async run(m) {
    if (this.running) throw new Error('already running');
    if (playback) throw new Error('stop the IQ playback first');
    this.running = true;
    scanner.stop();
    const saved = state.freq, t0 = Date.now(), bands = [];
    try {
      for (const [name, a, b] of HAM_HF) {
        if (m.hfOnly && a > 30e6) continue;
        pickAntenna((a + b) / 2);
        broadcastJson({ type: 'hamSurvey', running: true, band: name });
        const sw = await sweep(a, b, 250);
        const { floor, channels } = findPeaks(sw, a, b, 1000, Number(m.threshold) || 8);
        bands.push({ name, start: a, stop: b, count: channels.length, floor: Math.round(floor), top: channels.sort((x, y) => y.snr - x.snr).slice(0, 12) });
      }
      this.result = { t: Date.now(), took: Date.now() - t0, bands };
      writeJson('survey.json', this.result);
      broadcastJson({ type: 'hamSurvey', running: false, result: this.result });
    } finally {
      this.running = false;
      tune(saved);
    }
  },
};

// ---- FM broadcast: sweep, snap to the grid, identify by RDS ---------------------------------------------------------
const fmIdent = {
  running: false, phase: 'idle', i: 0, n: 0, cur: null, cancel: false, best: null,
  info() {
    return { running: this.running, phase: this.phase, i: this.i, n: this.n, cur: this.cur };
  },
  async start(m) {
    if (this.running) throw new Error('already scanning');
    if (playback) throw new Error('stop the IQ playback first');
    this.running = true;
    this.cancel = false;
    scanner.stop();
    const saved = { freq: state.freq, mode: state.mode, bw: state.bw, sq: state.sq };
    const identify = m.rds !== false;
    try {
      this.phase = 'sweep';
      this.i = 0;
      this.n = 0;
      broadcastJson({ type: 'fmScan', scan: this.info() });
      const sw = await sweep(87.5e6, 108.1e6, 10000);
      const db = sw.db.map((v) => v / 10);
      // noise reference in the same terms as the station levels: the typical 80 kHz-window peak across the band
      const peaks = [];
      for (let f = 87.6e6; f < 108e6; f += 100e3) {
        const i0 = Math.max(0, Math.floor((f - 40e3 - sw.start) / sw.step)), i1 = Math.min(db.length - 1, Math.ceil((f + 40e3 - sw.start) / sw.step));
        let p = -200;
        for (let i = i0; i <= i1; i++) p = Math.max(p, db[i]);
        peaks.push(p);
      }
      peaks.sort((a, b) => a - b);
      const floor = peaks[Math.floor(peaks.length * 0.3)];
      const thr = Number(m.threshold) || 12;
      // channel grid: North America = odd tenths (88.1 ... 107.9); elsewhere every 100 kHz
      const grid = [];
      for (let f = 87.7e6; f <= 107.95e6; f += 100e3) {
        const r = Math.round(f / 1e5) * 1e5;
        if (state.fmGrid === 'na' && Math.round(r / 1e5) % 2 === 0) continue;
        grid.push(r);
      }
      const levelAt = (f, half) => {
        const i0 = Math.max(0, Math.floor((f - half - sw.start) / sw.step)), i1 = Math.min(db.length - 1, Math.ceil((f + half - sw.start) / sw.step));
        let p = -200;
        for (let i = i0; i <= i1; i++) p = Math.max(p, db[i]);
        return p;
      };
      let found = grid.map((f) => ({ freq: f, level: levelAt(f, 40e3) })).filter((x) => x.level > floor + thr);
      // a strong station also lights up its neighbours: keep a channel only if it beats the ones 200 kHz either side
      // by a margin, or stands well clear of the floor on its own
      found = found.filter((x) => {
        const l = levelAt(x.freq - 200e3, 40e3), r = levelAt(x.freq + 200e3, 40e3);
        return x.level >= l - 1 && x.level >= r - 1 && (x.level - Math.max(l, r) > 3 || x.level > floor + thr + 15);
      });
      found = found.map((x) => ({ ...x, snr: Math.round((x.level - floor) * 10) / 10, level: Math.round(x.level * 10) / 10 }));
      this.n = found.length;
      broadcastJson({ type: 'fmScan', scan: this.info(), found: found.length });
      // identify each by RDS
      if (identify) {
        this.phase = 'rds';
        if (state.mode !== 'wfm') setMode('wfm');
        for (let k = 0; k < found.length && !this.cancel; k++) {
          this.i = k + 1;
          this.cur = found[k].freq;
          broadcastJson({ type: 'fmScan', scan: this.info() });
          tune(found[k].freq);
          // let samples from the previous station drain before listening for this one's RDS
          this.best = null;
          await new Promise((r) => setTimeout(r, 400));
          send({ cmd: 'rdsReset' });
          await new Promise((r) => setTimeout(r, 100));
          this.best = { pi: null, ps: {}, pty: null, rt: '', stereo: false };
          const deadline = Date.now() + (Number(m.wait) || 4500);
          while (Date.now() < deadline && !this.cancel) {
            await new Promise((r) => setTimeout(r, 150));
            if (status.stereo) this.best.stereo = true;
            const b = this.best;
            const psCount = Object.values(b.ps).reduce((a, c) => a + c, 0);
            if (b.pi != null && psCount >= 3 && Date.now() > deadline - (Number(m.wait) || 4500) + 2500) break;
          }
          const b = this.best;
          // scrolling PS: the most frequent full name seen
          const ps = Object.entries(b.ps).sort((x, y) => y[1] - x[1]).map((x) => x[0]);
          Object.assign(found[k], { pi: b.pi, ps: ps[0] || '', psAll: ps.slice(0, 6), pty: b.pty, rt: b.rt, stereo: b.stereo });
        }
      }
      // merge with the saved list: favourites and names stay; stations not found keep their entry if favourite
      const old = new Map(fm.stations.map((s) => [s.freq, s]));
      const merged = found.map((s) => ({ ...(old.get(s.freq) || {}), ...s, fav: old.get(s.freq)?.fav || false, name: old.get(s.freq)?.name || '', lastSeen: Date.now() }));
      for (const s of fm.stations) if (s.fav && !merged.some((x) => x.freq === s.freq)) merged.push({ ...s, missing: true });
      merged.sort((a, b) => a.freq - b.freq);
      fm = { stations: merged, scanned: Date.now(), floor: Math.round(floor * 10) / 10 };
      writeJson('fm.json', fm);
    } finally {
      this.running = false;
      this.phase = 'idle';
      this.cur = null;
      if (saved.mode !== state.mode || saved.bw !== state.bw) setMode(saved.mode, saved.bw);
      tune(saved.freq);
      broadcastJson({ type: 'fmScan', scan: this.info() });
      broadcastState();
    }
  },
  stop() {
    this.cancel = true;
    if (this.phase === 'sweep') send({ cmd: 'sweepCancel' });
  },
  onRds(r) {
    if (!this.running || this.phase !== 'rds' || r.freq !== this.cur || !this.best) return;
    if (r.pi >= 0) this.best.pi = r.pi;
    if (r.pty >= 0) this.best.pty = r.pty;
    const ps = (r.ps || '').trim();
    if (ps) this.best.ps[ps] = (this.best.ps[ps] || 0) + 1;
    if (r.rt) this.best.rt = r.rt;
  },
};

// ---- HTTP -----------------------------------------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const WEB = path.join(__dirname, 'web');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const json = (o, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(o));
  };
  if (p === '/api/state') return json(publicState());
  if (p === '/api/status') return json({ status, rds, engine: engineUp, device });
  // Flat summary for dashboards (Homepage's customapi can't read a field inside rds when it's null, off broadcast FM).
  if (p === '/api/summary') {
    const f = state.freq, near = (x) => Math.abs(x.freq - f) < 5000;
    const fmSt = state.mode === 'wfm' ? (fm.stations || []).find(near) : null;
    const id = ident.lookup(f, state.mode).sort((a, b) => (b.onAir === true) - (a.onAir === true) || (a.km ?? 0) - (b.km ?? 0))[0];
    const station = (state.mode === 'wfm' && rds?.ps?.trim()) || fmSt?.name || fmSt?.ps || memories.find(near)?.name || id?.name || '';
    return json({ freq: f / 1e6, mode: state.mode.toUpperCase(), station, listeners: listeners(), clients: clients.size });
  }
  if (p === '/api/memories') return json(memories);
  if (p === '/api/fm') return json(fm);
  if (p === '/api/search') return json(lastSearch);
  if (p === '/api/hits') return json(hits);
  if (p === '/api/recordings') return json({ list: recs.list(), free: recs.free() });
  const rm = /^\/rec\/([\w.-]+\.(wav|iq))$/.exec(p);
  if (rm) {
    // recordings, with Range support so the browser's audio player can seek
    const f = path.join(REC_DIR, rm[1]);
    let st;
    try {
      st = fs.statSync(f);
    } catch (e) {
      res.writeHead(404);
      return res.end();
    }
    const type = rm[2] === 'wav' ? 'audio/wav' : 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...(url.searchParams.has('dl') ? { 'Content-Disposition': `attachment; filename="${rm[1]}"` } : {}) };
    if (range) {
      const a = range[1] ? Number(range[1]) : 0, b = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 });
      return fs.createReadStream(f, { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    return fs.createReadStream(f).pipe(res);
  }
  if (p === '/api/ident') return json({ freq: Number(url.searchParams.get('f')) || state.freq, items: ident.lookup(Number(url.searchParams.get('f')) || state.freq), info: ident.info() });
  if (p === '/api/onair') {
    const a = Number(url.searchParams.get('start')) || 0, b = Number(url.searchParams.get('end')) || 30e6;
    return json({ info: ident.info(), items: ident.range(a, b, url.searchParams.get('all') === '1') });
  }
  if (p === '/api/import' && req.method === 'POST') {
    // the export JSON back: memories are merged (same frequency + mode replaced), FM favourites and names merged
    let body = '';
    req.on('data', (d) => (body += d.length + body.length < 5e6 ? d : ''));
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        let n = 0;
        for (const x of j.memories || []) {
          if (!(x.freq > 0)) continue;
          const i = memories.findIndex((y) => Math.abs(y.freq - x.freq) < 500 && y.mode === x.mode);
          if (i >= 0) memories[i] = { ...memories[i], ...x };
          else memories.push({ ...x, id: x.id || 'm' + Date.now().toString(36) + n });
          n++;
        }
        for (const s of j.fm?.stations || []) {
          const o = fm.stations.find((y) => y.freq === s.freq);
          if (o) Object.assign(o, { fav: o.fav || s.fav, name: o.name || s.name });
          else fm.stations.push(s);
        }
        fm.stations.sort((a, b) => a.freq - b.freq);
        memories.sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.freq - b.freq);
        writeJson('memories.json', memories);
        writeJson('fm.json', fm);
        broadcastState();
        json({ ok: true, memories: n });
      } catch (e) {
        json({ error: e.message }, 400);
      }
    });
    return;
  }
  if (p === '/api/export') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="pi-sdr-export.json"' });
    return res.end(JSON.stringify({ memories, fm, state }, null, 1));
  }
  let f = p === '/' ? '/index.html' : p;
  f = path.normalize(path.join(WEB, f));
  if (!f.startsWith(WEB)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(f, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false });
wss.on('connection', (ws, req) => {
  const c = { ws, audio: false, noSpectrum: false, ip: req.socket.remoteAddress };
  clients.add(c);
  log('client connected', c.ip, clients.size);
  ws.send(JSON.stringify(publicState()));
  if (watch.on) ws.send(JSON.stringify(watch.info()));
  if (status.type) ws.send(JSON.stringify(status));
  ws.send(JSON.stringify({ type: 'hits', hits: hits.slice(0, 100) }));
  ws.send(JSON.stringify({ type: 'decodeHistory', history: decoders.history }));
  sendIdent(ws);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) onClientMessage(c, data.toString());
  });
  ws.on('close', () => {
    clients.delete(c);
    watch.clientGone(c);
    updateAudioFlag();
    broadcastJson({ type: 'clients', clients: clients.size, listeners: listeners() });
  });
  ws.on('error', () => {});
});

server.listen(PORT, () => log(`Pi-SDR on :${PORT} (data ${DATA_DIR})`));
startEngine();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    writeJson('state.json', state);
    // let the engine release the RSPduo before going (pm2 waits kill_timeout = 3 s)
    if (engine) {
      engine.once('exit', () => process.exit(0));
      send({ cmd: 'quit' });
      setTimeout(() => process.exit(0), 2500);
    } else process.exit(0);
  });
}
