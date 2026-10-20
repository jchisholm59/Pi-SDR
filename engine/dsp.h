// DSP building blocks for sdr-engine: filter design, decimating FIRs, an arbitrary-ratio resampler, an NCO and
// small IIR helpers. Complex signals are kept as separate I and Q float arrays so the inner loops vectorise (NEON
// on the Pi 4) with -O3.
#pragma once
#include <cmath>
#include <complex>
#include <cstddef>
#include <vector>

using cf = std::complex<float>;
static constexpr double PI = 3.14159265358979323846;

// Zeroth-order modified Bessel function, for the Kaiser window.
inline double bessel_i0(double x) {
  double s = 1, t = 1;
  for (int k = 1; k < 40; k++) {
    t *= (x / (2 * k)) * (x / (2 * k));
    s += t;
    if (t < 1e-12 * s) break;
  }
  return s;
}

// Kaiser beta for a stopband attenuation in dB.
inline double kaiser_beta(double atten) {
  if (atten > 50) return 0.1102 * (atten - 8.7);
  if (atten > 21) return 0.5842 * std::pow(atten - 21, 0.4) + 0.07886 * (atten - 21);
  return 0;
}

// Taps needed for a transition width (both normalised to the sample rate) at a given attenuation.
inline int kaiser_taps(double transition, double atten = 70) {
  int n = (int)std::ceil((atten - 8) / (2.285 * 2 * PI * transition)) + 1;
  return n | 1; // odd: a symmetric filter with a centre tap
}

// Windowed-sinc lowpass: cutoff (the -6 dB point) as a fraction of the sample rate. Unity gain at DC.
inline std::vector<float> design_lowpass(int n, double cutoff, double atten = 70) {
  std::vector<float> h(n);
  double beta = kaiser_beta(atten), sum = 0, m = (n - 1) / 2.0, i0b = bessel_i0(beta);
  for (int i = 0; i < n; i++) {
    double x = i - m;
    double s = x == 0 ? 2 * cutoff : std::sin(2 * PI * cutoff * x) / (PI * x);
    double r = m > 0 ? x / m : 0;
    double w = bessel_i0(beta * std::sqrt(std::max(0.0, 1 - r * r))) / i0b;
    h[i] = (float)(s * w);
    sum += h[i];
  }
  for (auto &v : h) v = (float)(v / sum);
  return h;
}

// Decimating FIR for complex samples (real taps). Keeps its own history; out gets floor((carry + n) / D) samples.
struct DecimFIR {
  std::vector<float> h, bi, bq;
  int D = 1;
  size_t pos = 0; // index in the buffer of the next output's first tap
  void init(const std::vector<float> &taps, int decim) {
    h = taps;
    D = decim;
    bi.assign(h.size() - 1, 0);
    bq.assign(h.size() - 1, 0);
    pos = 0;
  }
  void process(const float *ii, const float *qq, size_t n, std::vector<float> &oi, std::vector<float> &oq) {
    bi.insert(bi.end(), ii, ii + n);
    bq.insert(bq.end(), qq, qq + n);
    const size_t T = h.size();
    oi.clear();
    oq.clear();
    const float *hp = h.data();
    while (pos + T <= bi.size()) {
      const float *xi = bi.data() + pos, *xq = bq.data() + pos;
      float si = 0, sq = 0;
      for (size_t k = 0; k < T; k++) {
        si += hp[k] * xi[k];
        sq += hp[k] * xq[k];
      }
      oi.push_back(si);
      oq.push_back(sq);
      pos += D;
    }
    // Keep only what the next outputs still need.
    size_t drop = std::min(pos, bi.size());
    bi.erase(bi.begin(), bi.begin() + drop);
    bq.erase(bq.begin(), bq.begin() + drop);
    pos -= drop;
  }
};

// Arbitrary-ratio resampler (in -> out Hz) with a lowpass cutoff (Hz), for one or two (I/Q) channels.
// A windowed-sinc prototype is tabulated at P sub-sample phases; each output uses the nearest phase.
struct Resampler {
  static constexpr int P = 512;
  int K = 0;                 // taps per phase
  std::vector<float> table;  // P * K
  double step = 1, t = 0;    // input samples per output; position of the next output (relative to buffer start)
  int nch = 1;
  std::vector<float> b[2];
  void init(double in, double out, double cutoff, double transition, int channels, double atten = 70) {
    nch = channels;
    step = in / out;
    double fc = cutoff / in, tw = transition / in;
    K = std::max(8, kaiser_taps(tw, atten));
    table.assign((size_t)P * K, 0);
    double beta = kaiser_beta(atten), i0b = bessel_i0(beta), m = (K - 1) / 2.0;
    for (int p = 0; p < P; p++) {
      double frac = (double)p / P, sum = 0;
      for (int k = 0; k < K; k++) {
        double x = k - m - frac; // tap k weights the input at (base + k), the output sits at base + m + frac
        double s = std::fabs(x) < 1e-9 ? 2 * fc : std::sin(2 * PI * fc * x) / (PI * x);
        double r = x / (m + 1);
        double w = std::fabs(r) < 1 ? bessel_i0(beta * std::sqrt(1 - r * r)) / i0b : 0;
        table[(size_t)p * K + k] = (float)(s * w);
        sum += s * w;
      }
      for (int k = 0; k < K; k++) table[(size_t)p * K + k] = (float)(table[(size_t)p * K + k] / sum);
    }
    for (auto &v : b) v.assign(K, 0);
    t = 0;
  }
  // Feed n input samples per channel; append outputs to o0 (and o1 for two channels).
  void process(const float *x0, const float *x1, size_t n, std::vector<float> &o0, std::vector<float> &o1) {
    b[0].insert(b[0].end(), x0, x0 + n);
    if (nch > 1) b[1].insert(b[1].end(), x1, x1 + n);
    o0.clear();
    o1.clear();
    const size_t len = b[0].size();
    while ((size_t)t + K <= len) {
      size_t base = (size_t)t;
      int p = (int)((t - base) * P);
      const float *hp = table.data() + (size_t)p * K;
      const float *a = b[0].data() + base;
      float s0 = 0;
      for (int k = 0; k < K; k++) s0 += hp[k] * a[k];
      o0.push_back(s0);
      if (nch > 1) {
        const float *c = b[1].data() + base;
        float s1 = 0;
        for (int k = 0; k < K; k++) s1 += hp[k] * c[k];
        o1.push_back(s1);
      }
      t += step;
    }
    size_t drop = std::min((size_t)t, len);
    b[0].erase(b[0].begin(), b[0].begin() + drop);
    if (nch > 1) b[1].erase(b[1].begin(), b[1].begin() + drop);
    t -= drop;
  }
};

// Numerically controlled oscillator: multiplies by e^(j 2 pi f n / fs) using a recurrence, renormalised often.
struct NCO {
  double fs = 1, freq = 0;
  float ci = 1, cq = 0, si = 1, sq = 0; // current phasor, per-sample step
  int count = 0;
  void set(double f, double rate) {
    fs = rate;
    freq = f;
    double w = 2 * PI * f / fs;
    si = (float)std::cos(w);
    sq = (float)std::sin(w);
  }
  // In place: (i + jq) * phasor
  void mix(float *ii, float *qq, size_t n) {
    if (freq == 0) return;
    float pi_ = ci, pq = cq;
    for (size_t k = 0; k < n; k++) {
      float a = ii[k], b = qq[k];
      ii[k] = a * pi_ - b * pq;
      qq[k] = a * pq + b * pi_;
      float ni = pi_ * si - pq * sq, nq = pi_ * sq + pq * si;
      pi_ = ni;
      pq = nq;
      if ((++count & 1023) == 0) {
        float m = 1.0f / std::sqrt(pi_ * pi_ + pq * pq);
        pi_ *= m;
        pq *= m;
      }
    }
    ci = pi_;
    cq = pq;
  }
};

// Plain FIR on complex samples with complex taps (used for the SSB/CW sideband filters), same rate in and out.
struct ComplexFIR {
  std::vector<float> hi, hq, bi, bq;
  void init(const std::vector<float> &ti, const std::vector<float> &tq) {
    hi = ti;
    hq = tq;
    bi.assign(hi.size() - 1, 0);
    bq.assign(hi.size() - 1, 0);
  }
  void process(const float *ii, const float *qq, size_t n, std::vector<float> &oi, std::vector<float> &oq) {
    bi.insert(bi.end(), ii, ii + n);
    bq.insert(bq.end(), qq, qq + n);
    const size_t T = hi.size();
    oi.resize(n);
    oq.resize(n);
    for (size_t j = 0; j < n; j++) {
      const float *xi = bi.data() + j, *xq = bq.data() + j;
      float ri = 0, rq = 0;
      for (size_t k = 0; k < T; k++) {
        ri += hi[k] * xi[k] - hq[k] * xq[k];
        rq += hi[k] * xq[k] + hq[k] * xi[k];
      }
      oi[j] = ri;
      oq[j] = rq;
    }
    bi.erase(bi.begin(), bi.begin() + n);
    bq.erase(bq.begin(), bq.begin() + n);
  }
};

// Plain real FIR (same rate), e.g. the channel lowpass at 48 kHz applied to I and Q.
struct RealFIR {
  std::vector<float> h, b;
  void init(const std::vector<float> &t) {
    h = t;
    b.assign(h.size() - 1, 0);
  }
  void process(const float *x, size_t n, float *y) {
    b.insert(b.end(), x, x + n);
    const size_t T = h.size();
    for (size_t j = 0; j < n; j++) {
      const float *p = b.data() + j;
      float s = 0;
      for (size_t k = 0; k < T; k++) s += h[k] * p[k];
      y[j] = s;
    }
    b.erase(b.begin(), b.begin() + n);
  }
};

// Second-order IIR (biquad), direct form I.
struct Biquad {
  double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  void bandpass(double f0, double q, double fs) {
    double w = 2 * PI * f0 / fs, al = std::sin(w) / (2 * q), a0 = 1 + al;
    b0 = al / a0;
    b1 = 0;
    b2 = -al / a0;
    a1 = -2 * std::cos(w) / a0;
    a2 = (1 - al) / a0;
  }
  void highpass(double f0, double q, double fs) {
    double w = 2 * PI * f0 / fs, al = std::sin(w) / (2 * q), c = std::cos(w), a0 = 1 + al;
    b0 = (1 + c) / 2 / a0;
    b1 = -(1 + c) / a0;
    b2 = (1 + c) / 2 / a0;
    a1 = -2 * c / a0;
    a2 = (1 - al) / a0;
  }
  float run(float x) {
    double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return (float)y;
  }
};
