// sdr-engine: the radio half of Pi-SDR. Drives an SDRplay RSPduo through the SDRplay API 3.x and does all the DSP:
// spectrum (FFTW), channel selection, demodulation (WFM stereo with RDS, NFM, AM, USB, LSB, CW), squelch, and wide
// sweeps for the scanners. Talks to the Node server over pipes:
//   stdin:  one JSON object per line, e.g. {"cmd":"set","lo":100000000,"vfo":300000,"mode":"wfm"}
//   stdout: frames [u32 length][u8 type][payload]: 1 spectrum, 2 audio (48 kHz s16), 3 JSON text
// Everything about the radio is in the "set" keys (see apply()); the server owns tuning policy and scanning.
#include <sdrplay_api.h>
#include <fftw3.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <iostream>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

#include "dsp.h"
#include "rds.h"

static const double AUDIO_RATE = 48000;

// ---- output framing -------------------------------------------------------------------------------------------
static std::mutex outMu;
static void writeFrame(uint8_t type, const void *data, size_t len) {
  std::lock_guard<std::mutex> lk(outMu);
  uint32_t n = (uint32_t)len + 1;
  fwrite(&n, 4, 1, stdout);
  fwrite(&type, 1, 1, stdout);
  if (len) fwrite(data, 1, len, stdout);
  fflush(stdout);
}
static void sendJson(const std::string &s) { writeFrame(3, s.data(), s.size()); }
static void logMsg(const std::string &level, const std::string &msg) {
  std::string m;
  for (char c : msg) {
    if (c == '"' || c == '\\') m += '\\';
    if ((unsigned char)c >= 0x20) m += c;
  }
  sendJson("{\"type\":\"log\",\"level\":\"" + level + "\",\"msg\":\"" + m + "\"}");
}

// ---- minimal JSON (flat objects of numbers, strings, booleans, null) --------------------------------------------
struct JVal {
  enum { NUM, STR, BOOL, NUL } t = NUL;
  double n = 0;
  std::string s;
  bool b = false;
};
static std::map<std::string, JVal> parseFlat(const std::string &in) {
  std::map<std::string, JVal> m;
  size_t i = 0;
  auto ws = [&] { while (i < in.size() && isspace((unsigned char)in[i])) i++; };
  auto str = [&]() {
    std::string o;
    i++; // opening quote
    while (i < in.size() && in[i] != '"') {
      if (in[i] == '\\' && i + 1 < in.size()) i++;
      o += in[i++];
    }
    i++;
    return o;
  };
  ws();
  if (i >= in.size() || in[i] != '{') return m;
  i++;
  while (i < in.size()) {
    ws();
    if (in[i] == '}') break;
    if (in[i] != '"') break;
    std::string k = str();
    ws();
    if (in[i] != ':') break;
    i++;
    ws();
    JVal v;
    if (in[i] == '"') { v.t = JVal::STR; v.s = str(); }
    else if (in.compare(i, 4, "true") == 0) { v.t = JVal::BOOL; v.b = true; i += 4; }
    else if (in.compare(i, 5, "false") == 0) { v.t = JVal::BOOL; v.b = false; i += 5; }
    else if (in.compare(i, 4, "null") == 0) { v.t = JVal::NUL; i += 4; }
    else {
      size_t j = i;
      while (j < in.size() && (isdigit((unsigned char)in[j]) || strchr("+-.eE", in[j]))) j++;
      v.t = JVal::NUM;
      v.n = atof(in.substr(i, j - i).c_str());
      i = j;
    }
    m[k] = v;
    ws();
    if (i < in.size() && in[i] == ',') i++;
  }
  return m;
}

// ---- settings ---------------------------------------------------------------------------------------------------
struct Settings {
  double lo = 100.0e6;       // hardware centre frequency
  double vfo = 300e3;        // listening offset from lo
  double fs = 2.4e6;         // sample rate (span)
  std::string mode = "wfm";  // wfm nfm am usb lsb cw
  double bw = 180e3;         // channel bandwidth
  bool sqOn = false;
  double sq = 10;            // squelch: dB above the channel's noise level
  bool stereo = true;
  double deemph = 75e-6;
  int lna = 3, gr = 40;
  bool agc = true;
  int agcSet = -30;
  std::string tuner = "A";   // A = tuner 1, B = tuner 2
  bool hiz = false;          // tuner 1 Hi-Z (AM) port
  bool fmNotch = false, dabNotch = false, amNotch = false, biasT = false;
  double ppm = 0;
  int fftN = 4096, fps = 20;
  double cwPitch = 700;
  bool audio = true;
} S;

// ---- SDRplay device ---------------------------------------------------------------------------------------------
struct Block {
  std::vector<float> i, q;
  uint32_t gen;
};
static std::mutex qMu;
static std::condition_variable qCv;
static std::deque<Block> queue_;
static std::vector<Block> pool;
static std::atomic<uint32_t> rfGen{0};
static std::atomic<long> dropped{0};
static std::atomic<int> settleLeft{0};
static std::atomic<bool> deviceGone{false}, overload{false};
static std::atomic<int> gainGr{0}, gainLnaGr{0};
static std::atomic<double> gainCurr{0};

static sdrplay_api_DeviceT dev;
static sdrplay_api_DeviceParamsT *params = nullptr;
static sdrplay_api_RxChannelParamsT *ch = nullptr;
static bool streaming = false, apiOpen = false;

static void streamCb(short *xi, short *xq, sdrplay_api_StreamCbParamsT *p, unsigned int n, unsigned int reset, void *) {
  if (p->rfChanged) {
    rfGen++;
    settleLeft = (int)(S.fs * 0.003);
  }
  unsigned int start = 0;
  int sl = settleLeft.load();
  if (sl > 0) { // just retuned: drop a few ms while the tuner and DC correction settle
    unsigned int d = std::min<unsigned int>(n, (unsigned)sl);
    settleLeft -= d;
    start = d;
    if (start >= n) return;
  }
  Block b;
  {
    std::lock_guard<std::mutex> lk(qMu);
    if (!pool.empty()) { b = std::move(pool.back()); pool.pop_back(); }
  }
  unsigned int m = n - start;
  b.i.resize(m);
  b.q.resize(m);
  const float k = 1.0f / 32768.0f;
  for (unsigned int j = 0; j < m; j++) {
    b.i[j] = xi[start + j] * k;
    b.q[j] = xq[start + j] * k;
  }
  b.gen = rfGen.load();
  {
    std::lock_guard<std::mutex> lk(qMu);
    // Keep at most ~0.5 s queued: if the DSP falls behind, drop the oldest.
    size_t queued = 0;
    for (auto &x : queue_) queued += x.i.size();
    while (queued > S.fs * 0.5 && !queue_.empty()) {
      queued -= queue_.front().i.size();
      dropped += queue_.front().i.size();
      pool.push_back(std::move(queue_.front()));
      queue_.pop_front();
    }
    queue_.push_back(std::move(b));
  }
  qCv.notify_one();
}

static void eventCb(sdrplay_api_EventT id, sdrplay_api_TunerSelectT tuner, sdrplay_api_EventParamsT *p, void *) {
  if (id == sdrplay_api_GainChange) {
    gainGr = p->gainParams.gRdB;
    gainLnaGr = p->gainParams.lnaGRdB;
    gainCurr = p->gainParams.currGain;
  } else if (id == sdrplay_api_PowerOverloadChange) {
    overload = p->powerOverloadParams.powerOverloadChangeType == sdrplay_api_Overload_Detected;
    sdrplay_api_Update(dev.dev, tuner, sdrplay_api_Update_Ctrl_OverloadMsgAck, sdrplay_api_Update_Ext1_None);
  } else if (id == sdrplay_api_DeviceRemoved || id == sdrplay_api_DeviceFailure) {
    deviceGone = true;
    qCv.notify_one();
  }
}

static int lnaMax(double f) {
  if (S.tuner == "A" && S.hiz && f < 60e6) return 4;
  if (f < 60e6) return 6;
  if (f < 1000e6) return 9;
  return 8;
}

static sdrplay_api_Bw_MHzT bwFor(double fs) {
  if (fs >= 9e6) return sdrplay_api_BW_8_000;
  if (fs >= 7.5e6) return sdrplay_api_BW_7_000;
  if (fs >= 6.5e6) return sdrplay_api_BW_6_000;
  if (fs >= 5.5e6) return sdrplay_api_BW_5_000;
  return sdrplay_api_BW_1_536;
}

static bool check(sdrplay_api_ErrT e, const char *what) {
  if (e == sdrplay_api_Success) return true;
  logMsg("error", std::string(what) + ": " + sdrplay_api_GetErrorString(e));
  return false;
}

static void fillParams() {
  params->devParams->fsFreq.fsHz = S.fs;
  params->devParams->ppm = S.ppm;
  ch->tunerParams.bwType = bwFor(S.fs);
  ch->tunerParams.ifType = sdrplay_api_IF_Zero;
  ch->tunerParams.loMode = sdrplay_api_LO_Auto;
  ch->tunerParams.rfFreq.rfHz = S.lo;
  S.lna = std::max(0, std::min(S.lna, lnaMax(S.lo)));
  ch->tunerParams.gain.LNAstate = (unsigned char)S.lna;
  ch->tunerParams.gain.gRdB = S.gr;
  ch->tunerParams.gain.minGr = sdrplay_api_NORMAL_MIN_GR;
  ch->ctrlParams.agc.enable = S.agc ? sdrplay_api_AGC_50HZ : sdrplay_api_AGC_DISABLE;
  ch->ctrlParams.agc.setPoint_dBfs = S.agcSet;
  ch->ctrlParams.dcOffset.DCenable = 1;
  ch->ctrlParams.dcOffset.IQenable = 1;
  ch->ctrlParams.decimation.enable = 0;
  // Hi-Z port and MW notch exist on tuner 1 only
  ch->rspDuoTunerParams.tuner1AmPortSel = S.tuner == "A" && S.hiz ? sdrplay_api_RspDuo_AMPORT_1 : sdrplay_api_RspDuo_AMPORT_2;
  ch->rspDuoTunerParams.tuner1AmNotchEnable = S.tuner == "A" && S.amNotch;
  ch->rspDuoTunerParams.rfNotchEnable = S.fmNotch;
  ch->rspDuoTunerParams.rfDabNotchEnable = S.dabNotch;
  ch->rspDuoTunerParams.biasTEnable = S.tuner == "B" && S.biasT;
}

static void closeDevice() {
  if (streaming) { sdrplay_api_Uninit(dev.dev); streaming = false; }
  if (apiOpen) {
    sdrplay_api_LockDeviceApi();
    sdrplay_api_ReleaseDevice(&dev);
    sdrplay_api_UnlockDeviceApi();
  }
}

// Open the RSPduo in single tuner mode on the chosen tuner and start streaming.
static bool openDevice() {
  if (!apiOpen) {
    if (!check(sdrplay_api_Open(), "sdrplay_api_Open (is the sdrplay service running?)")) return false;
    float ver = 0;
    sdrplay_api_ApiVersion(&ver);
    apiOpen = true;
  }
  sdrplay_api_LockDeviceApi();
  sdrplay_api_DeviceT devs[SDRPLAY_MAX_DEVICES];
  unsigned int nd = 0;
  sdrplay_api_GetDevices(devs, &nd, SDRPLAY_MAX_DEVICES);
  int pick = -1;
  for (unsigned int k = 0; k < nd; k++)
    if (devs[k].hwVer == SDRPLAY_RSPduo_ID) { pick = (int)k; break; }
  if (pick < 0 && nd > 0) pick = 0;
  if (pick < 0) {
    sdrplay_api_UnlockDeviceApi();
    logMsg("error", "no SDRplay device found");
    return false;
  }
  dev = devs[pick];
  if (dev.hwVer == SDRPLAY_RSPduo_ID) {
    dev.rspDuoMode = sdrplay_api_RspDuoMode_Single_Tuner;
    dev.tuner = S.tuner == "B" ? sdrplay_api_Tuner_B : sdrplay_api_Tuner_A;
  }
  if (!check(sdrplay_api_SelectDevice(&dev), "SelectDevice")) { sdrplay_api_UnlockDeviceApi(); return false; }
  sdrplay_api_UnlockDeviceApi();
  if (!check(sdrplay_api_GetDeviceParams(dev.dev, &params), "GetDeviceParams")) return false;
  ch = dev.tuner == sdrplay_api_Tuner_B ? params->rxChannelB : params->rxChannelA;
  fillParams();
  sdrplay_api_CallbackFnsT cb = {streamCb, streamCb, eventCb};
  if (!check(sdrplay_api_Init(dev.dev, &cb, nullptr), "Init")) return false;
  streaming = true;
  char buf[256];
  snprintf(buf, sizeof buf, "{\"type\":\"device\",\"serial\":\"%s\",\"hwVer\":%d,\"tuner\":\"%s\"}", dev.SerNo, dev.hwVer,
           S.tuner.c_str());
  sendJson(buf);
  return true;
}

// The device can still be held for a moment by a previous engine (a restart): retry for ~15 s.
static bool openDeviceRetry() {
  for (int k = 0; k < 15; k++) {
    if (openDevice()) return true;
    std::this_thread::sleep_for(std::chrono::seconds(1));
  }
  return false;
}
// Leave without running library destructors: the SDRplay API's threads can block a normal exit.
static void leave(int code) {
  fflush(stdout);
  _exit(code);
}

static void update(sdrplay_api_ReasonForUpdateT r) {
  if (!streaming) return;
  sdrplay_api_ErrT e = sdrplay_api_Update(dev.dev, dev.tuner, r, sdrplay_api_Update_Ext1_None);
  if (e != sdrplay_api_Success) logMsg("warn", std::string("Update: ") + sdrplay_api_GetErrorString(e));
}

// ---- DSP chain --------------------------------------------------------------------------------------------------
struct Chain {
  double fs = 0, r1 = 0, r2 = 0;
  int D1 = 1;
  NCO shift;                        // moves the VFO to 0 Hz at fs
  DecimFIR dec1, dec2;              // fs -> r1 -> r2 (~240 kHz)
  // WFM
  Resampler audioRs;                // r2 -> 48 kHz: channel 0 mono (L+R), channel 1 stereo difference (L-R)
  Resampler rdsRs;                  // 57 kHz baseband (I/Q) -> 19 kHz
  NCO rdsMix;
  Biquad pilotBp;
  double pPhase = 0, pFreq = 0, pFreq0 = 0, pLock = 0, pAmp = 0;
  float lastI = 1, lastQ = 0;
  double deL = 0, deR = 0, deA = 0;
  RdsDecoder rds;
  // narrow modes
  Resampler narrowRs;               // r2 -> 48 kHz (I/Q)
  RealFIR chI, chQ;                 // AM / NFM channel filter
  ComplexFIR side;                  // USB / LSB / CW sideband filter
  NCO cwShift;
  Biquad nfmHp;
  double amDc = 0, ssbEnv = 1e-3;
  float nLastI = 1, nLastQ = 0;
  // level and squelch
  double levelAcc = 0;
  long levelN = 0;
  double level = -120, noiseCh = -100; // channel level and the noise level in the channel bandwidth (dBFS)
  bool sqOpen = true;
  // Bandwidth the level is measured over: the ~240 kHz WFM channel, else the channel filter.
  double measBw() const { return S.mode == "wfm" ? r2 : std::max(100.0, S.bw); }

  void build() {
    fs = S.fs;
    D1 = std::max(2, (int)std::lround(fs / 480e3));
    r1 = fs / D1;
    r2 = r1 / 2;
    double pass = std::min(110e3, r2 * 0.45);
    dec1.init(design_lowpass(kaiser_taps((r1 - 2 * pass) / fs), (r1 / 2) / fs), D1);
    dec2.init(design_lowpass(kaiser_taps((r2 - 2 * 100e3) / r1), (r2 / 2) / r1), 2);
    shift.set(-S.vfo, fs);
    // WFM: audio band to 15 kHz, removing the 19 kHz pilot
    audioRs.init(r2, AUDIO_RATE, 15500, 3000, 2);
    rdsRs.init(r2, 19000, 2400, 4000, 2);
    rdsMix.set(-57000, r2);
    pilotBp.bandpass(19000, 25, r2);
    pFreq0 = pFreq = 2 * PI * 19000 / r2;
    pPhase = 0;
    pLock = pAmp = 0;
    deA = 1 - std::exp(-1.0 / (AUDIO_RATE * S.deemph));
    rds.reset();
    // narrow
    narrowRs.init(r2, AUDIO_RATE, 21000, 6000, 2);
    buildNarrow();
  }

  void buildNarrow() {
    double bw = S.bw;
    if (S.mode == "am" || S.mode == "nfm") {
      double half = std::min(bw / 2, 20000.0);
      auto h = design_lowpass(kaiser_taps(std::max(half * 0.25, 600.0) / AUDIO_RATE, 60), half / AUDIO_RATE, 60);
      chI.init(h);
      chQ.init(h);
    } else if (S.mode == "usb" || S.mode == "lsb" || S.mode == "cw") {
      double lo, hi;
      if (S.mode == "cw") { lo = S.cwPitch - bw / 2; hi = S.cwPitch + bw / 2; }
      else { lo = 200; hi = 200 + bw; }
      if (S.mode == "lsb") { double t = lo; lo = -hi; hi = -t; }
      double fc = (lo + hi) / 2, half = (hi - lo) / 2;
      auto h = design_lowpass(kaiser_taps(std::max(half * 0.2, 150.0) / AUDIO_RATE, 60), half / AUDIO_RATE, 60);
      std::vector<float> ti(h.size()), tq(h.size());
      double m = (h.size() - 1) / 2.0;
      for (size_t k = 0; k < h.size(); k++) {
        double w = 2 * PI * fc * (k - m) / AUDIO_RATE;
        ti[k] = (float)(h[k] * std::cos(w));
        tq[k] = (float)(h[k] * std::sin(w));
      }
      side.init(ti, tq);
      cwShift.set(S.mode == "cw" ? S.cwPitch : 0, AUDIO_RATE);
    }
    nfmHp.highpass(250, 0.707, AUDIO_RATE);
  }

  // scratch
  std::vector<float> a, b, c, d, e, f, g, h, mono, diff;
  std::vector<int16_t> pcm;

  void levelAdd(const float *ii, const float *qq, size_t n) {
    double s = 0;
    for (size_t k = 0; k < n; k++) s += ii[k] * ii[k] + qq[k] * qq[k];
    levelAcc += s;
    levelN += n;
  }

  // One block at fs, already in this chain's buffers.
  void run(std::vector<float> &bi, std::vector<float> &bq) {
    shift.mix(bi.data(), bq.data(), bi.size());
    dec1.process(bi.data(), bq.data(), bi.size(), a, b);
    dec2.process(a.data(), b.data(), a.size(), c, d);
    if (c.empty()) return;
    if (S.mode == "wfm") runWfm(c, d);
    else runNarrow(c, d);
  }

  void squelchAudio(std::vector<int16_t> &v) {
    if (!S.sqOn) { sqOpen = true; return; }
    double thr = noiseCh + S.sq;
    if (sqOpen && level < thr - 3) sqOpen = false;
    else if (!sqOpen && level > thr) sqOpen = true;
    if (!sqOpen) std::fill(v.begin(), v.end(), 0);
  }

  void runWfm(std::vector<float> &ii, std::vector<float> &qq) {
    size_t n = ii.size();
    levelAdd(ii.data(), qq.data(), n);
    // FM discriminator -> MPX, scaled so +-75 kHz deviation is +-1
    e.resize(n);
    const double k = r2 / (2 * PI) / 75000.0;
    for (size_t j = 0; j < n; j++) {
      float re = ii[j] * lastI + qq[j] * lastQ, im = qq[j] * lastI - ii[j] * lastQ;
      lastI = ii[j];
      lastQ = qq[j];
      e[j] = (float)(std::atan2(im, re) * k);
    }
    // pilot PLL and the 38 kHz stereo difference
    f.resize(n);
    for (size_t j = 0; j < n; j++) {
      double p = pilotBp.run(e[j]);
      double s = std::sin(pPhase), c = std::cos(pPhase);
      pAmp += 0.0005 * (std::fabs(p) - pAmp);
      double err = pAmp > 1e-6 ? -p * s / pAmp : 0;
      pLock += 0.0005 * ((pAmp > 1e-6 ? p * c / pAmp : 0) - pLock);
      pFreq += 2e-7 * err;
      if (std::fabs(pFreq - pFreq0) > pFreq0 * 0.002) pFreq = pFreq0;
      pPhase += pFreq + 0.003 * err;
      if (pPhase > PI) pPhase -= 2 * PI;
      f[j] = (float)(e[j] * -2 * std::sin(2 * pPhase));
    }
    // RDS: 57 kHz down to baseband, then 19 kHz
    g.assign(e.begin(), e.end());
    h.assign(n, 0.0f);
    rdsMix.mix(g.data(), h.data(), n);
    std::vector<float> ri, rq;
    rdsRs.process(g.data(), h.data(), n, ri, rq);
    rds.process(ri.data(), rq.data(), ri.size());
    if (rds.dirty) { rds.dirty = false; sendJson(rds.json()); }
    // audio
    audioRs.process(e.data(), f.data(), n, mono, diff);
    bool st = S.stereo && stereo();
    pcm.resize(mono.size() * 2);
    for (size_t j = 0; j < mono.size(); j++) {
      double L = st ? (mono[j] + diff[j]) : mono[j], R = st ? (mono[j] - diff[j]) : mono[j];
      if (st) { L *= 0.5; R *= 0.5; }
      deL += deA * (L - deL);
      deR += deA * (R - deR);
      pcm[2 * j] = (int16_t)std::max(-32767.0, std::min(32767.0, deL * 26000));
      pcm[2 * j + 1] = (int16_t)std::max(-32767.0, std::min(32767.0, deR * 26000));
    }
    squelchAudio(pcm);
    emitAudio(2);
  }

  bool stereo() const { return pLock > 0.5 && pAmp > 0.01; }

  void runNarrow(std::vector<float> &ii, std::vector<float> &qq) {
    narrowRs.process(ii.data(), qq.data(), ii.size(), a, b); // a/b now 48 kHz I/Q
    size_t n = a.size();
    if (!n) return;
    pcm.resize(n);
    if (S.mode == "am" || S.mode == "nfm") {
      c.resize(n);
      d.resize(n);
      chI.process(a.data(), n, c.data());
      chQ.process(b.data(), n, d.data());
      levelAdd(c.data(), d.data(), n);
      for (size_t j = 0; j < n; j++) {
        double out;
        if (S.mode == "am") {
          double env = std::sqrt(c[j] * c[j] + d[j] * d[j]);
          amDc += 0.0003 * (env - amDc);
          out = amDc > 1e-9 ? (env - amDc) / amDc * 0.6 : 0;
        } else {
          float re = c[j] * nLastI + d[j] * nLastQ, im = d[j] * nLastI - c[j] * nLastQ;
          nLastI = c[j];
          nLastQ = d[j];
          out = nfmHp.run((float)(std::atan2(im, re) * AUDIO_RATE / (2 * PI) / 4000.0)) * 0.7;
        }
        pcm[j] = (int16_t)std::max(-32767.0, std::min(32767.0, out * 26000));
      }
    } else {
      if (S.mode == "cw") cwShift.mix(a.data(), b.data(), n);
      side.process(a.data(), b.data(), n, c, d);
      levelAdd(c.data(), d.data(), n);
      for (size_t j = 0; j < n; j++) {
        double x = c[j], ax = std::fabs(x);
        if (ax > ssbEnv) ssbEnv += 0.02 * (ax - ssbEnv);
        else ssbEnv *= 0.99997;
        double out = x * 0.35 / std::max(ssbEnv, 1e-5);
        pcm[j] = (int16_t)std::max(-32767.0, std::min(32767.0, out * 26000));
      }
    }
    squelchAudio(pcm);
    emitAudio(1);
  }

  std::vector<int16_t> pend;
  int pendCh = 1;
  void emitAudio(int chans) {
    if (!S.audio) return;
    if (chans != pendCh) { pend.clear(); pendCh = chans; }
    pend.insert(pend.end(), pcm.begin(), pcm.end());
    if (pend.size() >= (size_t)(960 * chans)) { // 20 ms
      std::vector<uint8_t> buf(4 + pend.size() * 2);
      buf[0] = (uint8_t)chans;
      memcpy(buf.data() + 4, pend.data(), pend.size() * 2);
      writeFrame(2, buf.data(), buf.size());
      pend.clear();
    }
  }

  void takeLevel() {
    if (levelN) level = 10 * std::log10(levelAcc / levelN + 1e-15);
    levelAcc = 0;
    levelN = 0;
  }
};

// ---- spectrum ---------------------------------------------------------------------------------------------------
struct Spectrum {
  int N = 0;
  fftwf_complex *buf = nullptr;
  fftwf_plan plan = nullptr;
  std::vector<float> win, acc;
  double winNorm = 1;
  int fill = 0, avgDone = 0, navg = 4;
  long skip = 0;
  double floorDb = -120;
  void setup(int n) {
    if (plan) { fftwf_destroy_plan(plan); fftwf_free(buf); }
    N = n;
    buf = (fftwf_complex *)fftwf_malloc(sizeof(fftwf_complex) * N);
    plan = fftwf_plan_dft_1d(N, buf, buf, FFTW_FORWARD, FFTW_ESTIMATE);
    win.resize(N);
    double s = 0;
    for (int k = 0; k < N; k++) { // Blackman-Harris
      double x = 2 * PI * k / (N - 1);
      win[k] = (float)(0.35875 - 0.48829 * std::cos(x) + 0.14128 * std::cos(2 * x) - 0.01168 * std::cos(3 * x));
      s += win[k];
    }
    winNorm = 1.0 / (s * s);
    acc.assign(N, 0);
    fill = avgDone = 0;
    skip = 0;
  }
  // Collect samples; returns true when acc holds a finished average (in linear power, fft-shifted later).
  bool feed(const float *ii, const float *qq, size_t n, double fs, int fps) {
    size_t k = 0;
    bool done = false;
    while (k < n) {
      if (skip > 0) {
        size_t s = std::min<size_t>(n - k, (size_t)skip);
        skip -= s;
        k += s;
        continue;
      }
      size_t take = std::min<size_t>(n - k, (size_t)(N - fill));
      for (size_t j = 0; j < take; j++) {
        buf[fill + j][0] = ii[k + j] * win[fill + j];
        buf[fill + j][1] = qq[k + j] * win[fill + j];
      }
      fill += (int)take;
      k += take;
      if (fill == N) {
        fftwf_execute(plan);
        for (int j = 0; j < N; j++) acc[j] += buf[j][0] * buf[j][0] + buf[j][1] * buf[j][1];
        fill = 0;
        avgDone++;
        long hop = (long)(fs / fps / navg);
        skip = std::max(0L, hop - N);
        if (avgDone >= navg) done = true;
      }
    }
    return done;
  }
  // Average to dB, fft-shifted into out (int8, 1 dB steps); resets the accumulator.
  void finish(std::vector<int8_t> &out, std::vector<float> *dbOut = nullptr) {
    out.resize(N);
    std::vector<float> db(N);
    for (int j = 0; j < N; j++) {
      int src = (j + N / 2) % N;
      double p = acc[src] / avgDone * winNorm;
      db[j] = (float)(10 * std::log10(p + 1e-20));
      out[j] = (int8_t)std::max(-127.0f, std::min(30.0f, std::round(db[j])));
    }
    // Noise floor: the median of the middle 60 % of the span (the edges sit on the IF filter's roll-off, where the
    // noise is artificially low; signals are few enough not to move the median much).
    std::vector<float> tmp(db.begin() + N / 5, db.begin() + N * 4 / 5);
    std::nth_element(tmp.begin(), tmp.begin() + tmp.size() / 2, tmp.end());
    floorDb = tmp[tmp.size() / 2];
    if (dbOut) *dbOut = db;
    std::fill(acc.begin(), acc.end(), 0);
    avgDone = 0;
  }
};

// ---- sweep (for scans) ------------------------------------------------------------------------------------------
struct Sweep {
  bool active = false;
  std::string id;
  double start = 0, stop = 0, binHz = 0, lo = 0, step = 0, savedLo = 0;
  int idx = 0, nSteps = 0;
  uint32_t waitGen = 0;
  bool waiting = false;
  int waitBlocks = 0;
  std::vector<float> out; // dB per output bin
  double outStart = 0, outStep = 0;
};

// ---- IQ recording and playback ------------------------------------------------------------------------------------
// Recording: the raw IQ as interleaved int16 (as the RSPduo delivers it) to a file the server names, plus retune
// events "sample:lo,..." so playback knows the centre frequency at every point. Playback: a thread reads the file at
// real time into the same queue the device fills, so spectrum, demodulators, RDS and decoders all work, and the
// listening frequency can be moved anywhere inside the recorded span.
static FILE *iqRec = nullptr;
static std::string iqRecPath, iqEvents;
static long long iqRecN = 0;
static double iqRecMaxSec = 300;

struct Player {
  std::thread th;
  std::atomic<bool> run{false}, paused{false};
  std::atomic<long long> pos{0}, seekTo{-1};
  long long total = 0;
  std::string path;
  bool loop = false;
  double fs = 2.4e6;
  std::vector<std::pair<long long, double>> events; // (sample, lo)
  std::atomic<double> lo{0};
} player;
static bool playing = false;

static double loAt(long long smp) {
  double lo = player.events.empty() ? S.lo : player.events[0].second;
  for (auto &e : player.events)
    if (e.first <= smp) lo = e.second;
  return lo;
}
static void playerLoop() {
  FILE *f = fopen(player.path.c_str(), "rb");
  if (!f) {
    logMsg("error", "can't open " + player.path);
    player.run = false;
    return;
  }
  size_t chunk = (size_t)(player.fs / 100); // 10 ms
  std::vector<int16_t> buf(chunk * 2);
  auto next = std::chrono::steady_clock::now();
  while (player.run) {
    if (player.paused) {
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      next = std::chrono::steady_clock::now();
      continue;
    }
    long long sk = player.seekTo.exchange(-1);
    if (sk >= 0) {
      fseeko(f, (off_t)sk * 4, SEEK_SET);
      player.pos = sk;
    }
    size_t got = fread(buf.data(), 4, chunk, f);
    if (got == 0) {
      if (player.loop) {
        fseeko(f, 0, SEEK_SET);
        player.pos = 0;
        continue;
      }
      sendJson("{\"type\":\"playEnd\"}");
      break;
    }
    player.lo = loAt(player.pos);
    Block b;
    b.i.resize(got);
    b.q.resize(got);
    for (size_t j = 0; j < got; j++) {
      b.i[j] = buf[2 * j] / 32768.0f;
      b.q[j] = buf[2 * j + 1] / 32768.0f;
    }
    b.gen = rfGen.load();
    {
      std::lock_guard<std::mutex> lk(qMu);
      if (queue_.size() < 200) queue_.push_back(std::move(b));
    }
    qCv.notify_one();
    player.pos += got;
    next += std::chrono::microseconds((long long)(got / player.fs * 1e6));
    std::this_thread::sleep_until(next);
  }
  fclose(f);
}
static void stopPlayer() {
  player.run = false;
  if (player.th.joinable()) player.th.join();
}
static void iqRecFinish() {
  if (!iqRec) return;
  fclose(iqRec);
  iqRec = nullptr;
  char buf[512];
  snprintf(buf, sizeof buf, "{\"type\":\"iqrec\",\"state\":\"stopped\",\"path\":\"%s\",\"samples\":%lld,\"fs\":%.0f,\"events\":\"%s\"}",
           iqRecPath.c_str(), iqRecN, S.fs, iqEvents.c_str());
  sendJson(buf);
}

// ---- main -------------------------------------------------------------------------------------------------------
static std::mutex cmdMu;
static std::deque<std::string> cmds;
static std::atomic<bool> quit{false};

static void readStdin() {
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    std::lock_guard<std::mutex> lk(cmdMu);
    cmds.push_back(line);
  }
  quit = true;
  qCv.notify_one();
}

int main() {
  signal(SIGPIPE, SIG_IGN);
  signal(SIGINT, [](int) { quit = true; });
  signal(SIGTERM, [](int) { quit = true; });
  setvbuf(stdout, nullptr, _IOFBF, 1 << 20);
  Chain chain;
  Spectrum spec;
  Sweep sw;
  spec.setup(S.fftN);
  chain.build();
  // Apply the server's initial settings (it sends a "set" first) before opening the device.
  std::thread(readStdin).detach();
  {
    auto t0 = std::chrono::steady_clock::now();
    while (std::chrono::steady_clock::now() - t0 < std::chrono::milliseconds(300)) {
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      std::lock_guard<std::mutex> lk(cmdMu);
      if (!cmds.empty()) break;
    }
  }
  bool needRebuild = false, needRestart = false;
  uint32_t lastTune = 0;

  auto retune = [&](double lo) {
    if (!streaming) return false; // (playback: the file sets the centre frequency)
    if (std::fabs(lo - ch->tunerParams.rfFreq.rfHz) < 1) return false;
    if (iqRec) iqEvents += "," + std::to_string(iqRecN) + ":" + std::to_string((long long)lo);
    S.lo = lo;
    ch->tunerParams.rfFreq.rfHz = lo;
    int mx = lnaMax(lo);
    bool gr = false;
    if (S.lna > mx) { S.lna = mx; ch->tunerParams.gain.LNAstate = (unsigned char)mx; gr = true; }
    lastTune = rfGen.load();
    update((sdrplay_api_ReasonForUpdateT)(sdrplay_api_Update_Tuner_Frf | (gr ? sdrplay_api_Update_Tuner_Gr : 0)));
    return true;
  };

  auto apply = [&](std::map<std::string, JVal> &m) {
    auto num = [&](const char *k, double &v) { if (m.count(k) && m[k].t == JVal::NUM) { v = m[k].n; return true; } return false; };
    auto inum = [&](const char *k, int &v) { double d; if (num(k, d)) { v = (int)std::lround(d); return true; } return false; };
    auto boo = [&](const char *k, bool &v) { if (m.count(k) && m[k].t == JVal::BOOL) { v = m[k].b; return true; } return false; };
    auto str = [&](const char *k, std::string &v) { if (m.count(k) && m[k].t == JVal::STR) { v = m[k].s; return true; } return false; };
    double d;
    if (num("fs", d) && d != S.fs && !playing) { S.fs = std::max(2e6, std::min(10e6, d)); needRestart = true; }
    std::string t;
    if (str("tuner", t) && (t == "A" || t == "B") && t != S.tuner) { S.tuner = t; if (!playing) needRestart = true; }
    if (num("lo", d) && !playing) {
      d = std::max(1e3, std::min(2000e6, d));
      if (streaming && !needRestart) retune(d);
      else S.lo = d;
    }
    if (num("vfo", d)) { S.vfo = d; chain.shift.set(-S.vfo, chain.fs); }
    std::string mode = S.mode;
    double bw = S.bw;
    if (str("mode", mode) | num("bw", bw)) {
      bool modeChanged = mode != S.mode;
      S.mode = mode;
      S.bw = bw;
      if (modeChanged) chain.rds.reset();
      chain.buildNarrow();
    }
    if (m.count("sq")) {
      if (m["sq"].t == JVal::NUL) S.sqOn = false;
      else if (m["sq"].t == JVal::NUM) { S.sqOn = true; S.sq = m["sq"].n; }
    }
    boo("stereo", S.stereo);
    if (num("deemph", d)) { S.deemph = d; chain.deA = 1 - std::exp(-1.0 / (AUDIO_RATE * S.deemph)); }
    num("cwPitch", S.cwPitch);
    boo("audio", S.audio);
    bool gain = false;
    gain |= inum("lna", S.lna);
    gain |= inum("gr", S.gr);
    if (gain && streaming) {
      S.lna = std::max(0, std::min(S.lna, lnaMax(S.lo)));
      S.gr = std::max(20, std::min(59, S.gr));
      ch->tunerParams.gain.LNAstate = (unsigned char)S.lna;
      ch->tunerParams.gain.gRdB = S.gr;
      update(sdrplay_api_Update_Tuner_Gr);
    }
    bool agc = false;
    agc |= boo("agc", S.agc);
    agc |= inum("agcSet", S.agcSet);
    if (agc && streaming) {
      ch->ctrlParams.agc.enable = S.agc ? sdrplay_api_AGC_50HZ : sdrplay_api_AGC_DISABLE;
      ch->ctrlParams.agc.setPoint_dBfs = S.agcSet;
      ch->tunerParams.gain.gRdB = S.gr;
      update(sdrplay_api_Update_Ctrl_Agc);
    }
    if (boo("hiz", S.hiz) && streaming && S.tuner == "A" && !needRestart) {
      ch->rspDuoTunerParams.tuner1AmPortSel = S.hiz ? sdrplay_api_RspDuo_AMPORT_1 : sdrplay_api_RspDuo_AMPORT_2;
      update(sdrplay_api_Update_RspDuo_AmPortSelect);
    }
    if (boo("fmNotch", S.fmNotch) && streaming) { ch->rspDuoTunerParams.rfNotchEnable = S.fmNotch; update(sdrplay_api_Update_RspDuo_RfNotchControl); }
    if (boo("dabNotch", S.dabNotch) && streaming) { ch->rspDuoTunerParams.rfDabNotchEnable = S.dabNotch; update(sdrplay_api_Update_RspDuo_RfDabNotchControl); }
    if (boo("amNotch", S.amNotch) && streaming && S.tuner == "A" && !needRestart) { ch->rspDuoTunerParams.tuner1AmNotchEnable = S.amNotch; update(sdrplay_api_Update_RspDuo_Tuner1AmNotchControl); }
    // bias-T exists on tuner 2 only; after a tuner change it's applied when the device reopens
    if (boo("biasT", S.biasT) && streaming && !needRestart && S.tuner == "B") { ch->rspDuoTunerParams.biasTEnable = S.biasT; update(sdrplay_api_Update_RspDuo_BiasTControl); }
    if (num("ppm", d) && streaming) { S.ppm = d; params->devParams->ppm = d; update(sdrplay_api_Update_Dev_Ppm); }
    int n;
    if (inum("fftN", n) && n != S.fftN && n >= 256 && n <= 65536 && (n & (n - 1)) == 0) { S.fftN = n; spec.setup(n); }
    if (inum("fps", n)) S.fps = std::max(1, std::min(60, n));
  };

  auto handle = [&](const std::string &line) {
    auto m = parseFlat(line);
    std::string c = m.count("cmd") ? m["cmd"].s : "";
    if (c == "set") apply(m);
    else if (c == "sweep" && streaming) {
      sw = Sweep();
      sw.active = true;
      sw.id = m.count("id") ? m["id"].s : "";
      sw.start = m["start"].n;
      sw.stop = m["stop"].n;
      sw.step = S.fs * 0.8;
      double native = S.fs / S.fftN;
      sw.binHz = std::max(native, m.count("binHz") ? m["binHz"].n : native);
      sw.nSteps = std::max(1, (int)std::ceil((sw.stop - sw.start) / sw.step));
      sw.savedLo = S.lo;
      sw.idx = 0;
      sw.outStart = sw.start;
      sw.outStep = sw.binHz;
      sw.out.assign((size_t)std::ceil((sw.stop - sw.start) / sw.binHz) + 1, -200.0f);
      sw.lo = sw.start + sw.step / 2;
      sw.waitGen = rfGen.load();
      sw.waiting = retune(sw.lo);
      sw.waitBlocks = 0;
      spec.fill = spec.avgDone = 0;
      spec.skip = 0;
      std::fill(spec.acc.begin(), spec.acc.end(), 0);
    } else if (c == "sweepCancel" && sw.active) {
      sw.active = false;
      retune(sw.savedLo);
      sendJson("{\"type\":\"sweep\",\"id\":\"" + sw.id + "\",\"cancelled\":true}");
    } else if (c == "iqRecStart" && streaming && !iqRec) {
      iqRecPath = m["path"].s;
      iqRecMaxSec = m.count("maxSec") ? m["maxSec"].n : 300;
      iqRec = fopen(iqRecPath.c_str(), "wb");
      iqRecN = 0;
      iqEvents = "0:" + std::to_string((long long)S.lo);
      if (!iqRec) logMsg("error", "can't write " + iqRecPath);
      else sendJson("{\"type\":\"iqrec\",\"state\":\"started\",\"path\":\"" + iqRecPath + "\"}");
    } else if (c == "iqRecStop") iqRecFinish();
    else if (c == "play") {
      iqRecFinish();
      stopPlayer();
      if (streaming) closeDevice();
      {
        std::lock_guard<std::mutex> lk(qMu);
        queue_.clear();
      }
      player.path = m["path"].s;
      player.fs = m["fs"].n;
      player.loop = m.count("loop") && m["loop"].b;
      player.events.clear();
      std::string ev = m.count("events") ? m["events"].s : "";
      for (size_t a = 0; a < ev.size();) {
        size_t b = ev.find(',', a);
        if (b == std::string::npos) b = ev.size();
        std::string e = ev.substr(a, b - a);
        size_t c2 = e.find(':');
        if (c2 != std::string::npos) player.events.push_back({atoll(e.c_str()), atof(e.c_str() + c2 + 1)});
        a = b + 1;
      }
      player.total = m.count("samples") ? (long long)m["samples"].n : 0;
      player.pos = 0;
      player.seekTo = (m.count("at") && m["at"].n > 0) ? (long long)(m["at"].n * player.fs) : -1;
      player.paused = false;
      S.fs = player.fs;
      S.lo = loAt(0);
      player.lo = S.lo;
      playing = true;
      chain.build();
      spec.setup(S.fftN);
      player.run = true;
      player.th = std::thread(playerLoop);
    } else if (c == "playStop" && playing) {
      stopPlayer();
      playing = false;
      {
        std::lock_guard<std::mutex> lk(qMu);
        queue_.clear();
      }
      if (m.count("lo")) S.lo = m["lo"].n;
      if (m.count("fs")) S.fs = m["fs"].n;
      chain.build();
      spec.setup(S.fftN);
      if (!openDeviceRetry()) leave(1);
    } else if (c == "playPause" && playing) player.paused = m.count("on") ? m["on"].b : !player.paused;
    else if (c == "playSeek" && playing) player.seekTo = (long long)(std::max(0.0, m["sec"].n) * player.fs);
    else if (c == "rdsReset") chain.rds.reset();
    else if (c == "quit") quit = true;
  };

  // initial settings, then the device
  {
    std::lock_guard<std::mutex> lk(cmdMu);
    while (!cmds.empty()) { handle(cmds.front()); cmds.pop_front(); }
  }
  needRestart = false;
  chain.build();
  spec.setup(S.fftN);
  if (!openDeviceRetry()) leave(1);

  std::vector<int8_t> specOut;
  std::vector<float> specDb;
  auto lastStatus = std::chrono::steady_clock::now();
  double busy = 0;
  auto busyT0 = std::chrono::steady_clock::now();

  while (!quit && !deviceGone) {
    // commands
    std::deque<std::string> todo;
    {
      std::lock_guard<std::mutex> lk(cmdMu);
      todo.swap(cmds);
    }
    for (auto &l : todo) handle(l);
    if (needRestart && playing) needRestart = false; // applies when playback stops
    if (needRestart) {
      needRestart = false;
      if (sw.active) { // a sweep can't survive the device reopening: tell the server so it can retry
        sw.active = false;
        sendJson("{\"type\":\"sweep\",\"id\":\"" + sw.id + "\",\"cancelled\":true,\"restart\":true}");
      }
      closeDevice();
      {
        std::lock_guard<std::mutex> lk(qMu);
        queue_.clear();
      }
      chain.build();
      spec.setup(S.fftN);
      if (!openDeviceRetry()) leave(1);
    }
    if (needRebuild) { needRebuild = false; chain.build(); }

    Block blk;
    {
      std::unique_lock<std::mutex> lk(qMu);
      qCv.wait_for(lk, std::chrono::milliseconds(50), [] { return !queue_.empty() || quit || deviceGone; });
      if (queue_.empty()) continue;
      blk = std::move(queue_.front());
      queue_.pop_front();
    }
    auto t0 = std::chrono::steady_clock::now();

    if (sw.active) {
      // Sweep: wait for the retune to land, average a few FFTs, keep the middle 80 %, step on.
      if (sw.waiting && blk.gen == sw.waitGen && ++sw.waitBlocks < 400) goto recycle;
      sw.waiting = false;
      spec.navg = 6;
      if (spec.feed(blk.i.data(), blk.q.data(), blk.i.size(), S.fs, 1000)) {
        spec.finish(specOut, &specDb);
        int N = S.fftN;
        double binW = S.fs / N;
        for (int k = N / 10; k < N * 9 / 10; k++) {
          double f = sw.lo + (k - N / 2) * binW;
          if (f < sw.start || f > sw.stop) continue;
          size_t o = (size_t)((f - sw.outStart) / sw.outStep);
          if (o < sw.out.size()) sw.out[o] = std::max(sw.out[o], specDb[k]);
        }
        sw.idx++;
        char prog[160];
        snprintf(prog, sizeof prog, "{\"type\":\"sweepProgress\",\"id\":\"%s\",\"i\":%d,\"n\":%d}", sw.id.c_str(), sw.idx, sw.nSteps);
        sendJson(prog);
        if (sw.idx >= sw.nSteps) {
          sw.active = false;
          spec.navg = 4;
          retune(sw.savedLo);
          std::string js = "{\"type\":\"sweep\",\"id\":\"" + sw.id + "\",\"start\":" + std::to_string(sw.outStart) +
                           ",\"step\":" + std::to_string(sw.outStep) + ",\"db\":[";
          for (size_t k = 0; k < sw.out.size(); k++) {
            if (k) js += ',';
            js += std::to_string((int)std::lround(sw.out[k] * 10));
          }
          js += "]}";
          sendJson(js);
        } else {
          sw.lo = sw.start + sw.step * (sw.idx + 0.5);
          sw.waitGen = rfGen.load();
          sw.waiting = retune(sw.lo);
          sw.waitBlocks = 0;
          spec.fill = 0;
          spec.skip = 0;
        }
      }
      goto recycle;
    }

    // normal running: spectrum from the raw block, then the channel
    if (playing) S.lo = player.lo;
    if (iqRec) {
      size_t n = blk.i.size();
      std::vector<int16_t> w(n * 2);
      for (size_t j = 0; j < n; j++) {
        w[2 * j] = (int16_t)std::max(-32767.0f, std::min(32767.0f, blk.i[j] * 32768.0f));
        w[2 * j + 1] = (int16_t)std::max(-32767.0f, std::min(32767.0f, blk.q[j] * 32768.0f));
      }
      fwrite(w.data(), 4, n, iqRec);
      iqRecN += n;
      if (iqRecN >= iqRecMaxSec * S.fs) iqRecFinish();
    }
    if (spec.feed(blk.i.data(), blk.q.data(), blk.i.size(), S.fs, S.fps)) {
      spec.finish(specOut);
      std::vector<uint8_t> f(8 + 8 + 4 + specOut.size());
      double lo = S.lo, fs = S.fs;
      uint32_t n = (uint32_t)specOut.size();
      memcpy(f.data(), &lo, 8);
      memcpy(f.data() + 8, &fs, 8);
      memcpy(f.data() + 16, &n, 4);
      memcpy(f.data() + 20, specOut.data(), n);
      writeFrame(1, f.data(), f.size());
    }
    chain.run(blk.i, blk.q);

  recycle : {
    auto t1 = std::chrono::steady_clock::now();
    busy += std::chrono::duration<double>(t1 - t0).count();
    std::lock_guard<std::mutex> lk(qMu);
    if (pool.size() < 64) pool.push_back(std::move(blk));
  }
    auto now = std::chrono::steady_clock::now();
    if (now - lastStatus > std::chrono::milliseconds(100)) {
      double wall = std::chrono::duration<double>(now - busyT0).count();
      chain.takeLevel();
      chain.noiseCh = spec.floorDb + 10 * std::log10(chain.measBw() / (S.fs / S.fftN)) - 3.0;
      char buf[1200];
      snprintf(buf, sizeof buf,
               "{\"type\":\"status\",\"lo\":%.0f,\"vfo\":%.0f,\"fs\":%.0f,\"mode\":\"%s\",\"bw\":%.0f,\"level\":%.1f,"
               "\"floor\":%.1f,\"sq\":%s,\"sqOpen\":%s,\"stereo\":%s,\"pilot\":%.3f,\"lna\":%d,\"lnaMax\":%d,\"gr\":%d,"
               "\"agc\":%s,\"agcSet\":%d,\"gainGr\":%d,\"lnaGr\":%d,\"gain\":%.1f,\"overload\":%s,\"tuner\":\"%s\","
               "\"hiz\":%s,\"fmNotch\":%s,\"dabNotch\":%s,\"amNotch\":%s,\"biasT\":%s,\"ppm\":%.2f,\"fftN\":%d,"
               "\"noise\":%.1f,\"fps\":%d,\"deemph\":%.0f,\"stereoOn\":%s,\"cwPitch\":%.0f,\"dropped\":%ld,\"load\":%.1f,\"sweeping\":%s,"
               "\"playing\":%s,\"playPos\":%.2f,\"playLen\":%.2f,\"paused\":%s,\"iqRec\":%s,\"iqRecSec\":%.1f}",
               S.lo, S.vfo, S.fs, S.mode.c_str(), S.bw, chain.level, spec.floorDb,
               S.sqOn ? std::to_string(S.sq).c_str() : "null", chain.sqOpen ? "true" : "false",
               chain.stereo() && S.mode == "wfm" ? "true" : "false", chain.pAmp, S.lna, lnaMax(S.lo), S.gr,
               S.agc ? "true" : "false", S.agcSet, gainGr.load(), gainLnaGr.load(), gainCurr.load(),
               overload ? "true" : "false", S.tuner.c_str(), S.hiz ? "true" : "false", S.fmNotch ? "true" : "false",
               S.dabNotch ? "true" : "false", S.amNotch ? "true" : "false", S.biasT ? "true" : "false", S.ppm, S.fftN,
               // the spectrum's noise floor (per bin) scaled to the channel: + 10 log(bw / bin) - Blackman-Harris ENBW (2 bins)
               chain.noiseCh, S.fps, S.deemph * 1e6, S.stereo ? "true" : "false", S.cwPitch, dropped.load(),
               wall > 0 ? busy / wall * 100 : 0, sw.active ? "true" : "false", playing ? "true" : "false",
               playing ? player.pos / player.fs : 0.0, playing ? player.total / player.fs : 0.0, player.paused ? "true" : "false",
               iqRec ? "true" : "false", iqRec ? iqRecN / S.fs : 0.0);
      sendJson(buf);
      lastStatus = now;
      if (wall > 2) { busy = 0; busyT0 = now; }
    }
  }
  if (deviceGone) logMsg("error", "device removed or failed");
  iqRecFinish();
  stopPlayer();
  closeDevice();
  if (apiOpen) sdrplay_api_Close();
  leave(deviceGone ? 3 : 0);
}
