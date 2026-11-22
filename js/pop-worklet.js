/*
 * Pop detector – runs on the audio thread as an AudioWorklet.
 *
 * A popcorn pop is a very short (a few milliseconds), broadband, sharp
 * transient. Most kitchen noise (stove, extractor fan, microwave hum and
 * turntable) is either low-frequency or steady. So the detector:
 *
 *   1. high-pass filters the signal (4th order, 1.5 kHz) to drop hum and rumble,
 *   2. measures the energy in ~1.5 ms frames,
 *   3. tracks the background noise floor as a low percentile of the last 1.5 s,
 *   4. reports a pop when a frame is far above the noise floor AND rose sharply
 *      compared with the few milliseconds just before it (a transient, not a
 *      sustained sound), with a short dead time so one pop counts only once.
 *
 * The file is written as a plain script (no imports/exports) so it can also be
 * loaded with a <script> tag for offline testing of the PopDetector class.
 */

class HighPass {
  // RBJ cookbook biquad high-pass
  constructor(fs, f0, q = Math.SQRT1_2) {
    const w0 = (2 * Math.PI * f0) / fs;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 + cos) / 2 / a0;
    this.b1 = -(1 + cos) / a0;
    this.b2 = (1 + cos) / 2 / a0;
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

class PopDetector {
  constructor(fs) {
    this.fs = fs;
    this.hpA = new HighPass(fs, 1500);
    this.hpB = new HighPass(fs, 1500);

    this.frameLen = Math.max(32, Math.round(fs * 0.0015));
    this.frameDur = this.frameLen / fs;
    this.acc = 0;
    this.accN = 0;
    this.frame = 0;

    // Tunables (overridable via setParams)
    this.thresholdDb = 15; // how far above the noise floor a pop must be
    this.riseDb = 8; // how sharply it must rise vs. the preceding ~3–8 ms
    this.minFloorDb = -85; // never treat the floor as quieter than this
    this.refractoryFrames = Math.round(0.012 / this.frameDur);
    this.peakHoldFrames = Math.max(1, Math.round(0.006 / this.frameDur));
    this.warmupFrames = Math.round(0.4 / this.frameDur);

    // Ring of recent frame energies (linear) for the onset check
    this.recent = new Float64Array(16);
    this.recentPos = 0;

    // Noise-floor tracker: 20th percentile of the last 1.5 s of frame levels
    this.floorN = Math.round(1.5 / this.frameDur);
    this.floorBuf = new Float32Array(this.floorN);
    this.floorSorted = new Float32Array(this.floorN);
    this.floorCount = 0;
    this.floorPos = 0;
    this.floorDb = -100;

    this.lastOnset = -1e9;
    this.pending = null;
    this.muteUntil = 0;
    this.meterMax = -120;

    this.onPop = null; // (timeSec, peakDb, floorDb) => void
  }

  setParams(p) {
    if (typeof p.thresholdDb === 'number') this.thresholdDb = p.thresholdDb;
    if (typeof p.riseDb === 'number') this.riseDb = p.riseDb;
  }

  /** Ignore everything for the next `seconds` (e.g. while our own alarm beeps). */
  mute(seconds) {
    this.muteUntil = Math.max(this.muteUntil, this.frame + Math.ceil(seconds / this.frameDur));
  }

  get time() {
    return this.frame * this.frameDur;
  }

  process(input) {
    const a = this.hpA;
    const b = this.hpB;
    const len = this.frameLen;
    for (let i = 0; i < input.length; i++) {
      const y = b.step(a.step(input[i]));
      this.acc += y * y;
      if (++this.accN === len) {
        this.handleFrame(this.acc / len);
        this.acc = 0;
        this.accN = 0;
      }
    }
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
      // Follow the pop for a few ms to report its peak level
      if (db > this.pending.peak) this.pending.peak = db;
      if (--this.pending.left <= 0) {
        const p = this.pending;
        this.pending = null;
        if (this.onPop) this.onPop(p.frame * this.frameDur, p.peak, p.floor);
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
        });
        d.meterMax = -120;
      }
      return true;
    }
  }

  registerProcessor('pop-detector', PopProcessor);
}
