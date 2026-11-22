/*
 * Pop detector – runs on the audio thread as an AudioWorklet.
 *
 * A popcorn pop is a short, broadband, sharp transient. Most kitchen noise
 * (stove, extractor fan, microwave hum and turntable) is either low-frequency
 * or steady. So the detector:
 *
 *   1. high-pass filters the signal (4th order, 1.5 kHz) to drop hum and rumble,
 *   2. measures the energy in ~1.5 ms frames,
 *   3. tracks the background noise floor as a low percentile of the last 1.5 s,
 *   4. finds candidates: a frame far above the noise floor that also rose sharply
 *      compared with the few milliseconds just before it, with a short dead time
 *      so one pop counts only once.
 *
 * Talking is the most common source of false pops: every vocal-cord pulse in a
 * vowel is a tiny click, about 100–250 of them per second. So there is also a
 * voice detector (pitch tracking on the low band). While someone is talking, a
 * candidate only counts if it looks like a pop rather than a voice click: bright
 * (plenty of energy above 4 kHz, where voices are weak) and standing out from the
 * sound right before and after it, or else very clearly louder than the voice.
 * Decisions are therefore made about a quarter of a second after the sound.
 *
 * The file is written as a plain script (no imports/exports) so it can also be
 * loaded with a <script> tag for offline testing of the PopDetector class.
 */

class Biquad {
  // RBJ cookbook biquad, high-pass ('hp') or low-pass ('lp')
  constructor(fs, f0, type, q = Math.SQRT1_2) {
    const w0 = (2 * Math.PI * f0) / fs;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    const k = type === 'lp' ? 1 - cos : 1 + cos;
    this.b0 = k / 2 / a0;
    this.b1 = (type === 'lp' ? k : -k) / a0;
    this.b2 = k / 2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  step(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * Voice detector: YIN pitch tracking on the 200–900 Hz band, downsampled to ~8 kHz.
 * (The band starts above the rumble of gas burners and extractor fans; the pitch
 * still shows up there through the voice's harmonics.) A 10 ms frame is "voiced"
 * when it is clearly periodic with a pitch of 70–400 Hz and that band is well
 * above its own background level, so a steady periodic hum (microwave, fan)
 * doesn't count. A voice region is a run of at least 40 ms of voiced frames,
 * widened by 150 ms before and 200 ms after for the consonants.
 */
class VoiceDetector {
  constructor(fs) {
    this.dec = Math.max(1, Math.round(fs / 8000));
    this.fsd = fs / this.dec;
    this.lpA = new Biquad(fs, 900, 'lp');
    this.lpB = new Biquad(fs, 900, 'lp');
    this.hpA = new Biquad(fs, 200, 'hp');
    this.hpB = new Biquad(fs, 200, 'hp');
    this.W = Math.round(0.032 * this.fsd); // analysis window
    this.hop = Math.round(0.01 * this.fsd);
    this.tauMin = Math.floor(this.fsd / 400);
    this.tauMax = Math.ceil(this.fsd / 70);
    this.tauSearch = Math.floor(this.fsd / 1000);
    this.need = this.W + this.tauMax + 1;
    this.buf = new Float32Array(1024);
    this.bufPos = 0;
    this.lin = new Float32Array(this.need);
    this.d = new Float64Array(this.tauMax + 1);
    this.decCount = 0;
    this.hopCount = 0;
    this.n = 0; // decimated samples so far

    this.yinThreshold = 0.3;
    this.gateDb = 6;
    this.minRun = 4; // frames of 10 ms
    this.hangBefore = 0.15; // s
    this.hangAfter = 0.2; // s

    this.floorN = 500; // 5 s of frames
    this.floorBuf = new Float32Array(this.floorN);
    this.floorSorted = new Float32Array(this.floorN);
    this.floorCount = 0;
    this.floorPos = 0;
    this.floorDb = -100;
    this.frames = 0;

    this.run = null; // current voiced run {s, e, n}
    this.runs = []; // finished runs that were long enough
    this.doneUntil = 0; // analysis time (window centre) processed so far
    this.lastVoiceAt = -1e9; // end of the latest voice run (for the UI)
  }

  push(x) {
    const y = this.hpB.step(this.hpA.step(this.lpB.step(this.lpA.step(x))));
    if (++this.decCount < this.dec) return;
    this.decCount = 0;
    this.buf[this.bufPos] = y;
    this.bufPos = (this.bufPos + 1) & 1023;
    this.n++;
    if (++this.hopCount >= this.hop && this.n >= this.need) {
      this.hopCount = 0;
      this.analyse();
    }
  }

  analyse() {
    const { W, need, lin, d, tauMax } = this;
    for (let i = 0; i < need; i++) lin[i] = this.buf[(this.bufPos - need + i + 1024) & 1023];
    let e = 0;
    for (let j = 0; j < W; j++) e += lin[j] * lin[j];
    const eDb = 10 * Math.log10(e / W + 1e-15);

    // YIN: difference function, normalised by its cumulative mean
    let cum = 0;
    for (let t = 1; t <= tauMax; t++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const v = lin[j] - lin[j + t];
        s += v * v;
      }
      cum += s;
      d[t] = cum > 0 ? (s * t) / cum : 1;
    }
    // first clear dip, searching from 1 kHz down; it must be a 70–400 Hz pitch
    let tau = -1;
    for (let t = this.tauSearch; t < tauMax; t++) {
      if (d[t] < this.yinThreshold) {
        while (t + 1 < tauMax && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }

    // background level of this band: 10th percentile of the last 5 s
    this.floorBuf[this.floorPos] = eDb;
    this.floorPos = (this.floorPos + 1) % this.floorN;
    if (this.floorCount < this.floorN) this.floorCount++;
    if (this.floorCount < 20 || this.frames % 10 === 0) {
      const s = this.floorSorted.subarray(0, this.floorCount);
      s.set(this.floorBuf.subarray(0, this.floorCount));
      s.sort();
      this.floorDb = Math.max(-90, s[Math.floor(this.floorCount * 0.1)]);
    }
    this.frames++;

    const t = (this.n - need + W / 2) / this.fsd;
    const voiced = tau >= this.tauMin && tau <= tauMax && eDb > this.floorDb + this.gateDb;
    if (voiced) {
      if (this.run) {
        this.run.e = t;
        this.run.n++;
      } else this.run = { s: t, e: t, n: 1 };
      if (this.run.n >= this.minRun) this.lastVoiceAt = t;
    } else if (this.run) {
      if (this.run.n >= this.minRun) this.runs.push(this.run);
      this.run = null;
    }
    this.doneUntil = t;
  }

  /** Has enough audio been analysed to decide about time t? */
  ready(t) {
    return this.doneUntil >= t + this.hangBefore + this.minRun * 0.01;
  }

  isVoice(t) {
    const r = this.run;
    if (r && r.n >= this.minRun && t >= r.s - this.hangBefore && t <= r.e + this.hangAfter) return true;
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const q = this.runs[i];
      if (t >= q.s - this.hangBefore && t <= q.e + this.hangAfter) return true;
      if (q.e + this.hangAfter < t) break;
    }
    return false;
  }

  prune(t) {
    while (this.runs.length && this.runs[0].e + this.hangAfter < t - 3) this.runs.shift();
  }
}

class PopDetector {
  constructor(fs) {
    this.fs = fs;
    this.hpA = new Biquad(fs, 1500, 'hp');
    this.hpB = new Biquad(fs, 1500, 'hp');
    // A second, higher band: voices have little energy up here, pops plenty.
    this.hiA = new Biquad(fs, 4000, 'hp');
    this.hiB = new Biquad(fs, 4000, 'hp');
    this.vad = new VoiceDetector(fs);

    this.frameLen = Math.max(32, Math.round(fs * 0.0015));
    this.frameDur = this.frameLen / fs;
    this.acc = 0;
    this.accHi = 0;
    this.accN = 0;
    this.frame = 0;

    // Tunables (overridable via setParams)
    this.thresholdDb = 15; // how far above the noise floor a pop must be
    this.riseDb = 8; // how sharply it must rise vs. the preceding ~3–8 ms
    this.voiceFilter = true;
    this.minFloorDb = -85; // never treat the floor as quieter than this
    this.refractoryFrames = Math.round(0.012 / this.frameDur);
    this.peakHoldFrames = Math.max(1, Math.round(0.006 / this.frameDur));
    this.warmupFrames = Math.round(0.4 / this.frameDur);
    // While someone talks: a pop must be bright (level above 4 kHz no more than
    // 9 dB below the level above 1.5 kHz) and ≥3 dB above the sound around it,
    // or else ≥12 dB above the sound around it.
    this.voiceTiltDb = -9;
    this.voiceContrastDb = 3;
    this.voiceStrongDb = 12;

    // Ring of recent frame energies (linear) for the onset check
    this.recent = new Float64Array(16);
    this.recentPos = 0;

    // Levels (dB) of the last ~1.5 s of frames in both bands
    this.histN = 1024;
    this.hist = new Float32Array(this.histN);
    this.histHi = new Float32Array(this.histN);

    // Noise-floor tracker: 20th percentile of the last 1.5 s of frame levels
    this.floorN = Math.round(1.5 / this.frameDur);
    this.floorBuf = new Float32Array(this.floorN);
    this.floorSorted = new Float32Array(this.floorN);
    this.floorCount = 0;
    this.floorPos = 0;
    this.floorDb = -100;

    this.lastOnset = -1e9;
    this.pending = null; // candidate whose peak is still being followed
    this.queue = []; // candidates waiting for the voice decision
    this.muteUntil = 0;
    this.meterMax = -120;

    this.onPop = null; // (timeSec, peakDb, floorDb, info) => void
    this.onIgnore = null; // (timeSec, reason, info) => void
  }

  setParams(p) {
    if (typeof p.thresholdDb === 'number') this.thresholdDb = p.thresholdDb;
    if (typeof p.riseDb === 'number') this.riseDb = p.riseDb;
    if (typeof p.voiceFilter === 'boolean') this.voiceFilter = p.voiceFilter;
  }

  /** Ignore everything for the next `seconds` (e.g. while our own alarm beeps). */
  mute(seconds) {
    this.muteUntil = Math.max(this.muteUntil, this.frame + Math.ceil(seconds / this.frameDur));
  }

  get time() {
    return this.frame * this.frameDur;
  }

  /** Is someone talking right now (for the UI)? */
  get voiceActive() {
    return this.voiceFilter && this.vad.doneUntil - this.vad.lastVoiceAt < 0.5;
  }

  process(input) {
    const vad = this.vad;
    const len = this.frameLen;
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      vad.push(x);
      const y = this.hpB.step(this.hpA.step(x));
      const h = this.hiB.step(this.hiA.step(x));
      this.acc += y * y;
      this.accHi += h * h;
      if (++this.accN === len) {
        this.histHi[this.frame % this.histN] = 10 * Math.log10(this.accHi / len + 1e-15);
        this.handleFrame(this.acc / len);
        this.acc = 0;
        this.accHi = 0;
        this.accN = 0;
      }
    }
    this.decide();
  }

  updateFloor() {
    const n = this.floorCount;
    const s = this.floorSorted.subarray(0, n);
    s.set(this.floorBuf.subarray(0, n));
    s.sort();
    this.floorDb = s[Math.floor(n * 0.2)];
  }

  handleFrame(energy) {
    const f = this.frame++;
    const db = 10 * Math.log10(energy + 1e-15);
    if (db > this.meterMax) this.meterMax = db;
    this.hist[f % this.histN] = db;
    const muted = f < this.muteUntil;

    // Baseline: mean energy of frames f-2 … f-5 (≈3–8 ms before this frame)
    let sum = 0;
    for (let k = 2; k <= 5; k++) sum += this.recent[(this.recentPos - k + 16) & 15];
    const baseDb = 10 * Math.log10(sum / 4 + 1e-15);
    this.recent[this.recentPos] = energy;
    this.recentPos = (this.recentPos + 1) & 15;

    if (!muted) {
      this.floorBuf[this.floorPos] = db;
      this.floorPos = (this.floorPos + 1) % this.floorN;
      if (this.floorCount < this.floorN) this.floorCount++;
      if (this.floorCount < 64 || (f & 31) === 0) this.updateFloor();
    }

    if (this.pending) {
      // Follow the candidate for a few ms to find its peak level
      if (db > this.pending.peak) this.pending.peak = db;
      if (--this.pending.left <= 0) {
        this.queue.push(this.pending);
        this.pending = null;
      }
      return;
    }

    if (muted || f < this.warmupFrames || f - this.lastOnset < this.refractoryFrames) return;

    const floor = Math.max(this.floorDb, this.minFloorDb);
    if (db - floor >= this.thresholdDb && db - baseDb >= this.riseDb) {
      this.lastOnset = f;
      this.pending = { frame: f, peak: db, floor, left: this.peakHoldFrames };
    }
  }

  /** Power-average level (dB) of frames f+a … f+b in one band's history. */
  level(h, f, a, b) {
    let s = 0;
    let n = 0;
    for (let k = a; k <= b; k++) {
      const i = f + k;
      if (i < 0 || i >= this.frame || this.frame - i >= this.histN) continue;
      s += Math.pow(10, h[i % this.histN] / 10);
      n++;
    }
    return n ? 10 * Math.log10(s / n + 1e-15) : -150;
  }

  /** Decide about queued candidates once the voice detector has caught up. */
  decide() {
    const q = this.queue;
    const vad = this.vad;
    while (q.length) {
      const c = q[0];
      const t = c.frame * this.frameDur;
      // need the voice decision and ~40 ms of audio after the candidate
      if (!vad.ready(t) || this.frame < c.frame + 30) break;
      q.shift();
      if (!this.voiceFilter || !vad.isVoice(t)) {
        if (this.onPop) this.onPop(t, c.peak, c.floor, null);
        continue;
      }
      // Someone is talking: does this look like a pop or like a voice click?
      let peakHi = -150;
      for (let k = 0; k <= this.peakHoldFrames; k++) {
        peakHi = Math.max(peakHi, this.histHi[(c.frame + k) % this.histN]);
      }
      const around = Math.max(this.level(this.hist, c.frame, -24, -3), this.level(this.hist, c.frame, 7, 27));
      const contrast = c.peak - around;
      const tilt = peakHi - c.peak;
      const info = { voice: true, contrast, tilt };
      if ((tilt >= this.voiceTiltDb && contrast >= this.voiceContrastDb) || contrast >= this.voiceStrongDb) {
        if (this.onPop) this.onPop(t, c.peak, c.floor, info);
      } else if (this.onIgnore) this.onIgnore(t, 'voice', info);
    }
    vad.prune(this.time);
  }
}

if (typeof AudioWorkletProcessor !== 'undefined') {
  const SILENCE = new Float32Array(128);

  class PopProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.det = new PopDetector(sampleRate);
      if (options && options.processorOptions) this.det.setParams(options.processorOptions);
      this.t0 = null; // context time at which the detector started
      this.det.onPop = (t, peak, floor) => {
        this.port.postMessage({ type: 'pop', t: this.t0 + t, peak, floor });
      };
      this.det.onIgnore = (t, reason) => {
        this.port.postMessage({ type: 'ignored', t: this.t0 + t, reason });
      };
      this.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'params') this.det.setParams(m);
        else if (m.type === 'mute') this.det.mute(m.seconds);
      };
      this.meterEvery = Math.max(1, Math.round((0.04 * sampleRate) / 128));
      this.blocks = 0;
    }

    process(inputs) {
      if (this.t0 === null) this.t0 = currentTime;
      const ch = inputs[0] && inputs[0][0];
      // Keep the detector clock in step with the context even without input
      this.det.process(ch || SILENCE);
      if (++this.blocks >= this.meterEvery) {
        this.blocks = 0;
        const d = this.det;
        this.port.postMessage({
          type: 'meter',
          t: this.t0 + d.time,
          level: d.meterMax,
          floor: Math.max(d.floorDb, d.minFloorDb),
          threshold: d.thresholdDb,
          voice: d.voiceActive,
        });
        d.meterMax = -120;
      }
      return true;
    }
  }

  registerProcessor('pop-detector', PopProcessor);
}
