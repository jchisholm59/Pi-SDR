// RDS / RBDS decoder. Input: the 57 kHz subcarrier mixed to baseband and resampled to 19 kHz, i.e. exactly 16
// samples per RDS bit (1187.5 bit/s). Steps: Costas loop (BPSK carrier phase), biphase integrate-and-dump with
// early/late timing, differential decoding, block sync on the (26,16) shortened cyclic code with offset words
// A/B/C/C'/D, then group parsing: PI, PTY, TP/TA, M/S, PS (0A/0B), AF (0A), RadioText (2A/2B), clock (4A),
// PTYN (10A). The caller polls changed() and json().
#pragma once
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

struct RdsDecoder {
  // ---- demodulation ---------------------------------------------------------------------------------------------
  double phase = 0, freq = 0;   // Costas loop
  float agc = 1e-3f;
  float hist[48] = {0};         // last samples of the carrier-corrected signal
  int hn = 0;                   // samples since the last symbol decision
  int period = 16;              // samples to the next decision (16, +-1 when the timing loop slips)
  double terr = 0;              // accumulated timing error
  int lastSym = 0;
  // ---- block sync -----------------------------------------------------------------------------------------------
  uint32_t reg = 0;             // last 26 bits
  int bitsSeen = 0, synced = 0, blockBits = 0, expect = 0; // expect: 0 A, 1 B, 2 C/C', 3 D
  int goodBlocks = 0, badBlocks = 0, lastFound = -1, lastFoundAt = 0, bitCount = 0;
  uint16_t blk[4] = {0};
  bool blkOk[4] = {false};
  // ---- decoded data ---------------------------------------------------------------------------------------------
  int pi = -1, pty = -1, tp = -1, ta = -1, ms = -1, stereoFlag = -1;
  char ps[9] = "        ", psWork[9] = "        ";
  int psNext = 0;                // PS segments must arrive in order 0,1,2,3 (stations scroll text through PS)
  char rt[65] = {0}, rtWork[65] = {0};
  int rtAB = -1, rtSeen = 0, rtLen = 64;
  char ptyn[9] = "        ";
  std::string ct;               // ISO local time from group 4A
  std::vector<int> af;          // kHz
  long groups = 0, errors = 0;
  bool dirty = false;

  void reset() { *this = RdsDecoder(); }

  static uint32_t syndrome16(uint32_t data) {
    // CRC of a 16-bit word with g(x) = x^10 + x^8 + x^7 + x^5 + x^4 + x^3 + 1, as the RDS standard computes it.
    uint32_t r = 0;
    const uint32_t poly = 0x5B9;
    for (int i = 16; i > 0; i--) {
      r = (r << 1) | ((data >> (i - 1)) & 1);
      if (r & (1 << 10)) r ^= poly;
    }
    for (int i = 10; i > 0; i--) {
      r <<= 1;
      if (r & (1 << 10)) r ^= poly;
    }
    return r & 0x3FF;
  }
  // Offset words: A, B, C, D, C'
  static constexpr uint32_t OFFSET[5] = {0x0FC, 0x198, 0x168, 0x1B4, 0x350};

  // Which offset (0 A, 1 B, 2 C, 3 D, 4 C') makes this 26-bit block valid, or -1.
  static int blockType(uint32_t r) {
    uint32_t data = (r >> 10) & 0xFFFF, check = r & 0x3FF, s = syndrome16(data);
    for (int k = 0; k < 5; k++)
      if ((check ^ OFFSET[k]) == s) return k;
    return -1;
  }

  // Feed complex baseband at 19 kHz.
  void process(const float *ii, const float *qq, size_t n) {
    for (size_t k = 0; k < n; k++) {
      // Costas loop (decision directed BPSK)
      float c = (float)std::cos(phase), s = (float)std::sin(phase);
      float re = ii[k] * c + qq[k] * s, im = qq[k] * c - ii[k] * s;
      float mag = std::sqrt(re * re + im * im);
      agc += 0.002f * (mag - agc);
      float g = agc > 1e-9f ? 1.0f / agc : 0;
      float e = (re > 0 ? im : -im) * g;
      freq += 2e-5 * e;
      if (freq > 0.05) freq = 0.05;
      if (freq < -0.05) freq = -0.05;
      phase += freq + 0.02 * e;
      if (phase > PI) phase -= 2 * PI;
      if (phase < -PI) phase += 2 * PI;
      // symbol timing: biphase = first half minus second half of the bit
      for (int j = 0; j < 47; j++) hist[j] = hist[j + 1];
      hist[47] = re * g;
      if (++hn < period) continue;
      hn = 0;
      auto bip = [&](int end) { // decision value for the 16 samples ending at hist[end]
        float a = 0, b = 0;
        for (int j = 0; j < 8; j++) a += hist[end - 15 + j];
        for (int j = 8; j < 16; j++) b += hist[end - 15 + j];
        return a - b;
      };
      float dOn = bip(46), dEarly = bip(45), dLate = bip(47);
      terr += (std::fabs(dLate) - std::fabs(dEarly)) / (std::fabs(dOn) + 1e-6f);
      period = 16;
      if (terr > 4) { period = 17; terr = 0; }       // decisions late-optimal: wait one sample more
      else if (terr < -4) { period = 15; terr = 0; }
      int sym = dOn > 0 ? 1 : 0;
      int bit = sym ^ lastSym;
      lastSym = sym;
      onBit(bit);
    }
  }

  void onBit(int bit) {
    reg = ((reg << 1) | (uint32_t)bit) & 0x3FFFFFF;
    bitCount++;
    if (!synced) {
      if (++bitsSeen < 26) return;
      int t = blockType(reg);
      if (t < 0) return;
      int seq = t == 4 ? 2 : t;
      // Synced when two blocks arrive in order, 26 bits apart (or a multiple of 26 for skipped blocks).
      if (lastFound >= 0) {
        int dist = bitCount - lastFoundAt;
        int want = ((seq - lastFound + 4) % 4) * 26;
        if (want == 0) want = 104;
        if (dist == want) {
          synced = 1;
          expect = (seq + 1) % 4;
          blockBits = 0;
          goodBlocks = badBlocks = 0;
          blk[seq] = (reg >> 10) & 0xFFFF;
          blkOk[seq] = true;
          return;
        }
      }
      lastFound = seq;
      lastFoundAt = bitCount;
      return;
    }
    if (++blockBits < 26) return;
    blockBits = 0;
    int t = blockType(reg);
    bool ok = (t == expect) || (expect == 2 && t == 4);
    if (ok) {
      blk[expect] = (reg >> 10) & 0xFFFF;
      blkOk[expect] = true;
      goodBlocks++;
    } else {
      blkOk[expect] = false;
      badBlocks++;
      errors++;
    }
    if (expect == 3) {
      group();
      for (auto &b : blkOk) b = false;
    }
    expect = (expect + 1) % 4;
    if (goodBlocks + badBlocks >= 50) {
      if (badBlocks > 35) { synced = 0; bitsSeen = 0; lastFound = -1; dirty = true; }
      goodBlocks = badBlocks = 0;
    }
  }

  static char rdsChar(int c) {
    if (c >= 0x20 && c < 0x7F) return (char)c;
    return c == 0x0D ? 0 : ' ';
  }

  void group() {
    if (blkOk[0]) {
      if (pi != blk[0]) { pi = blk[0]; dirty = true; }
    }
    if (!blkOk[1]) return;
    groups++;
    uint16_t b = blk[1], c = blk[2], d = blk[3];
    int type = b >> 12, ver = (b >> 11) & 1;
    int ntp = (b >> 10) & 1, npty = (b >> 5) & 31;
    if (ntp != tp || npty != pty) { tp = ntp; pty = npty; dirty = true; }
    if (type == 0) {
      int seg = b & 3;
      int nta = (b >> 4) & 1, nms = (b >> 3) & 1;
      if (nta != ta || nms != ms) { ta = nta; ms = nms; dirty = true; }
      if (seg == 3) { int st = (b >> 2) & 1; if (st != stereoFlag) { stereoFlag = st; dirty = true; } }
      // PS: accept a name only when its four segments arrive in order with no bad block between them, so a
      // scrolling PS never mixes two different texts.
      if (blkOk[3] && (seg == 0 || seg == psNext)) {
        psWork[seg * 2] = rdsChar(d >> 8);
        psWork[seg * 2 + 1] = rdsChar(d & 0xFF);
        psNext = seg + 1;
        if (seg == 3) {
          if (std::string(ps) != psWork) { std::copy(psWork, psWork + 9, ps); dirty = true; }
          psNext = 0;
        }
      } else if (seg != psNext) psNext = 0;
      if (ver == 0 && blkOk[2]) {
        for (int code : {c >> 8, c & 0xFF}) {
          if (code >= 1 && code <= 204) {
            int khz = 87500 + code * 100;
            bool have = false;
            for (int a : af) have |= a == khz;
            if (!have && af.size() < 25) { af.push_back(khz); dirty = true; }
          }
        }
      }
    } else if (type == 2) {
      int seg = b & 15, ab = (b >> 4) & 1;
      if (ab != rtAB) { // text A/B flag toggled: a new message
        if (rtAB != -1) { std::fill(rtWork, rtWork + 65, 0); rtSeen = 0; }
        rtAB = ab;
      }
      auto put = [&](int pos, int ch) {
        if (pos >= 64) return;
        if (ch == 0x0D) { rtLen = pos; rtWork[pos] = 0; return; }
        rtWork[pos] = rdsChar(ch);
      };
      if (ver == 0) {
        if (blkOk[2]) { put(seg * 4, c >> 8); put(seg * 4 + 1, c & 0xFF); }
        if (blkOk[3]) { put(seg * 4 + 2, d >> 8); put(seg * 4 + 3, d & 0xFF); }
        rtSeen |= 1 << seg;
      } else if (blkOk[3]) {
        put(seg * 2, d >> 8);
        put(seg * 2 + 1, d & 0xFF);
        rtSeen |= 1 << seg;
      }
      // Publish when every segment up to the end of the text has arrived.
      int segs = ver == 0 ? (rtLen + 3) / 4 : (rtLen + 1) / 2;
      if (segs > 16) segs = 16;
      int need = segs >= 16 ? 0xFFFF : (1 << segs) - 1;
      if ((rtSeen & need) == need) {
        char tmp[65] = {0};
        int L = std::min(rtLen, 64);
        for (int i = 0; i < L; i++) tmp[i] = rtWork[i] ? rtWork[i] : ' ';
        // trim trailing spaces
        for (int i = L - 1; i >= 0 && tmp[i] == ' '; i--) tmp[i] = 0;
        if (std::string(tmp) != rt && tmp[0]) { std::copy(tmp, tmp + 65, rt); dirty = true; }
      }
    } else if (type == 4 && ver == 0 && blkOk[2] && blkOk[3]) {
      long mjd = ((long)(b & 3) << 15) | (c >> 1);
      int hour = ((c & 1) << 4) | (d >> 12), minute = (d >> 6) & 63;
      int off = d & 31, sign = (d >> 5) & 1;
      if (mjd > 50000 && hour < 24 && minute < 60) {
        // MJD to date (EN 50067 annex G)
        long yp = (long)((mjd - 15078.2) / 365.25);
        long mp = (long)((mjd - 14956.1 - (long)(yp * 365.25)) / 30.6001);
        int day = (int)(mjd - 14956 - (long)(yp * 365.25) - (long)(mp * 30.6001));
        int k = (mp == 14 || mp == 15) ? 1 : 0;
        int year = (int)(1900 + yp + k), month = (int)(mp - 1 - k * 12);
        int offMin = (sign ? -1 : 1) * off * 30;
        int tot = hour * 60 + minute + offMin;
        // local time may cross midnight; keep the UTC date for simplicity and show the offset explicitly
        while (tot < 0) tot += 1440;
        tot %= 1440;
        char buf[64];
        snprintf(buf, sizeof buf, "%04d-%02d-%02d %02d:%02d UTC (local %02d:%02d, UTC%+.1f)", year, month, day, hour,
                 minute, tot / 60, tot % 60, offMin / 60.0);
        if (ct != buf) { ct = buf; dirty = true; }
      }
    } else if (type == 10 && ver == 0) {
      int seg = b & 1;
      if (blkOk[2]) { ptyn[seg * 4] = rdsChar(c >> 8); ptyn[seg * 4 + 1] = rdsChar(c & 0xFF); }
      if (blkOk[3]) { ptyn[seg * 4 + 2] = rdsChar(d >> 8); ptyn[seg * 4 + 3] = rdsChar(d & 0xFF); dirty = true; }
    }
  }

  static std::string esc(const char *s) {
    std::string o;
    for (; *s; s++) {
      if (*s == '"' || *s == '\\') o += '\\';
      if ((unsigned char)*s < 0x20) continue;
      o += *s;
    }
    return o;
  }

  std::string json() const {
    std::string a;
    for (size_t i = 0; i < af.size(); i++) a += (i ? "," : "") + std::to_string(af[i]);
    char buf[1024];
    double bler = (groups + errors) ? (double)errors / (errors + groups * 4) : 0;
    snprintf(buf, sizeof buf,
             "{\"type\":\"rds\",\"sync\":%s,\"pi\":%d,\"ps\":\"%s\",\"rt\":\"%s\",\"pty\":%d,\"tp\":%d,\"ta\":%d,"
             "\"ms\":%d,\"stereoFlag\":%d,\"ptyn\":\"%s\",\"ct\":\"%s\",\"af\":[%s],\"groups\":%ld,\"bler\":%.3f}",
             synced ? "true" : "false", pi, pi >= 0 ? esc(ps).c_str() : "", esc(rt).c_str(), pty, tp, ta, ms,
             stereoFlag, esc(ptyn).c_str(), esc(ct.c_str()).c_str(), a.c_str(), groups, bler);
    return buf;
  }
};
constexpr uint32_t RdsDecoder::OFFSET[5];
