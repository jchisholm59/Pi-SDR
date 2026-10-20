// Pi-SDR web client: one shared radio over a WebSocket. Spectrum + waterfall with click / drag / wheel tuning and
// zoom, a digit-wheel frequency display, audio played through Web Audio (scheduled buffers, so it works over plain
// http on the LAN), WAV recording, RDS, band presets, memories, the search / scanner and the FM broadcast section.
import { BANDS, CATS, COLORS, SCAN_PRESETS, PTY_RBDS, PTY_RDS, HAM, callsign } from './bands.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const MODES = ['wfm', 'nfm', 'am', 'usb', 'lsb', 'cw'];
const BWS = {
  wfm: [180000], nfm: [5000, 7500, 10000, 12500, 16000, 20000, 25000, 40000], am: [3000, 5000, 6000, 8330, 9000, 10000, 12000, 16000, 20000],
  usb: [1800, 2100, 2400, 2700, 3000, 3500], lsb: [1800, 2100, 2400, 2700, 3000, 3500], cw: [100, 200, 300, 500, 800, 1000],
};
const STEPS = [10, 50, 100, 500, 1000, 2500, 5000, 6250, 8330, 9000, 10000, 12500, 25000, 50000, 100000, 200000, 1000000];
const SPANS = [[2.4e6, '2.4 MHz'], [6e6, '6 MHz'], [8e6, '8 MHz'], [10e6, '10 MHz']];
const fmtHz = (f) => (f >= 1e6 ? `${(f / 1e6).toFixed(f % 1000 ? 4 : 3).replace(/0+$/, '').replace(/\.$/, '')} MHz` : f >= 1e3 ? `${+(f / 1e3).toFixed(2)} kHz` : `${f} Hz`);
const fmtStep = (s) => (s >= 1e6 ? `${s / 1e6} MHz` : s >= 1e3 ? `${s / 1e3} kHz` : `${s} Hz`);
const fmtMHz = (f, d = 3) => (f / 1e6).toFixed(d);
function parseFreq(t) {
  t = String(t).trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '');
  const m = /^([\d.]+)\s*(hz|k|khz|m|mhz|g|ghz)?$/.exec(t);
  if (!m) return null;
  let v = parseFloat(m[1]);
  const u = m[2] || '';
  if (u.startsWith('g')) v *= 1e9;
  else if (u.startsWith('m')) v *= 1e6;
  else if (u.startsWith('k')) v *= 1e3;
  else if (u === 'hz') v *= 1;
  else v = v < 2000 ? v * 1e6 : v * 1e3; // bare numbers: MHz up to 2000, else kHz
  return v >= 1000 && v <= 2000e6 ? Math.round(v) : null;
}
function toast(msg, err) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 3500);
}
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('pisdr:' + k);
      return v == null ? d : JSON.parse(v);
    } catch (e) {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('pisdr:' + k, JSON.stringify(v));
    } catch (e) {}
  },
};

// ---- state ------------------------------------------------------------------------------------------------------
let S = null; // server radio state
let st = {}; // engine status
let rds = null;
let mems = [], fmList = { stations: [] }, lastSearch = null, hits = [], scanInfo = null, fmScan = null;
let spec = null; // last spectrum {lo, fs, n, db: Int8Array}
let peak = null;
const view = { start: 0, end: 0, auto: true }; // visible range in Hz
let step = store.get('step', 0);
let dropSeen = { n: null, t: 0, was: null };
let recList = [];
let decoder = { mode: 'off' }, decHist = { ft8: [], ft4: [], cw: '', aprs: [] }, survey = null;
let identNow = null, onairItems = [], onairInfo = null, labelItems = [], labelRange = null;

// ---- connection ---------------------------------------------------------------------------------------------------
let ws = null, wsOk = false;
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + location.pathname.replace(/[^/]*$/, '') + 'ws');
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    wsOk = true;
    $('conn').textContent = 'connected';
    $('conn').className = 'pill';
    if (player.on) cmd({ cmd: 'audio', on: true });
    fetch('api/search').then((r) => r.json()).then((j) => {
      if (j) {
        lastSearch = j;
        renderSearch();
      }
    }).catch(() => {});
  };
  ws.onclose = () => {
    wsOk = false;
    $('conn').textContent = 'reconnecting…';
    $('conn').className = 'pill bad';
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') onJson(JSON.parse(ev.data));
    else {
      const b = ev.data, t = new Uint8Array(b, 0, 1)[0];
      if (t === 1) onSpectrum(b);
      else if (t === 2) player.push(b);
    }
  };
}
function cmd(o) {
  if (wsOk) ws.send(JSON.stringify(o));
}
let tuneTimer = null, tunePending = null;
function tuneTo(f, now) {
  f = Math.round(Math.max(1000, Math.min(2000e6, f)));
  if (S) S.freq = f; // optimistic
  renderFreq();
  tunePending = f;
  if (now) return flushTune();
  if (!tuneTimer) tuneTimer = setTimeout(flushTune, 40);
}
function flushTune() {
  clearTimeout(tuneTimer);
  tuneTimer = null;
  if (tunePending != null) cmd({ cmd: 'tune', freq: tunePending });
  tunePending = null;
}

function onJson(m) {
  switch (m.type) {
    case 'state':
      S = { ...m.state, rec: m.rec, playback: m.playback };
      mems = m.memories || mems;
      fmList = m.fm || fmList;
      if (m.lastSearch) lastSearch = { ...m.lastSearch, spectrum: lastSearch?.spectrum };
      scanInfo = m.scan;
      fmScan = m.fmScan;
      decoder = m.decoder || decoder;
      if (m.survey && !survey) survey = m.survey;
      if (m.rds !== undefined) rds = m.rds;
      $('who').textContent = `${m.clients} connected · ${m.listeners} listening`;
      if (m.device) $('devname').textContent = `RSPduo ${m.device.serial}`;
      if (!step) step = S.step || 100000;
      applyState();
      break;
    case 'status':
      st = m;
      renderStatus();
      break;
    case 'rds':
      rds = m;
      renderRds();
      break;
    case 'clients':
      $('who').textContent = `${m.clients} connected · ${m.listeners} listening`;
      break;
    case 'scan':
      scanInfo = m.scan;
      renderScan();
      break;
    case 'hit':
      hits.unshift(m.hit);
      renderHits();
      break;
    case 'hits':
      hits = m.hits;
      renderHits();
      break;
    case 'search':
      if (m.running) {
        $('sInfo').textContent = 'Sweeping…';
        $('sCancel').hidden = false;
        $('sGo').disabled = true;
      } else {
        $('sCancel').hidden = true;
        $('sGo').disabled = false;
        if (m.search) {
          lastSearch = m.search;
          renderSearch();
        }
      }
      break;
    case 'sweepProgress':
      if (fmScan?.running && fmScan.phase === 'sweep') $('fmScanInfo').textContent = `Sweeping ${m.i}/${m.n}`;
      else $('sInfo').textContent = `Sweeping… ${Math.round((m.i / m.n) * 100)}%`;
      break;
    case 'fmScan':
      fmScan = m.scan;
      renderFmScan();
      break;
    case 'decode':
      onDecode(m);
      break;
    case 'decodeHistory':
      decHist = m.history;
      renderDecoder();
      break;
    case 'hamSurvey':
      if (m.running) $('surveyInfo').textContent = `Sweeping ${m.band}…`;
      else if (m.result) {
        survey = m.result;
        renderSurvey();
      }
      $('surveyGo').disabled = !!m.running;
      break;
    case 'recordings':
      recList = m.list;
      renderRecs();
      break;
    case 'ident':
      identNow = m;
      renderIdent();
      break;
    case 'toast':
      toast(m.msg, m.error);
      break;
    case 'engine':
      if (!m.up) toast('Radio engine restarting…', true);
      break;
    case 'device':
      $('devname').textContent = `RSPduo ${m.serial}`;
      break;
    case 'log':
      if (m.level === 'error') toast(m.msg, true);
      break;
  }
}

// ---- frequency display ------------------------------------------------------------------------------------------
function renderFreq() {
  if (!S) return;
  if (identNow && identNow.freq !== S.freq) $('identLine').innerHTML = '';
  const f = S.freq;
  const s = String(Math.round(f)).padStart(10, '0'); // up to 2 GHz: 10 digits (Hz)
  let html = '', lead = true;
  for (let i = 0; i < 10; i++) {
    const p = 9 - i, ch = s[i];
    if (ch !== '0' || p <= 6) lead = false;
    html += `<span class="d${lead ? ' z' : ''}" data-p="${p}">${lead ? '&nbsp;' : ch}</span>`;
    if (p === 6 || p === 3) html += `<span class="sep">${p === 6 ? '.' : ' '}</span>`;
  }
  $('freq').innerHTML = html + '<span class="unit">MHz</span>';
  const b = bandAt(f);
  $('bandName').textContent = b ? b.name : '';
  $('stepLbl').textContent = `step ${fmtStep(step)}`;
}
$('freq').addEventListener('wheel', (e) => {
  const d = e.target.closest('.d');
  if (!d || !S) return;
  e.preventDefault();
  const p = Number(d.dataset.p);
  tuneTo(S.freq + (e.deltaY < 0 ? 1 : -1) * 10 ** p);
}, { passive: false });
$('freq').addEventListener('click', () => {
  $('freq').hidden = true;
  const i = $('freqIn');
  i.hidden = false;
  i.value = S ? fmtMHz(S.freq, 4).replace(/0+$/, '') : '';
  i.focus();
  i.select();
});
$('freqIn').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const f = parseFreq(e.target.value);
    if (f) tuneTo(f, true);
    else toast('Type a frequency like 101.3, 7255k or 1090M', true);
  }
  if (e.key === 'Enter' || e.key === 'Escape') {
    e.target.hidden = true;
    $('freq').hidden = false;
  }
});
$('freqIn').addEventListener('blur', (e) => {
  e.target.hidden = true;
  $('freq').hidden = false;
});
function bandAt(f) {
  let best = null;
  for (const b of BANDS) if (f >= b.start && f <= b.stop && (!best || b.stop - b.start < best.stop - best.start)) best = b;
  return best;
}

// ---- controls -----------------------------------------------------------------------------------------------------
$('modes').innerHTML = MODES.map((m) => `<button data-m="${m}">${m.toUpperCase()}</button>`).join('');
$('modes').onclick = (e) => {
  const b = e.target.closest('button');
  if (b) cmd({ cmd: 'mode', mode: b.dataset.m });
};
$('bwSel').onchange = (e) => cmd({ cmd: 'set', bw: Number(e.target.value) });
$('stepSel').innerHTML = STEPS.map((s) => `<option value="${s}">${fmtStep(s)}</option>`).join('');
$('stepSel').onchange = (e) => {
  step = Number(e.target.value);
  store.set('step', step);
  cmd({ cmd: 'set', step });
  renderFreq();
};
$('spanSel').innerHTML = SPANS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
$('spanSel').onchange = (e) => {
  view.auto = true;
  cmd({ cmd: 'set', fs: Number(e.target.value) });
};
$('sq').oninput = (e) => {
  const v = Number(e.target.value);
  $('sqLbl').textContent = v ? `${v} dB` : 'off';
};
$('sq').onchange = (e) => {
  const v = Number(e.target.value);
  cmd({ cmd: 'set', sq: v ? v : null });
};

function applyState() {
  if (!S) return;
  renderFreq();
  for (const b of $('modes').children) b.classList.toggle('on', b.dataset.m === S.mode);
  const bws = BWS[S.mode] || [S.bw];
  const opts = bws.includes(S.bw) ? bws : [...bws, S.bw].sort((a, b) => a - b);
  $('bwSel').innerHTML = opts.map((b) => `<option value="${b}" ${b === S.bw ? 'selected' : ''}>${b >= 1000 ? +(b / 1000).toFixed(2) + ' kHz' : b + ' Hz'}</option>`).join('');
  $('bwSel').disabled = S.mode === 'wfm';
  if (!STEPS.includes(step)) step = S.step;
  $('stepSel').value = String(step);
  $('spanSel').value = String(S.fs);
  if (document.activeElement !== $('sq')) {
    $('sq').value = S.sq ?? 0;
    $('sqLbl').textContent = S.sq ? `${S.sq} dB` : 'off';
  }
  // radio tab
  const ant = S.antAuto ? 'auto' : S.tuner === 'B' ? 'B' : S.hiz ? 'AH' : 'A';
  for (const r of document.querySelectorAll('input[name=ant]')) r.checked = r.value === ant;
  $('antSplit').value = S.antSplit / 1e6;
  for (const k of ['biasT', 'fmNotch', 'dabNotch', 'amNotch', 'agc', 'stereo', 'lnaAuto']) $(k).checked = !!S[k];
  $('biasT').disabled = S.tuner !== 'B' || S.antAuto;
  $('amNotch').disabled = !(S.tuner === 'A' && S.hiz);
  for (const k of ['agcSet', 'ppm', 'cwPitch']) if (document.activeElement !== $(k)) $(k).value = S[k];
  $('fftN').value = String(S.fftN);
  $('fps').value = String(S.fps);
  $('deemph').value = String(S.deemph);
  $('fmGrid').value = S.fmGrid || 'na';
  $('gr').disabled = S.agc;
  renderAnt();
  renderMem();
  renderFm();
  renderScan();
  renderFmScan();
  renderHam();
  renderDecoder();
  renderRecState();
  renderSurvey();
  if (lastSearch && !$('sResults').childElementCount) renderSearch();
  $('rdsbar').hidden = S.mode !== 'wfm';
}
function renderAnt() {
  if (!S) return;
  const t = S.tuner === 'B' ? `Loop · tuner 2${S.biasT ? ' · RSPduo bias-T ON' : ''}` : S.hiz ? 'Tuner 1 Hi-Z' : 'Multiband · tuner 1';
  $('ant').textContent = (S.antAuto ? 'Auto: ' : '') + t;
}

function renderStatus() {
  if (!st.type) return;
  const snr = st.level - st.noise;
  const sv = 1 + snr / 6;
  let pos, label;
  if (sv <= 9) {
    pos = Math.max(0, (sv - 1) / 8) * 0.67;
    label = sv < 1 ? 'S0' : `S${Math.floor(sv)}`;
  } else {
    const over = (sv - 9) * 6;
    pos = 0.67 + Math.min(1, over / 40) * 0.33;
    label = `S9+${Math.round(over)}`;
  }
  $('sFill').style.width = `${(pos * 100).toFixed(1)}%`;
  $('sNoise').style.left = '0%';
  const sqEl = $('sSq');
  if (S?.sq) {
    const sqv = 1 + S.sq / 6, sp = sqv <= 9 ? ((sqv - 1) / 8) * 0.67 : 0.67 + Math.min(1, ((sqv - 9) * 6) / 40) * 0.33;
    sqEl.style.display = 'block';
    sqEl.style.left = `${Math.max(0, sp) * 100}%`;
  } else sqEl.style.display = 'none';
  $('sVal').textContent = `${label}  ${st.level.toFixed(0)} dBFS`;
  $('snr').textContent = `SNR ${snr.toFixed(0)} dB`;
  $('fStereo').classList.toggle('on', !!st.stereo);
  $('fRds').classList.toggle('on', !!(rds?.sync && st.mode === 'wfm'));
  $('fSq').classList.toggle('on', st.sq != null && !st.sqOpen);
  $('fScan').classList.toggle('on', !!scanInfo?.on);
  $('ovl').hidden = !st.overload;
  renderPlayPos();
  // dropped samples: only worth showing while it's happening
  const now = Date.now();
  if (st.dropped !== dropSeen.n) dropSeen = { n: st.dropped, t: now, was: dropSeen.n };
  const dropping = dropSeen.was != null && st.dropped > dropSeen.was && now - dropSeen.t < 10000;
  $('load').textContent = `DSP ${st.load.toFixed(0)}%${dropping ? ' · DROPPING SAMPLES' : ''}`;
  $('load').className = dropping ? 'pill warn' : 'pill dim';
  $('lna').max = st.lnaMax;
  if (document.activeElement !== $('lna')) $('lna').value = st.lna;
  if (document.activeElement !== $('gr')) $('gr').value = st.agc ? st.gainGr || st.gr : st.gr;
  $('lnaLbl').textContent = `${st.lna} / ${st.lnaMax}`;
  $('grLbl').textContent = `${st.agc ? st.gainGr : st.gr} dB${st.agc ? ' (AGC)' : ''}`;
  $('gainInfo').textContent = `System gain ${st.gain.toFixed(1)} dB · LNA reduction ${st.lnaGr} dB · IF reduction ${st.gainGr} dB${st.overload ? ' · OVERLOAD' : ''}`;
  $('engInfo').textContent = `Span ${st.fs / 1e6} MHz · FFT ${st.fftN} (${(st.fs / st.fftN).toFixed(0)} Hz bins) · DSP ${st.load.toFixed(0)}% of a core · dropped ${st.dropped} samples · noise ${st.noise.toFixed(0)} dBFS`;
}

// ---- RDS --------------------------------------------------------------------------------------------------------
const ptyName = (p) => (p == null || p < 0 ? '' : (S?.fmGrid === 'eu' ? PTY_RDS : PTY_RBDS)[p] || `PTY ${p}`);
function renderRds() {
  const show = S?.mode === 'wfm';
  $('rdsbar').hidden = !show;
  const r = rds && rds.freq === S?.freq ? rds : null;
  $('rdsPs').textContent = r?.ps?.trim() ? r.ps : (st.stereo ? 'FM' : '        ');
  $('rdsRt').textContent = r?.rt || (r ? 'RDS: waiting for RadioText…' : 'No RDS yet');
  const cs = r ? callsign(r.pi) : '';
  $('rdsMeta').innerHTML = r
    ? [r.pi >= 0 ? `PI ${r.pi.toString(16).toUpperCase()}` : '', ptyName(r.pty), r.tp ? 'TP' : '', r.ta ? 'TA' : '', r.ms === 0 ? 'Speech' : r.ms === 1 ? 'Music' : '', r.ct ? `🕑 ${esc(r.ct)}` : '']
        .filter(Boolean).map((x) => `<span>${x}</span>`).join('')
    : '';
  $('fRds').classList.toggle('on', !!r?.sync);
  const fav = fmList.stations.find((s) => s.freq === S?.freq)?.fav;
  $('favNow').textContent = fav ? '★' : '☆';
  $('rdsFull').innerHTML = r
    ? [['Programme service', esc(r.ps)], ['RadioText', esc(r.rt) || '–'], ['Programme type', ptyName(r.pty) || '–'], ['PTY name', esc(r.ptyn?.trim()) || '–'],
       ['PI code', r.pi >= 0 ? `${r.pi.toString(16).toUpperCase()}${cs === 'Canada' ? ' · Canadian' : cs ? ` · if American: ${cs}` : ''}` : '–'], ['Traffic', `TP ${r.tp ? 'yes' : 'no'} · TA ${r.ta ? 'on' : 'off'}`],
       ['Content', r.ms === 1 ? 'Music' : r.ms === 0 ? 'Speech' : '–'], ['Station clock', esc(r.ct) || '–'],
       ['Alternative frequencies', r.af?.length ? r.af.map((k) => (k / 1000).toFixed(1)).join(', ') : '–'], ['Decoder', `${r.sync ? 'synced' : 'searching'} · ${r.groups} groups · ${(r.bler * 100).toFixed(1)}% block errors`]]
        .map(([k, v]) => `<div><b>${k}</b>${v}</div>`).join('')
    : '<div class="muted">Tune an FM station for RDS details.</div>';
}
$('favNow').onclick = () => {
  const s = fmList.stations.find((x) => x.freq === S.freq);
  cmd({ cmd: 'fmFav', freq: S.freq, fav: !s?.fav });
};

// ---- audio ------------------------------------------------------------------------------------------------------
const player = {
  on: false, ctx: null, gain: null, next: 0, vol: store.get('vol', 0.8), muted: false, rec: null,
  async start() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    await this.ctx.resume();
    this.setVol();
    this.on = true;
    this.next = 0;
    cmd({ cmd: 'audio', on: true });
  },
  stop() {
    this.on = false;
    cmd({ cmd: 'audio', on: false });
    if (this.rec) stopRec();
  },
  setVol() {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.vol;
  },
  push(buf) {
    if (!this.on || !this.ctx) return;
    const ch = new Uint8Array(buf, 1, 1)[0];
    const pcm = new Int16Array(buf.slice(5));
    const n = pcm.length / ch;
    if (this.rec) this.rec.push(ch === 2 ? pcm : interleave(pcm));
    const ab = this.ctx.createBuffer(ch, n, 48000);
    for (let c = 0; c < ch; c++) {
      const d = ab.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = pcm[i * ch + c] / 32768;
    }
    const now = this.ctx.currentTime;
    if (this.next < now + 0.03) this.next = now + 0.15; // underrun (or first): rebuild a small cushion
    if (this.next > now + 0.6) return; // too far ahead (clock drift): drop this chunk to catch up
    const src = this.ctx.createBufferSource();
    src.buffer = ab;
    src.connect(this.gain);
    src.start(this.next);
    this.next += ab.duration;
  },
};
function interleave(m) {
  const o = new Int16Array(m.length * 2);
  for (let i = 0; i < m.length; i++) o[2 * i] = o[2 * i + 1] = m[i];
  return o;
}
$('listen').onclick = async () => {
  if (player.on) player.stop();
  else await player.start();
  $('listen').textContent = player.on ? '■ Stop' : '▶ Listen';
  $('listen').classList.toggle('on', player.on);
};
$('vol').value = player.vol;
$('vol').oninput = (e) => {
  player.vol = Number(e.target.value);
  store.set('vol', player.vol);
  player.setVol();
};
$('mute').onclick = () => {
  player.muted = !player.muted;
  $('mute').classList.toggle('on', player.muted);
  player.setVol();
};
$('rec').onclick = () => cmd({ cmd: S?.rec?.audio ? 'recStop' : 'recStart', kind: 'audio' });
function stopRec() {
  const parts = player.rec;
  player.rec = null;
  $('rec').classList.remove('on');
  if (!parts?.length) return;
  const len = parts.reduce((a, p) => a + p.length, 0);
  const buf = new ArrayBuffer(44 + len * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, 48000, true);
  v.setUint32(28, 48000 * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, len * 2, true);
  let o = 44;
  for (const p of parts) for (let i = 0; i < p.length; i++, o += 2) v.setInt16(o, p[i], true);
  const a = document.createElement('a');
  const t = player.recT;
  a.href = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  a.download = `pi-sdr-${fmtMHz(player.recFreq, 4)}MHz-${t.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Saved ${(len / 2 / 48000).toFixed(1)} s of audio`);
}

// ---- spectrum + waterfall -----------------------------------------------------------------------------------------
const cSpec = $('spec'), cStrip = $('bandStrip'), cWf = $('wf');
const gSpec = cSpec.getContext('2d'), gStrip = cStrip.getContext('2d'), gWf = cWf.getContext('2d');
let dpr = 1, W = 0;
function sizeCanvases() {
  dpr = window.devicePixelRatio || 1;
  W = Math.round(cSpec.clientWidth * dpr);
  for (const c of [cSpec, cStrip, cWf]) {
    const h = Math.round(c.clientHeight * dpr);
    if (c.width !== W || c.height !== h) {
      if (c === cWf && c.width) {
        // keep the waterfall history when resizing
        const tmp = document.createElement('canvas');
        tmp.width = c.width;
        tmp.height = c.height;
        tmp.getContext('2d').drawImage(c, 0, 0);
        c.width = W;
        c.height = h;
        gWf.drawImage(tmp, 0, 0, W, h);
      } else {
        c.width = W;
        c.height = h;
      }
    }
  }
  drawStrip();
}
window.addEventListener('resize', () => {
  sizeCanvases();
  drawSearchPlot();
});

let dbMin = store.get('dbMin', -110), dbMax = store.get('dbMax', -20);
$('dbMin').value = dbMin;
$('dbMax').value = dbMax;
$('dbMin').onchange = (e) => store.set('dbMin', (dbMin = Number(e.target.value)));
$('dbMax').onchange = (e) => store.set('dbMax', (dbMax = Number(e.target.value)));
$('dbAuto').onclick = () => {
  if (!spec) return;
  const a = Array.from(spec.db).sort((x, y) => x - y);
  dbMin = Math.floor((a[Math.floor(a.length * 0.1)] - 8) / 5) * 5;
  dbMax = Math.ceil((a[a.length - 1] + 6) / 5) * 5;
  $('dbMin').value = dbMin;
  $('dbMax').value = dbMax;
  store.set('dbMin', dbMin);
  store.set('dbMax', dbMax);
};
$('peakHold').onchange = () => (peak = null);
let palette = store.get('palette', 'turbo');
$('palette').value = palette;
$('palette').onchange = (e) => {
  palette = e.target.value;
  store.set('palette', palette);
  buildLut();
};
let wfDiv = store.get('wfDiv', 1), wfCount = 0;
$('wfSpeed').value = String(wfDiv);
$('wfSpeed').onchange = (e) => store.set('wfDiv', (wfDiv = Number(e.target.value)));
$('showMem').checked = store.get('labels', true);
$('showMem').onchange = (e) => store.set('labels', e.target.checked);

// Colour maps (256 entries, RGB).
let LUT = new Uint8Array(256 * 3);
function buildLut() {
  const stops = {
    turbo: [[48, 18, 59], [65, 69, 171], [70, 117, 237], [57, 162, 252], [27, 207, 212], [36, 236, 166], [97, 252, 108], [164, 252, 59], [209, 232, 52], [243, 198, 58], [254, 155, 45], [243, 99, 21], [217, 56, 6], [177, 25, 1], [122, 4, 3]],
    viridis: [[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]],
    classic: [[0, 0, 0], [0, 0, 80], [0, 0, 180], [0, 120, 255], [0, 220, 220], [80, 255, 80], [255, 255, 0], [255, 120, 0], [255, 0, 0], [255, 255, 255]],
    gray: [[0, 0, 0], [255, 255, 255]],
  }[palette];
  const lo = palette === 'turbo' ? [5, 8, 16] : null;
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(x)), t = x - k;
    for (let c = 0; c < 3; c++) LUT[i * 3 + c] = stops[k][c] + (stops[k + 1][c] - stops[k][c]) * t;
    if (lo && i < 12) for (let c = 0; c < 3; c++) LUT[i * 3 + c] = lo[c] + ((LUT[i * 3 + c] - lo[c]) * i) / 12;
  }
}
buildLut();

const span = () => (spec ? { a: spec.lo - spec.fs / 2, b: spec.lo + spec.fs / 2 } : { a: 0, b: 1 });
const fToX = (f) => ((f - view.start) / (view.end - view.start)) * W;
const xToF = (x) => view.start + (x / W) * (view.end - view.start);
function clampView() {
  const { a, b } = span();
  let w = view.end - view.start;
  const minW = spec ? (spec.fs / spec.n) * 32 : 1000;
  w = Math.max(minW, Math.min(b - a, w));
  let s = view.start;
  if (s < a) s = a;
  if (s + w > b) s = b - w;
  view.start = s;
  view.end = s + w;
}
function zoom(factor, atF) {
  const c = atF ?? (view.start + view.end) / 2;
  view.start = c - (c - view.start) * factor;
  view.end = c + (view.end - c) * factor;
  view.auto = false;
  clampView();
  draw(true);
}
$('zoomIn').onclick = () => zoom(0.5, S?.freq);
$('zoomOut').onclick = () => zoom(2, S?.freq);
$('zoomFit').onclick = () => {
  view.auto = true;
  const { a, b } = span();
  view.start = a;
  view.end = b;
  draw(true);
};
$('zoomVfo').onclick = () => {
  const w = view.end - view.start;
  view.start = S.freq - w / 2;
  view.end = S.freq + w / 2;
  clampView();
  draw(true);
};

let lastLo = null, pendingDraw = false, spec0 = null;
function onSpectrum(buf) {
  const dv = new DataView(buf);
  const lo = dv.getFloat64(1, true), fs = dv.getFloat64(9, true), n = dv.getUint32(17, true);
  const db = new Int8Array(buf, 21, n);
  const changed = !spec || spec.lo !== lo || spec.fs !== fs || spec.n !== n;
  spec = { lo, fs, n, db };
  if (changed) {
    peak = null;
    // a jump to another part of the spectrum: start the waterfall afresh
    if (spec0 && Math.abs(lo - spec0.lo) > fs) gWf.clearRect(0, 0, cWf.width, cWf.height);
    spec0 = { lo };
    if (view.auto || !view.end) {
      view.start = lo - fs / 2;
      view.end = lo + fs / 2;
    } else if (lastLo != null) {
      // hardware moved: keep the same frequencies in view if possible, else follow the tuned signal
      const w = view.end - view.start;
      if (S && (S.freq < view.start || S.freq > view.end)) {
        view.start = S.freq - w / 2;
        view.end = S.freq + w / 2;
      }
    }
    clampView();
    lastLo = lo;
    drawStrip();
  }
  if ($('peakHold').checked) {
    if (!peak || peak.length !== n) peak = new Float32Array(db);
    else for (let i = 0; i < n; i++) peak[i] = Math.max(peak[i] - 0.05, db[i]);
  }
  addWfRow();
  if (!pendingDraw) {
    pendingDraw = true;
    requestAnimationFrame(() => {
      pendingDraw = false;
      draw();
    });
  }
}
// Per-pixel values: max over the bins under each pixel (or the nearest bin when zoomed in further).
function columns(arr) {
  const out = new Float32Array(W);
  const { a } = span(), bw = spec.fs / spec.n;
  for (let x = 0; x < W; x++) {
    const f0 = xToF(x), f1 = xToF(x + 1);
    let i0 = Math.floor((f0 - a) / bw), i1 = Math.floor((f1 - a) / bw);
    i0 = Math.max(0, Math.min(spec.n - 1, i0));
    i1 = Math.max(i0, Math.min(spec.n - 1, i1));
    let m = -200;
    for (let i = i0; i <= i1; i++) if (arr[i] > m) m = arr[i];
    out[x] = m;
  }
  return out;
}
function addWfRow() {
  if (!W || ++wfCount % wfDiv) return;
  const h = cWf.height;
  gWf.drawImage(cWf, 0, 0, W, h - 1, 0, 1, W, h - 1);
  const col = columns(spec.db);
  const img = gWf.createImageData(W, 1), d = img.data, k = 255 / (dbMax - dbMin);
  for (let x = 0; x < W; x++) {
    const v = Math.max(0, Math.min(255, (col[x] - dbMin) * k)) | 0;
    d[x * 4] = LUT[v * 3];
    d[x * 4 + 1] = LUT[v * 3 + 1];
    d[x * 4 + 2] = LUT[v * 3 + 2];
    d[x * 4 + 3] = 255;
  }
  gWf.putImageData(img, 0, 0);
}

function niceStep(range, px) {
  const target = range / Math.max(2, px / 110);
  const p = 10 ** Math.floor(Math.log10(target));
  for (const m of [1, 2, 2.5, 5, 10]) if (p * m >= target) return p * m;
  return p * 10;
}
function draw(full) {
  if (!spec || !W) return;
  const H = cSpec.height, g = gSpec;
  g.fillStyle = '#081018';
  g.fillRect(0, 0, W, H);
  const yOf = (v) => H - ((v - dbMin) / (dbMax - dbMin)) * H;
  // grid
  g.font = `${11 * dpr}px ui-monospace, monospace`;
  g.strokeStyle = '#16222e';
  g.fillStyle = '#5c7186';
  g.lineWidth = 1;
  for (let v = Math.ceil(dbMin / 10) * 10; v <= dbMax; v += 10) {
    const y = Math.round(yOf(v)) + 0.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
    g.fillText(`${v}`, 4 * dpr, y - 3 * dpr);
  }
  const fs = niceStep(view.end - view.start, W / dpr);
  for (let f = Math.ceil(view.start / fs) * fs; f <= view.end; f += fs) {
    const x = Math.round(fToX(f)) + 0.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, H);
    g.stroke();
    const lbl = fs >= 1e6 ? fmtMHz(f, fs >= 1e7 ? 0 : 1) : fs >= 1e3 ? fmtMHz(f, Math.max(3, Math.ceil(-Math.log10(fs / 1e6)))) : fmtMHz(f, 6);
    g.fillText(lbl, x + 3 * dpr, H - 4 * dpr);
  }
  // passband
  if (S) {
    const bw = S.mode === 'wfm' ? 180000 : S.bw;
    let lo = S.freq - bw / 2, hi = S.freq + bw / 2;
    if (S.mode === 'usb') (lo = S.freq + 200), (hi = S.freq + 200 + bw);
    if (S.mode === 'lsb') (lo = S.freq - 200 - bw), (hi = S.freq - 200);
    if (S.mode === 'cw') (lo = S.freq - bw / 2), (hi = S.freq + bw / 2);
    const x0 = fToX(lo), x1 = fToX(hi);
    g.fillStyle = 'rgba(41,182,246,.13)';
    g.fillRect(x0, 0, Math.max(1, x1 - x0), H);
  }
  // trace
  const col = columns(spec.db);
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(41,182,246,.55)');
  grad.addColorStop(1, 'rgba(41,182,246,.04)');
  g.beginPath();
  g.moveTo(0, H);
  for (let x = 0; x < W; x++) g.lineTo(x, yOf(col[x]));
  g.lineTo(W, H);
  g.closePath();
  g.fillStyle = grad;
  g.fill();
  g.beginPath();
  for (let x = 0; x < W; x++) (x ? g.lineTo : g.moveTo).call(g, x, yOf(col[x]));
  g.strokeStyle = '#7fd3ff';
  g.lineWidth = 1.2 * dpr;
  g.stroke();
  if (peak && $('peakHold').checked) {
    const pc = columns(peak);
    g.beginPath();
    for (let x = 0; x < W; x++) (x ? g.lineTo : g.moveTo).call(g, x, yOf(pc[x]));
    g.strokeStyle = 'rgba(255,202,40,.6)';
    g.lineWidth = 1;
    g.stroke();
  }
  // labels: FM stations and memories
  if ($('showMem').checked) {
    g.font = `${10.5 * dpr}px system-ui, sans-serif`;
    g.textAlign = 'center';
    let lastX = -1e9;
    const items = [];
    for (const s of fmList.stations || []) items.push({ f: s.freq, t: s.name || s.ps || '', c: s.fav ? '#ffca28' : '#9fb3c6' });
    for (const m of mems) items.push({ f: m.freq, t: m.name || fmtHz(m.freq), c: '#81c784' });
    items.sort((a, b) => a.f - b.f);
    for (const it of items) {
      if (it.f < view.start || it.f > view.end || !it.t) continue;
      const x = fToX(it.f), w = g.measureText(it.t.trim()).width;
      if (x - w / 2 < lastX + 8 * dpr) continue; // lastX: right edge of the previous label
      lastX = x + w / 2;
      g.fillStyle = it.c;
      g.fillText(it.t.trim(), x, 14 * dpr);
      g.fillRect(x - 0.5, 18 * dpr, 1, 6 * dpr);
    }
    // what's on air (shortwave schedule, airports, marine...) in a second row
    lastX = -1e9;
    for (const it of labelItems) {
      if (it.hz < view.start || it.hz > view.end || it.onAir === false) continue;
      const x = fToX(it.hz), w = g.measureText(it.name.slice(0, 18)).width;
      if (x - w / 2 < lastX + 8 * dpr) continue;
      lastX = x + w / 2;
      g.fillStyle = it.source === 'eibi' ? '#a5d6a7' : '#ce93d8';
      g.fillText(it.name.slice(0, 18), x, 30 * dpr);
      g.fillRect(x - 0.5, 33 * dpr, 1, 5 * dpr);
    }
    g.textAlign = 'left';
  }
  // VFO line
  if (S) {
    const x = Math.round(fToX(S.freq)) + 0.5;
    g.strokeStyle = '#ff5252';
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, H);
    g.stroke();
  }
  wantLabels();
  $('specInfo').textContent = `${fmtMHz(view.start, 3)} – ${fmtMHz(view.end, 3)} MHz · ${fmtHz(Math.round((view.end - view.start) / W * dpr))}/px`;
  if (full) drawStrip();
  syncSlider();
}
function drawStrip() {
  if (!W) return;
  const H = cStrip.height, g = gStrip;
  g.fillStyle = '#0a1118';
  g.fillRect(0, 0, W, H);
  g.font = `${10.5 * dpr}px system-ui, sans-serif`;
  g.textBaseline = 'middle';
  const vis = BANDS.filter((b) => b.overlay !== false && b.stop >= view.start && b.start <= view.end).sort((a, b) => b.stop - b.start - (a.stop - a.start));
  const used = []; // label extents, so overlapping bands don't print on top of each other
  for (const b of vis) {
    const x0 = Math.max(0, fToX(b.start)), x1 = Math.min(W, fToX(b.stop));
    g.fillStyle = COLORS[b.cat] + (b.point ? 'cc' : '55');
    g.fillRect(x0, 2 * dpr, Math.max(2, x1 - x0), H - 4 * dpr);
  }
  for (const b of [...vis].reverse()) { // narrow bands first: their labels matter most where they sit
    const x0 = Math.max(0, fToX(b.start)), x1 = Math.min(W, fToX(b.stop)), tw = g.measureText(b.name).width;
    let lx = x0 + 4 * dpr;
    if (x1 - x0 < tw + 8) continue;
    while (used.some(([a, c]) => lx < c && lx + tw > a) && lx + tw < x1) lx = Math.max(...used.filter(([a, c]) => lx < c && lx + tw > a).map(([, c]) => c)) + 8 * dpr;
    if (lx + tw > x1 || used.some(([a, c]) => lx < c && lx + tw > a)) continue;
    used.push([lx, lx + tw]);
    g.fillStyle = '#e8f1f8';
    g.fillText(b.name, lx, H / 2);
  }
}

// interaction on the spectrum and waterfall
let drag = null;
function evF(e) {
  const r = e.currentTarget.getBoundingClientRect();
  return xToF((e.clientX - r.left) * dpr);
}
const snap = (f) => {
  if (S?.mode === 'wfm' && f > 87e6 && f < 108.1e6) return Math.round(f / 100000) * 100000;
  return Math.round(f / step) * step;
};
for (const c of [cSpec, cWf]) {
  c.addEventListener('pointerdown', (e) => {
    c.setPointerCapture(e.pointerId);
    const f = evF(e), nearVfo = S && Math.abs(fToX(f) - fToX(S.freq)) < 12 * dpr;
    drag = { x: e.clientX, f0: f, moved: false, tune: nearVfo, vs: view.start, ve: view.end };
  });
  c.addEventListener('pointermove', (e) => {
    showHover(e, c);
    if (!drag) return;
    const dx = (e.clientX - drag.x) * dpr;
    if (Math.abs(dx) > 3 * dpr) drag.moved = true;
    if (!drag.moved) return;
    if (drag.tune) tuneTo(snap(evF(e)));
    else {
      const df = (dx / W) * (drag.ve - drag.vs);
      view.start = drag.vs - df;
      view.end = drag.ve - df;
      view.auto = false;
      clampView();
      draw(true);
    }
  });
  c.addEventListener('pointerup', (e) => {
    if (drag && !drag.moved) tuneTo(snap(evF(e)), true);
    else if (drag?.tune) flushTune();
    drag = null;
  });
  c.addEventListener('pointerleave', () => ($('hoverTip').hidden = true));
  c.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.shiftKey || e.altKey) zoom(e.deltaY < 0 ? 0.8 : 1.25, evF(e));
    else if (S) tuneTo(snap(S.freq + (e.deltaY < 0 ? step : -step)));
  }, { passive: false });
}
cStrip.addEventListener('click', (e) => {
  const r = cStrip.getBoundingClientRect(), f = xToF((e.clientX - r.left) * dpr);
  const b = bandAt(f);
  if (b) toast(`${b.name}: ${fmtHz(b.start)} – ${fmtHz(b.stop)}, ${b.mode.toUpperCase()}`);
});
function showHover(e, c) {
  if (!spec) return;
  const r = c.getBoundingClientRect(), x = (e.clientX - r.left) * dpr, f = xToF(x);
  const i = Math.floor((f - span().a) / (spec.fs / spec.n));
  const v = spec.db[Math.max(0, Math.min(spec.n - 1, i))];
  const t = $('hoverTip');
  t.hidden = false;
  t.textContent = `${fmtMHz(f, 4)} MHz · ${v} dB`;
  const box = $('specBox').getBoundingClientRect();
  t.style.left = `${Math.min(e.clientX - box.left + 12, box.width - 170)}px`;
  t.style.top = `${e.clientY - box.top + 12}px`;
}
// tuning slider across the visible spectrum
function syncSlider() {
  if (!S || document.activeElement === $('tuneSlide')) return;
  $('tuneSlide').value = String(Math.round(((S.freq - view.start) / (view.end - view.start)) * 1000));
}
$('tuneSlide').oninput = (e) => tuneTo(snap(view.start + (Number(e.target.value) / 1000) * (view.end - view.start)));
$('tuneSlide').onchange = () => flushTune();
$('tDown').onclick = () => S && tuneTo(snap(S.freq - step), true);
$('tUp').onclick = () => S && tuneTo(snap(S.freq + step), true);
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || !S) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') (e.preventDefault(), tuneTo(snap(S.freq + step)));
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') (e.preventDefault(), tuneTo(snap(S.freq - step)));
  if (e.key === ' ') (e.preventDefault(), $('listen').click());
});

// ---- station identifier ---------------------------------------------------------------------------------------------
// Labels for the visible range: refetched when the view moves (debounced) and every minute (schedules change hourly).
let labelTimer = null, labelPending = null;
function wantLabels() {
  const key = `${Math.round(view.start / 1000)}-${Math.round(view.end / 1000)}`;
  if ((labelRange?.key === key && Date.now() - labelRange.t < 60000) || labelPending === key) return;
  clearTimeout(labelTimer);
  labelPending = key;
  labelTimer = setTimeout(async () => {
    labelPending = null;
    labelRange = { key, t: Date.now() };
    try {
      const j = await fetch(`api/onair?start=${Math.round(view.start)}&end=${Math.round(view.end)}`).then((r) => r.json());
      labelItems = j.items || [];
    } catch (e) {}
  }, 400);
}
function identText(it) {
  return `${it.onAir ? '<span class="onair">ON AIR</span> ' : ''}<b>${esc(it.name)}</b> <span class="muted">${esc(it.detail || '')}</span>`;
}
function renderIdent() {
  const items = identNow && S && identNow.freq === S.freq ? identNow.items : [];
  const top = items.find((x) => x.onAir) || items.find((x) => x.onAir == null) || null;
  $('identLine').innerHTML = top ? identText(top) + (items.length > 1 ? ` <span class="muted">+${items.length - 1} more</span>` : '') : '';
  $('hereFreq').textContent = S ? `${fmtMHz(S.freq, 4)} MHz` : '';
  $('hereNow').innerHTML = items.length
    ? `<table><tbody>${items.map((it) => `<tr><td>${it.onAir ? '<span class="onair">ON AIR</span>' : it.onAir === false ? '<span class="offair">off air</span>' : ''}</td><td class="mono">${fmtMHz(it.hz, 4)}</td><td><b>${esc(it.name)}</b></td><td class="muted">${esc(it.detail || '')}</td></tr>`).join('')}</tbody></table>`
    : '<div class="muted">Nothing listed here. Shortwave schedules (EiBi), local airports, marine and fixed services are checked.</div>';
}
const SW_BANDS = [['', 'All of LW / MW / SW'], [[148.5e3, 283.5e3], 'LW'], [[530e3, 1710e3], 'MW'], [[2.3e6, 2.5e6], '120 m'], [[3.2e6, 3.4e6], '90 m'], [[3.9e6, 4e6], '75 m'], [[4.75e6, 5.06e6], '60 m'],
  [[5.9e6, 6.2e6], '49 m'], [[7.2e6, 7.45e6], '41 m'], [[9.4e6, 9.9e6], '31 m'], [[11.6e6, 12.1e6], '25 m'], [[13.57e6, 13.87e6], '22 m'], [[15.1e6, 15.8e6], '19 m'], [[17.48e6, 17.9e6], '16 m'],
  [[18.9e6, 19.02e6], '15 m'], [[21.45e6, 21.85e6], '13 m'], [[25.67e6, 26.1e6], '11 m'], [[0, 30e6], 'Everything incl. utilities']];
$('oaBand').innerHTML = SW_BANDS.map(([, n], i) => `<option value="${i}">${n}</option>`).join('');
$('oaBand').value = store.get('oaBand', '0');
for (const id of ['oaBand', 'oaLang', 'oaText', 'oaAll']) $(id).addEventListener(id === 'oaAll' || id === 'oaBand' ? 'change' : 'input', () => {
  store.set('oaBand', $('oaBand').value);
  if (id === 'oaAll') loadOnair();
  else renderOnair();
});
async function loadOnair() {
  try {
    const j = await fetch(`api/onair?start=100000&end=30000000${$('oaAll').checked ? '&all=1' : ''}`).then((r) => r.json());
    onairItems = (j.items || []).filter((x) => x.source === 'eibi');
    onairInfo = j.info;
    renderOnair();
  } catch (e) {}
}
function renderOnair() {
  const b = SW_BANDS[Number($('oaBand').value)][0], lang = $('oaLang').value.trim().toLowerCase(), q = $('oaText').value.trim().toLowerCase();
  const list = onairItems.filter((x) => (!b || (x.hz >= b[0] && x.hz <= b[1])) && (!lang || x.detail.toLowerCase().includes(lang)) && (!q || `${x.name} ${x.detail}`.toLowerCase().includes(q)));
  $('oaInfo').textContent = onairInfo ? `${list.length} ${$('oaAll').checked ? 'scheduled' : 'on air now'} · EiBi schedule ${onairInfo.eibiSeason} (${onairInfo.eibi} entries) · times UTC, now ${new Date().toISOString().slice(11, 16)} UTC · tap to tune` : '';
  $('oaList').innerHTML = list.length
    ? `<table><thead><tr><th>kHz</th><th></th><th>Station</th><th>Language · target · hours</th></tr></thead><tbody>${list.slice(0, 1500).map((x) => `<tr class="click${S && Math.abs(S.freq - x.hz) < 2500 ? ' cur' : ''}" data-hz="${x.hz}"><td class="mono">${+(x.hz / 1000).toFixed(1)}</td><td>${x.onAir ? '<span class="onair">●</span>' : ''}</td><td><b>${esc(x.name)}</b></td><td class="muted">${esc(x.detail)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="muted">Nothing matches.</div>';
}
$('oaList').onclick = (e) => {
  const tr = e.target.closest('tr[data-hz]');
  if (!tr) return;
  const hz = Number(tr.dataset.hz);
  if (S.mode !== 'am') cmd({ cmd: 'mode', mode: 'am', bw: 9000 });
  view.auto = true;
  tuneTo(hz, true);
};
setInterval(() => document.querySelector('.tab.on')?.dataset.tab === 'onair' && loadOnair(), 60000);

// ---- ham ------------------------------------------------------------------------------------------------------------
const sideband = (f) => (f < 10e6 ? 'lsb' : 'usb');
function hamTune(f, mode, bw, stp) {
  if (mode && (mode !== S.mode || (bw && bw !== S.bw))) cmd({ cmd: 'mode', mode, bw });
  if (stp) {
    step = stp;
    store.set('step', step);
    cmd({ cmd: 'set', step });
  }
  view.auto = true;
  tuneTo(f, true);
}
function renderHam() {
  if (!S) return;
  $('hamBands').innerHTML = HAM.map((b, i) => {
    const btn = (act, label, title) => `<button data-h="${i}" data-a="${act}" title="${title || ''}">${label}</button>`;
    const bs = [];
    if (b.cw) bs.push(btn('cw', 'CW'));
    if (b.ssb) bs.push(btn('ssb', 'SSB'), `<button class="lock" data-h="${i}" data-a="scanssb" title="Auto-scan the SSB segment, lock on the first signal">🔒 SSB</button>`);
    if (b.fm) bs.push(btn('fm', 'FM'), `<button class="lock" data-h="${i}" data-a="scanfm" title="Auto-scan the FM segment, lock on the first signal">🔒 FM</button>`);
    if (b.ft8) bs.push(btn('ft8', 'FT8', 'Tune the FT8 dial frequency and start the decoder'));
    if (b.ft4) bs.push(btn('ft4', 'FT4'));
    if (b.aprs) bs.push(btn('aprs', 'APRS', 'Tune 144.390 and start the APRS decoder'));
    const cur = S.freq >= b.start && S.freq <= b.stop;
    return `<div class="hb${cur ? ' cur' : ''}"><div class="t"><b>${b.name}</b><span>${fmtMHz(b.start, 3)} – ${fmtMHz(b.stop, 3)}${b.hf ? ' · loop' : ''}</span></div><div class="b">${bs.join('')}</div>${
      b.call ? `<div class="c">${b.call.map(([f, n]) => `<a data-f="${f}" title="${fmtMHz(f, 4)} MHz">${esc(n)}</a>`).join('')}</div>` : ''}</div>`;
  }).join('');
}
$('hamBands').onclick = (e) => {
  const a = e.target.closest('[data-f]');
  if (a) {
    const f = Number(a.dataset.f), m = f > 30e6 && f < 1300e6 && !/SSB|CW/.test(a.textContent) ? 'nfm' : /CW/.test(a.textContent) ? 'cw' : sideband(f);
    return hamTune(f, m, m === 'nfm' ? 12500 : undefined);
  }
  const t = e.target.closest('[data-h]');
  if (!t) return;
  const b = HAM[Number(t.dataset.h)], act = t.dataset.a;
  if (act === 'cw') return hamTune(b.cw[0] + (b.cw[1] - b.cw[0]) * 0.3, 'cw', 500, 100);
  if (act === 'ssb') return hamTune((b.ssb[0] + b.ssb[1]) / 2, b.ssb[2], 2700, 500);
  if (act === 'fm') return hamTune(b.call?.find(([, n]) => /FM simplex/.test(n))?.[0] || b.fm[0], 'nfm', 12500, b.fm[2]);
  if (act === 'ft8' || act === 'ft4') return cmd({ cmd: 'decoderStart', mode: act, dial: b[act] });
  if (act === 'aprs') return cmd({ cmd: 'decoderStart', mode: 'aprs', dial: b.aprs });
  if (act === 'scanssb') {
    cmd({ cmd: 'scanStart', source: 'range', start: b.ssb[0], stop: b.ssb[1], step: 1000, mode: b.ssb[2], threshold: 10, dwell: 150, hang: 3000, onHit: 'lock' });
    toast(`Scanning ${b.name} SSB; it will lock on the first signal (Scanner tab: Resume to move on)`);
  }
  if (act === 'scanfm') {
    cmd({ cmd: 'scanStart', source: 'range', start: b.fm[0], stop: b.fm[1], step: b.fm[2], mode: 'nfm', threshold: 10, dwell: 150, hang: 3000, onHit: 'lock' });
    toast(`Scanning ${b.name} FM; it will lock on the first signal`);
  }
};

// decoders
const FT8_DIALS = HAM.filter((b) => b.ft8).map((b) => [b.ft8, b.name]);
const FT4_DIALS = HAM.filter((b) => b.ft4).map((b) => [b.ft4, b.name]);
function renderDecoder() {
  const mode = decoder?.mode || 'off';
  for (const b of $('decModes').children) b.classList.toggle('on', b.dataset.dec === mode);
  const dials = mode === 'ft4' ? FT4_DIALS : FT8_DIALS;
  $('decDialL').hidden = !(mode === 'ft8' || mode === 'ft4');
  $('decDial').innerHTML = dials.map(([f, n]) => `<option value="${f}" ${S && Math.abs(S.freq - f) < 1000 ? 'selected' : ''}>${n} · ${fmtMHz(f, 3)}</option>`).join('');
  $('decState').textContent = mode === 'off' ? 'off' : `${mode.toUpperCase()} running on ${S ? fmtMHz(S.freq, 4) : ''} MHz`;
  $('decHelp').textContent = {
    off: 'FT8 / FT4: tunes the dial frequency in USB and decodes every 15 s (7.5 s) slot. CW: decodes whatever you tune in CW mode. APRS: 144.390 MHz packets. Decoders run on the Pi, whether or not you are listening.',
    ft8: 'Decoding each 15 s slot (needs the Pi clock in sync, it is). Green = CQ calls. Distance and bearing from Hubley.',
    ft4: 'Decoding each 7.5 s slot.',
    cw: 'Tune a CW signal (the decoder finds the tone between 300 and 1200 Hz).',
    aprs: 'Listening on 144.390 MHz for APRS packets.',
  }[mode];
  if (decoder?.available && !decoder.available.ft8 && (mode === 'ft8' || mode === 'ft4')) $('decHelp').textContent = 'FT8 decoder not installed on the Pi (see README).';
  const out = $('decOut');
  if (mode === 'ft8' || mode === 'ft4') {
    const rows = decHist[mode] || [];
    out.innerHTML = rows.length
      ? `<table><thead><tr><th>UTC</th><th>dB</th><th>DT</th><th>Hz</th><th>Message</th><th>Country</th><th>km</th></tr></thead><tbody>${rows.slice(0, 300).map((d) =>
          `<tr class="${d.cq ? 'cq' : ''}"><td class="mono">${new Date(d.t).toISOString().slice(11, 19)}</td><td class="mono">${d.snr}</td><td class="mono">${d.dt.toFixed(1)}</td><td class="mono">${d.df}</td><td class="mono">${esc(d.msg)}</td><td>${esc(d.country || '')}</td><td class="mono">${d.km != null ? `${d.km} <span class="muted">${d.brg}°</span>` : ''}</td></tr>`).join('')}</tbody></table>`
      : '<div class="muted">Waiting for the end of the first slot…</div>';
  } else if (mode === 'cw') {
    out.innerHTML = `<div class="muted small" id="cwMeta"></div><div class="cwtext" id="cwText">${esc(decHist.cw || '')}</div>`;
  } else if (mode === 'aprs') {
    const rows = decHist.aprs || [];
    out.innerHTML = rows.length
      ? `<table><thead><tr><th>Time</th><th>From</th><th>Kind</th><th>km</th><th>Comment / data</th></tr></thead><tbody>${rows.slice(0, 300).map((p) =>
          `<tr title="${esc(p.from)}>${esc(p.to)},${esc(p.path)}:${esc(p.info)}"><td class="mono">${new Date(p.t).toLocaleTimeString()}</td><td><b>${esc(p.from)}</b></td><td>${esc(p.kind)}</td><td class="mono">${p.km != null ? `${p.km} <span class="muted">${p.brg}°</span>` : ''}</td><td>${esc(p.comment || p.info)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="muted">Waiting for packets on 144.390…</div>';
  } else out.innerHTML = '';
}
function onDecode(m) {
  if (m.mode === 'cw') {
    decHist.cw = (decHist.cw + m.add).slice(-3000);
    const t = $('cwText');
    if (t) {
      t.textContent = decHist.cw;
      t.scrollTop = t.scrollHeight;
    }
    if ($('cwMeta')) $('cwMeta').textContent = `≈ ${m.wpm} WPM · tone ${m.tone} Hz`;
    return;
  }
  decHist[m.mode] = [...m.items.slice().reverse(), ...(decHist[m.mode] || [])].slice(0, 500);
  if (decoder.mode === m.mode) renderDecoder();
}
$('decModes').onclick = (e) => {
  const b = e.target.closest('[data-dec]');
  if (!b) return;
  const mode = b.dataset.dec;
  if (mode === 'off') return cmd({ cmd: 'decoderStop' });
  const dial = mode === 'ft8' ? (FT8_DIALS.find(([f]) => Math.abs(S.freq - f) < 200e3)?.[0] || 14.074e6) : mode === 'ft4' ? (FT4_DIALS.find(([f]) => Math.abs(S.freq - f) < 200e3)?.[0] || 14.08e6) : undefined;
  cmd({ cmd: 'decoderStart', mode, dial });
};
$('decDial').onchange = (e) => cmd({ cmd: 'decoderStart', mode: decoder.mode, dial: Number(e.target.value) });

// band survey
$('surveyGo').onclick = () => cmd({ cmd: 'hamSurvey' });
function renderSurvey() {
  const r = survey;
  if (!r) {
    $('survey').innerHTML = '<div class="muted">Not run yet.</div>';
    return;
  }
  $('surveyInfo').textContent = `${new Date(r.t).toLocaleTimeString()} · ${(r.took / 1000).toFixed(0)} s`;
  const max = Math.max(5, ...r.bands.map((b) => b.count));
  $('survey').innerHTML = r.bands.map((b) => `<div class="sb" data-band="${esc(b.name)}"><b>${b.name}</b><span><i style="width:${(b.count / max) * 100}%"></i></span><small>${b.count}</small>
    <div class="tops">${b.top.map((c) => `<a data-f="${c.freq}">${fmtMHz(c.freq, 3)} <span>+${Math.round(c.snr)}</span></a>`).join('') || 'quiet'}</div></div>`).join('');
}
$('survey').onclick = (e) => {
  const a = e.target.closest('[data-f]');
  if (!a) return;
  const f = Number(a.dataset.f);
  hamTune(f, f > 30e6 ? 'usb' : sideband(f), 2700, 500);
};

// ---- recordings ---------------------------------------------------------------------------------------------------
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`);
async function loadRecs() {
  try {
    const j = await fetch('api/recordings').then((r) => r.json());
    recList = j.list;
    $('recInfo').textContent = `${fmtSize(j.free)} free on the Pi`;
    renderRecs();
  } catch (e) {}
}
function renderRecState() {
  const r = S?.rec || {};
  $('rec').classList.toggle('on', !!r.audio);
  $('recAudio').textContent = r.audio ? '■ Stop audio recording' : '⏺ Record audio';
  $('recAudio').classList.toggle('on', !!r.audio);
  $('recIq').textContent = r.iq ? '■ Stop IQ recording' : '⏺ Record IQ (spectrum)';
  $('recIq').disabled = !!S?.playback;
  $('recPill').hidden = !(r.audio || r.iq);
  $('recPill').textContent = `● REC ${r.audio ? 'audio' : ''}${r.audio && r.iq ? ' + ' : ''}${r.iq ? 'IQ' : ''}`;
  const pb = S?.playback;
  $('playbar').hidden = !pb;
  if (pb) $('playName').textContent = `${fmtMHz(pb.meta.lo, 3)} MHz ± ${(pb.meta.fs / 2e6).toFixed(1)} · ${new Date(pb.meta.t).toLocaleString()} · tune anywhere inside it`;
}
function renderPlayPos() {
  if (!st.playing || document.activeElement === $('playPos')) return;
  $('playPos').value = String(st.playLen ? Math.round((st.playPos / st.playLen) * 1000) : 0);
  $('playTime').textContent = `${fmtDur(st.playPos)} / ${fmtDur(st.playLen)}`;
  $('playPause').textContent = st.paused ? '▶' : '⏸';
  if (st.iqRec) $('recPill').textContent = `● REC IQ ${fmtDur(st.iqRecSec)}`;
}
$('playPause').onclick = () => cmd({ cmd: 'playPause' });
$('playStop').onclick = () => cmd({ cmd: 'playStop' });
$('playPos').onchange = (e) => cmd({ cmd: 'playSeek', sec: (Number(e.target.value) / 1000) * (st.playLen || 0) });
$('recAudio').onclick = () => cmd({ cmd: S?.rec?.audio ? 'recStop' : 'recStart', kind: 'audio' });
$('recIq').onclick = () => cmd(S?.rec?.iq ? { cmd: 'recStop', kind: 'iq' } : { cmd: 'recStart', kind: 'iq', maxSec: Number($('recIqMax').value) * 60 });
function renderRecs() {
  $('recList').innerHTML = recList.length
    ? `<table><thead><tr><th></th><th>When</th><th>Frequency</th><th>Mode</th><th>Station</th><th>Length</th><th>Size</th><th></th></tr></thead><tbody>${recList.map((r) => `<tr class="recrow">
        <td><span class="reckind ${r.kind}">${r.kind === 'iq' ? 'IQ' : 'AUDIO'}</span></td><td class="mono">${new Date(r.t).toLocaleString()}</td>
        <td class="mono">${fmtMHz(r.freq, 4)}${r.kind === 'iq' ? ` <span class="muted">(± ${(r.fs / 2e6).toFixed(1)} MHz)</span>` : ''}</td><td>${(r.mode || '').toUpperCase()}</td><td>${esc(r.ps || '')}</td>
        <td class="mono">${fmtDur(r.dur || 0)}</td><td class="mono">${fmtSize(r.size)}</td>
        <td><span class="act">${r.kind === 'iq' ? `<button data-play="${r.file}">▶ Play in radio</button>` : `<button data-listen="${r.file}">▶ Play</button>`}<a class="btn" href="rec/${r.file}?dl=1">⬇</a><button data-del="${r.file}">🗑</button></span>
        <span data-player="${r.file}"></span></td></tr>`).join('')}</tbody></table>`
    : '<div class="muted">No recordings yet.</div>';
}
$('recList').onclick = (e) => {
  const t = e.target;
  if (t.dataset.play) return cmd({ cmd: 'playStart', file: t.dataset.play });
  if (t.dataset.del) return confirm(`Delete ${t.dataset.del}?`) && cmd({ cmd: 'recDelete', file: t.dataset.del });
  if (t.dataset.listen) {
    const box = document.querySelector(`[data-player="${t.dataset.listen}"]`);
    box.innerHTML = `<audio controls autoplay src="rec/${t.dataset.listen}"></audio>`;
  }
};

// ---- tabs ---------------------------------------------------------------------------------------------------------
function setTab(t) {
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === t);
  for (const d of document.querySelectorAll('.tab')) d.classList.toggle('on', d.dataset.tab === t);
  store.set('tab', t);
  if (t === 'scan') requestAnimationFrame(drawSearchPlot); // canvases in a hidden tab have no size
  if (t === 'onair') loadOnair();
  if (t === 'rec') loadRecs();
}
$('tabs').onclick = (e) => {
  const b = e.target.closest('button');
  if (b) setTab(b.dataset.tab);
};
setTab(store.get('tab', 'fm'));

// ---- FM ---------------------------------------------------------------------------------------------------------
$('fmFavOnly').checked = store.get('fmFavOnly', false);
$('fmFavOnly').onchange = (e) => (store.set('fmFavOnly', e.target.checked), renderFm());
$('fmScan').onclick = () => {
  if (fmScan?.running) cmd({ cmd: 'fmScanStop' });
  else cmd({ cmd: 'fmScan', rds: $('fmRds').checked });
};
function renderFmScan() {
  const s = fmScan;
  $('fmScan').textContent = s?.running ? 'Stop scan' : 'Scan FM band';
  $('fmScan').classList.toggle('on', !!s?.running);
  $('fmScanInfo').textContent = s?.running
    ? s.phase === 'sweep' ? 'Sweeping 87.5 – 108 MHz…' : `Identifying ${s.i} of ${s.n}${s.cur ? ` (${fmtMHz(s.cur, 1)})` : ''}…`
    : fmList.scanned ? `${fmList.stations.length} stations · scanned ${new Date(fmList.scanned).toLocaleString()}` : 'Not scanned yet';
}
function renderFm() {
  const favOnly = $('fmFavOnly').checked;
  const list = (fmList.stations || []).filter((s) => !favOnly || s.fav);
  const maxSnr = Math.max(30, ...list.map((s) => s.snr || 0));
  $('fmList').innerHTML = list.length
    ? list.map((s) => {
        const name = s.name || s.ps || '';
        const meta = [ptyName(s.pty), s.pi != null && s.pi >= 0 ? `PI ${s.pi.toString(16).toUpperCase()}` : '', s.stereo ? 'stereo' : '', s.missing ? 'not heard last scan' : '']
          .filter(Boolean).join(' · ');
        return `<div class="st${s.freq === S?.freq ? ' cur' : ''}${s.missing ? ' missing' : ''}" data-f="${s.freq}" title="${esc(s.rt || '')}">
          <span class="f">${fmtMHz(s.freq, 1)}</span><span class="n">${esc(name) || '<span class="muted">–</span>'}</span>
          <span><span class="bars" style="--p:${Math.round(((s.snr || 0) / maxSnr) * 100)}%"></span><button class="star" data-fav="${s.freq}">${s.fav ? '★' : '☆'}</button><button class="star" data-ren="${s.freq}" title="Rename">✎</button></span>
          <span class="m">${esc(meta)}${s.rt ? ` · ${esc(s.rt)}` : ''}</span></div>`;
      }).join('')
    : `<div class="muted">${favOnly ? 'No favourites yet: tap ☆ on a station.' : 'Press "Scan FM band" to find the stations you can receive.'}</div>`;
  renderFmScan();
}
$('fmList').onclick = (e) => {
  const fav = e.target.closest('[data-fav]'), ren = e.target.closest('[data-ren]'), card = e.target.closest('.st');
  if (fav) {
    const f = Number(fav.dataset.fav), s = fmList.stations.find((x) => x.freq === f);
    return cmd({ cmd: 'fmFav', freq: f, fav: !s?.fav });
  }
  if (ren) {
    const f = Number(ren.dataset.ren), s = fmList.stations.find((x) => x.freq === f);
    const n = prompt(`Name for ${fmtMHz(f, 1)} MHz (blank = use RDS):`, s?.name || s?.ps || '');
    if (n !== null) cmd({ cmd: 'fmName', freq: f, name: n });
    return;
  }
  if (card) cmd({ cmd: 'fmTune', freq: Number(card.dataset.f) });
};

// ---- bands --------------------------------------------------------------------------------------------------------
$('bandList').innerHTML = CATS.map((c) => {
  const bs = BANDS.filter((b) => b.cat === c);
  return bs.length
    ? `<div class="bandcat"><h4>${c}</h4><div class="bb">${bs.map((b) => `<button style="--c:${COLORS[c]}" data-b="${BANDS.indexOf(b)}">${esc(b.name)} <small>${fmtHz(b.tune)}</small></button>`).join('')}</div></div>`
    : '';
}).join('');
$('bandList').onclick = (e) => {
  const btn = e.target.closest('[data-b]');
  if (!btn) return;
  const b = BANDS[Number(btn.dataset.b)];
  step = b.step;
  store.set('step', step);
  cmd({ cmd: 'mode', mode: b.mode, bw: b.mode === 'wfm' ? undefined : b.bw });
  cmd({ cmd: 'set', step });
  // show the whole band if it fits in the captured span
  view.auto = true;
  tuneTo(b.tune, true);
};

// ---- memories -----------------------------------------------------------------------------------------------------
$('memSave').onclick = () => {
  cmd({ cmd: 'memorySave', name: $('memName').value || (rds?.freq === S.freq && rds.ps?.trim()) || '', group: $('memGroup').value || 'General' });
  $('memName').value = '';
  toast('Saved');
};
$('memFilter').oninput = () => renderMem();
$('memImport').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = await fetch('api/import', { method: 'POST', body: await f.text() }).then((x) => x.json()).catch((x) => ({ error: x.message }));
  toast(r.error ? `Import failed: ${r.error}` : `Imported ${r.memories} memories`, !!r.error);
  e.target.value = '';
};
function renderMem() {
  const q = $('memFilter').value.trim().toLowerCase();
  const groups = [...new Set(mems.map((m) => m.group))];
  $('memGroups').innerHTML = groups.map((g) => `<option value="${esc(g)}">`).join('');
  $('cGroup').innerHTML = `<option value="">All groups</option>` + groups.map((g) => `<option>${esc(g)}</option>`).join('');
  const list = mems.filter((m) => !q || `${m.name} ${m.group} ${fmtMHz(m.freq, 4)} ${m.mode}`.toLowerCase().includes(q));
  if (!list.length) {
    $('memList').innerHTML = `<div class="muted">${mems.length ? 'Nothing matches.' : 'No memories yet. Tune something and press "Save current", or save search results.'}</div>`;
    return;
  }
  let html = '<table><thead><tr><th>Name</th><th>Frequency</th><th>Mode</th><th>BW</th><th></th></tr></thead><tbody>', g = null;
  for (const m of list) {
    if (m.group !== g) {
      g = m.group;
      html += `<tr class="grouphead"><td colspan="5">${esc(g)}</td></tr>`;
    }
    html += `<tr class="click${m.freq === S?.freq ? ' cur' : ''}" data-id="${m.id}"><td>${esc(m.name) || '<span class="muted">–</span>'}${m.lockout ? ' <span class="muted">(locked out)</span>' : ''}</td>
      <td class="mono">${fmtMHz(m.freq, 4)}</td><td>${m.mode.toUpperCase()}</td><td class="mono">${m.bw >= 1000 ? +(m.bw / 1000).toFixed(2) + 'k' : m.bw}</td>
      <td><span class="act"><button data-edit="${m.id}">Edit</button><button data-lock="${m.id}">${m.lockout ? 'Unlock' : 'Lock out'}</button><button data-del="${m.id}">Delete</button></span></td></tr>`;
  }
  $('memList').innerHTML = html + '</tbody></table>';
}
$('memList').onclick = (e) => {
  const t = e.target;
  const id = t.dataset.edit || t.dataset.lock || t.dataset.del;
  const m = mems.find((x) => x.id === (id || t.closest('tr[data-id]')?.dataset.id));
  if (!m) return;
  if (t.dataset.del) return confirm(`Delete "${m.name || fmtMHz(m.freq, 4)}"?`) && cmd({ cmd: 'memoryDelete', id: m.id });
  if (t.dataset.lock) return cmd({ cmd: 'memorySave', ...m, lockout: !m.lockout });
  if (t.dataset.edit) {
    const n = prompt('Name:', m.name);
    if (n === null) return;
    const g = prompt('Group:', m.group);
    if (g === null) return;
    return cmd({ cmd: 'memorySave', ...m, name: n, group: g || 'General' });
  }
  cmd({ cmd: 'memoryRecall', id: m.id });
};

// ---- search + scanner -------------------------------------------------------------------------------------------
const stepOpts = [1000, 2500, 5000, 6250, 8330, 10000, 12500, 15000, 20000, 25000, 50000, 100000, 200000];
for (const id of ['sStep', 'cStep']) $(id).innerHTML = stepOpts.map((s) => `<option value="${s}">${fmtStep(s)}</option>`).join('');
for (const id of ['sMode', 'cMode']) $(id).innerHTML = MODES.map((m) => `<option value="${m}">${m.toUpperCase()}</option>`).join('');
for (const id of ['sPreset', 'cPreset']) $(id).innerHTML = `<option value="">Preset range…</option>` + SCAN_PRESETS.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
function presetInto(prefix, p) {
  $(prefix + 'Start').value = fmtMHz(p.start, 4).replace(/0+$/, '').replace(/\.$/, '');
  $(prefix + 'Stop').value = fmtMHz(p.stop, 4).replace(/0+$/, '').replace(/\.$/, '');
  $(prefix + 'Step').value = String(p.step);
  $(prefix + 'Mode').value = p.mode;
}
$('sPreset').onchange = (e) => e.target.value && presetInto('s', SCAN_PRESETS[Number(e.target.value)]);
$('cPreset').onchange = (e) => e.target.value && presetInto('c', SCAN_PRESETS[Number(e.target.value)]);
presetInto('s', SCAN_PRESETS[0]);
presetInto('c', SCAN_PRESETS[0]);
const formFreq = (id) => parseFreq($(id).value.includes('k') || $(id).value.includes('M') ? $(id).value : $(id).value + 'M');
$('sGo').onclick = () => {
  const start = formFreq('sStart'), stop = formFreq('sStop');
  if (!start || !stop || stop <= start) return toast('Search: enter a range in MHz', true);
  cmd({ cmd: 'search', start, stop, step: Number($('sStep').value), mode: $('sMode').value, threshold: Number($('sThr').value) });
};
$('sCancel').onclick = () => cmd({ cmd: 'searchCancel' });
function renderSearch() {
  const s = lastSearch;
  if (!s) return;
  $('sInfo').textContent = `${s.channels.length} active channel${s.channels.length === 1 ? '' : 's'} in ${fmtHz(s.start)} – ${fmtHz(s.stop)} · noise ${s.floor} dB · ${(s.took / 1000).toFixed(1)} s · ${new Date(s.t).toLocaleTimeString()}`;
  $('sActions').hidden = !s.channels.length;
  const max = Math.max(...s.channels.map((c) => c.snr), 20);
  $('sResults').innerHTML = s.channels.length
    ? `<table><thead><tr><th><input type="checkbox" id="sAll"></th><th>Frequency</th><th>Band</th><th>Level</th><th>Above noise</th><th></th></tr></thead><tbody>${s.channels
        .map((c, i) => `<tr class="click${c.freq === S?.freq ? ' cur' : ''}" data-i="${i}"><td><input type="checkbox" data-sel="${i}"></td><td class="mono">${fmtMHz(c.freq, 4)}</td><td class="muted">${esc(bandAt(c.freq)?.name || '')}</td>
          <td class="mono">${c.level} dB</td><td><span class="lvl" style="width:${Math.round((c.snr / max) * 80)}px"></span> ${c.snr} dB</td><td><button data-listen="${i}">Listen</button></td></tr>`).join('')}</tbody></table>`
    : '<div class="muted">Nothing above the threshold. Try a lower threshold, or another antenna.</div>';
  drawSearchPlot();
}
function drawSearchPlot() {
  const c = $('sPlot'), s = lastSearch;
  const w = (c.width = c.clientWidth * dpr), h = (c.height = c.clientHeight * dpr), g = c.getContext('2d');
  g.fillStyle = '#0a1118';
  g.fillRect(0, 0, w, h);
  if (!s?.spectrum) return;
  const db = s.spectrum.db.map((v) => v / 10).filter((v) => v > -190);
  if (!db.length) return;
  const all = s.spectrum.db.map((v) => v / 10), lo = Math.min(...db), hi = Math.max(...db);
  g.strokeStyle = '#7fd3ff';
  g.beginPath();
  all.forEach((v, i) => {
    const x = (i / (all.length - 1)) * w, y = h - ((Math.max(v, lo) - lo) / (hi - lo + 1e-9)) * (h - 6) - 2;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.stroke();
  g.fillStyle = '#ffca28';
  for (const ch of s.channels) g.fillRect(((ch.freq - s.start) / (s.stop - s.start)) * w - 0.5, 0, 1, 5 * dpr);
}
$('sResults').onclick = (e) => {
  if (e.target.id === 'sAll') return document.querySelectorAll('[data-sel]').forEach((x) => (x.checked = e.target.checked));
  if (e.target.matches('input')) return;
  const i = e.target.dataset.listen ?? e.target.closest('tr[data-i]')?.dataset.i;
  if (i == null) return;
  const c = lastSearch.channels[Number(i)];
  if (lastSearch.mode !== S.mode) cmd({ cmd: 'mode', mode: lastSearch.mode });
  tuneTo(c.freq, true);
};
const selected = () => [...document.querySelectorAll('[data-sel]:checked')].map((x) => lastSearch.channels[Number(x.dataset.sel)]);
const saveItems = (items) => cmd({ cmd: 'memoryBulk', group: $('sGroup').value || 'Search', items: items.map((c) => ({ freq: c.freq, mode: lastSearch.mode, bw: lastSearch.bw, note: `${c.snr} dB above noise` })) });
$('sSaveSel').onclick = () => (selected().length ? saveItems(selected()) : toast('Tick some results first', true));
$('sSaveAll').onclick = () => saveItems(lastSearch.channels);
$('sScanThese').onclick = () => {
  $('cSource').value = 'search';
  $('cSource').onchange();
  $('cGo').click();
};
$('cSource').onchange = () => {
  const v = $('cSource').value;
  $('cRange').hidden = v !== 'range';
  $('cGroupL').hidden = v !== 'memories';
};
$('cGo').onclick = () => {
  const src = $('cSource').value;
  const m = { cmd: 'scanStart', source: src, threshold: Number($('cThr').value), dwell: Number($('cDwell').value), hang: Number($('cHang').value) * 1000, maxListen: Number($('cMax').value) * 1000, onHit: $('cOnHit').value };
  if (src === 'range') Object.assign(m, { start: formFreq('cStart'), stop: formFreq('cStop'), step: Number($('cStep').value), mode: $('cMode').value });
  if (src === 'memories') m.group = $('cGroup').value || null;
  cmd(m);
};
$('cStop2').onclick = () => cmd({ cmd: 'scanStop' });
$('cHold').onclick = () => cmd({ cmd: 'scanHold' });
$('cResume').onclick = () => cmd({ cmd: 'scanResume' });
$('cSkip').onclick = () => cmd({ cmd: 'scanSkip' });
$('cLock').onclick = () => cmd({ cmd: 'scanSkip', lockout: true });
$('cSave').onclick = () => cmd({ cmd: 'memorySave', name: '', group: 'Scanner' });
$('cClearLock').onclick = () => cmd({ cmd: 'lockoutsClear' });
function renderScan() {
  const s = scanInfo;
  $('fScan').classList.toggle('on', !!s?.on);
  $('cGo').disabled = !!s?.on;
  if (!s?.on) {
    $('cStat').textContent = 'Stopped.';
    return;
  }
  const cur = s.cur;
  $('cStat').innerHTML = `${s.phase === 'locked' ? '<b style="color:var(--acc2)">🔒 LOCKED</b>' : s.phase === 'listen' ? '<b style="color:var(--good)">● ACTIVE</b>' : '<span class="muted">scanning</span>'} ${cur ? fmtMHz(cur.freq, 4) + ' MHz' : ''} ${cur?.name ? '· ' + esc(cur.name) : ''}
    <span class="muted"> · channel ${s.idx + 1} of ${s.n}${s.phase === 'locked' ? ' · press Resume (or Skip) to carry on' : ''}</span>`;
}
function renderHits() {
  $('hitList').innerHTML = hits.length
    ? `<table><thead><tr><th>Time</th><th>Frequency</th><th>Mode</th><th>Name</th><th>Level</th></tr></thead><tbody>${hits
        .slice(0, 300).map((h) => `<tr class="click" data-f="${h.freq}" data-m="${h.mode}"><td class="mono">${new Date(h.t).toLocaleString()}</td><td class="mono">${fmtMHz(h.freq, 4)}</td><td>${h.mode.toUpperCase()}</td><td>${esc(h.name)}</td><td class="mono">${h.level?.toFixed?.(0) ?? ''} dBFS</td></tr>`).join('')}</tbody></table>`
    : '<div class="muted">The scanner logs every stop here.</div>';
}
$('hitList').onclick = (e) => {
  const tr = e.target.closest('tr[data-f]');
  if (!tr) return;
  if (tr.dataset.m !== S.mode) cmd({ cmd: 'mode', mode: tr.dataset.m });
  tuneTo(Number(tr.dataset.f), true);
};
$('hitsClear').onclick = () => confirm('Clear the scanner log?') && cmd({ cmd: 'hitsClear' });

// ---- radio tab --------------------------------------------------------------------------------------------------
for (const r of document.querySelectorAll('input[name=ant]')) {
  r.onchange = () => {
    const v = r.value;
    if (v === 'auto') cmd({ cmd: 'set', antAuto: true });
    else cmd({ cmd: 'set', antAuto: false, tuner: v === 'B' ? 'B' : 'A', hiz: v === 'AH', biasT: v === 'B' ? $('biasT').checked : false });
  };
}
$('antSplit').onchange = (e) => cmd({ cmd: 'set', antSplit: Number(e.target.value) * 1e6 });
for (const k of ['biasT', 'fmNotch', 'dabNotch', 'amNotch', 'agc', 'stereo', 'lnaAuto']) $(k).onchange = (e) => cmd({ cmd: 'set', [k]: e.target.checked });
for (const k of ['agcSet', 'ppm', 'cwPitch']) $(k).onchange = (e) => cmd({ cmd: 'set', [k]: Number(e.target.value) });
for (const k of ['fftN', 'fps', 'deemph']) $(k).onchange = (e) => cmd({ cmd: 'set', [k]: Number(e.target.value) });
$('fmGrid').onchange = (e) => cmd({ cmd: 'set', fmGrid: e.target.value });
$('lna').onchange = (e) => cmd({ cmd: 'set', lna: Number(e.target.value) });
$('gr').onchange = (e) => cmd({ cmd: 'set', gr: Number(e.target.value) });

// ---- start ----------------------------------------------------------------------------------------------------------
setInterval(() => renderRds(), 1000);
sizeCanvases();
renderHits();
connect();
