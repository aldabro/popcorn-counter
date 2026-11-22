/*
 * Session statistics and the "when to stop" logic.
 *
 * Three independent signals decide when popping is (nearly) done:
 *   1. Kernel count  – pops / estimated kernels reaches the alert percentage.
 *   2. Slow-down     – after the peak, there's a gap of N seconds between pops
 *                      (the classic "2–3 seconds between pops" rule).
 *   3. Popping curve – a logistic (S-curve) fitted to the cumulative pop count
 *                      says ≥97% of this batch has popped. This one doesn't depend
 *                      on knowing the kernel count or on catching every pop.
 */

const RATE_WINDOW = 4; // seconds, for "pops per second right now"
export const MIN_FIT_POPS = 20; // pops needed before the S-curve fit is attempted

export const TUNING = {
  // The S-curve must explain the cumulative count much better than a straight
  // line does (squared-error ratio). A straight line is what steady false
  // detections or the sparse first pops look like; a real batch levels off.
  fitVsLineMax: 0.2,
  // The gap rule also needs the current rate to be this far below the peak.
  gapMaxRelRate: 0.25,
  // …and the gap must be at least this many "peak intervals" long, so small
  // batches (which never pop fast) need a proportionally longer silence.
  gapPeakIntervals: 8,
};

export class Session {
  constructor({ kernels = 0, demo = false } = {}) {
    this.kernels = kernels;
    this.demo = demo;
    this.pops = []; // seconds since session start
    this.peakRate = 0;
    this.peakAt = 0;
    this.winStart = 0;
    this.slowing = false;
    this.alarmAt = null;
    this.alarmReason = '';
    this.fit = null;
    this.fitAt = -1;
  }

  add(t) {
    const p = this.pops;
    // keep sorted (messages arrive in order, but be safe)
    if (p.length && t < p[p.length - 1]) {
      let i = p.length;
      while (i > 0 && p[i - 1] > t) i--;
      p.splice(i, 0, t);
    } else p.push(t);
    while (p[this.winStart] <= t - RATE_WINDOW) this.winStart++;
    const r = (p.length - this.winStart) / RATE_WINDOW;
    if (r > this.peakRate) {
      this.peakRate = r;
      this.peakAt = t;
    }
  }

  get count() {
    return this.pops.length;
  }
  get first() {
    return this.pops.length ? this.pops[0] : null;
  }
  get last() {
    return this.pops.length ? this.pops[this.pops.length - 1] : null;
  }

  countAfter(t) {
    // number of pops with time > t
    const p = this.pops;
    let lo = 0;
    let hi = p.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (p[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return p.length - lo;
  }

  rate(now, w = RATE_WINDOW) {
    return this.countAfter(now - w) / w;
  }

  /**
   * Fit N(t) = K / (1 + exp(-(t - t0) / s)) to the cumulative pop count.
   * Grid search over (t0, s) with K solved in closed form, then a finer pass.
   */
  fitCurve(now) {
    const p = this.pops;
    const n = p.length;
    if (n < MIN_FIT_POPS) return null;
    const tA = p[0];
    const tB = now;
    if (tB - tA < 5) return null;
    const dt = Math.max(0.25, (tB - tA) / 400);
    const m = Math.floor((tB - tA) / dt) + 1;
    const ts = new Float64Array(m);
    const ys = new Float64Array(m);
    let j = 0;
    for (let i = 0; i < m; i++) {
      const t = tA + i * dt;
      while (j < n && p[j] <= t) j++;
      ts[i] = t;
      ys[i] = j;
    }

    let syy = 0;
    for (let i = 0; i < m; i++) syy += ys[i] * ys[i];

    // For fixed (t0, s) the best K is closed-form, and the squared error
    // follows from the same sums: SSE = Σy² − (Σfy)² / Σf².
    const evaluate = (t0, s) => {
      let sfy = 0;
      let sff = 0;
      for (let i = 0; i < m; i++) {
        const f = 1 / (1 + Math.exp(-(ts[i] - t0) / s));
        sfy += f * ys[i];
        sff += f * f;
      }
      const K = sfy / sff;
      return { t0, s, K, sse: Math.max(0, syy - (sfy * sfy) / sff) };
    };

    let best = null;
    const span = tB - tA;
    for (let si = 0; si < 26; si++) {
      const s = 0.8 * Math.pow(1.17, si); // 0.8 s … ~40 s
      for (let k = 0; k <= 50; k++) {
        const t0 = tA + (span * k) / 50;
        const r = evaluate(t0, s);
        if (!best || r.sse < best.sse) best = r;
      }
    }
    // refine around the best point
    const b0 = best;
    for (let a = -10; a <= 10; a++) {
      for (let c = -6; c <= 6; c++) {
        const t0 = b0.t0 + (a * span) / 500;
        const s = b0.s * Math.pow(1.17, c / 6);
        if (t0 > tB) continue;
        const r = evaluate(t0, s);
        if (r.sse < best.sse) best = r;
      }
    }

    // Straight-line fit for comparison
    let mt = 0;
    let my = 0;
    for (let i = 0; i < m; i++) {
      mt += ts[i];
      my += ys[i];
    }
    mt /= m;
    my /= m;
    let stt = 0;
    let sty = 0;
    for (let i = 0; i < m; i++) {
      stt += (ts[i] - mt) * (ts[i] - mt);
      sty += (ts[i] - mt) * (ys[i] - my);
    }
    const slope = stt > 0 ? sty / stt : 0;
    let sseLine = 0;
    for (let i = 0; i < m; i++) {
      const e = ys[i] - (my + slope * (ts[i] - mt));
      sseLine += e * e;
    }

    const { t0, s, K } = best;
    const vsLine = sseLine > 0 ? best.sse / sseLine : 1;
    // Trust it only once we're clearly past the inflection point, and the data
    // really has an S shape rather than being a straight-ish ramp.
    const valid =
      Number.isFinite(K) && K >= n * 0.98 && now - t0 >= 1.2 * s && vsLine <= TUNING.fitVsLineMax;
    const progress = 1 / (1 + Math.exp(-(now - t0) / s));
    const doneAt = t0 + s * Math.log(0.97 / 0.03);
    return { t0, s, K, valid, progress, doneAt, vsLine };
  }

  /** Re-fit at most once per second. */
  curve(now) {
    if (now - this.fitAt >= 1 || !this.fit) {
      this.fit = this.fitCurve(now);
      this.fitAt = now;
    }
    return this.fit;
  }

  /**
   * Work out the current phase and whether it's time to stop.
   * @param {number} now seconds since session start
   * @param {{alertPct:number, gapSec:number}} cfg
   */
  evaluate(now, cfg) {
    const n = this.count;
    const pct = this.kernels > 0 ? n / this.kernels : null;
    const rateNow = this.rate(now);
    const sinceLast = n ? now - this.last : null;
    const curve = this.curve(now);
    const curveOk = curve && curve.valid;

    // "Past the peak": the S-curve fitted to *all* pops so far says we're clearly
    // beyond its midpoint, and the current rate is well below the peak. Using the
    // fit (not just the rate) stops a random cluster among the sparse first pops,
    // or a few false detections, from looking like a peak that has passed.
    // Sticky (hysteresis) so a short late burst doesn't flip the status back and forth.
    if (curveOk && now - this.peakAt >= 3 && rateNow <= 0.5 * this.peakRate) {
      this.slowing = true;
    } else if (this.slowing && rateNow > 0.75 * this.peakRate) {
      this.slowing = false;
    }
    const postPeak = this.slowing;

    const reasons = [];
    if (pct !== null && cfg.alertPct > 0 && pct * 100 >= cfg.alertPct) {
      reasons.push(`${Math.round(pct * 100)}% of the kernels have popped`);
    }
    const gapNeeded = Math.max(cfg.gapSec, TUNING.gapPeakIntervals / Math.max(this.peakRate, 0.1));
    if (postPeak && sinceLast >= gapNeeded && rateNow <= TUNING.gapMaxRelRate * this.peakRate) {
      reasons.push(`no pop for ${sinceLast.toFixed(1)} s, popping has nearly stopped`);
    }
    if (postPeak && curveOk && curve.progress >= 0.97) {
      reasons.push('the popping curve is about 97% complete');
    }

    const stop = reasons.length > 0;
    if (stop && this.alarmAt === null) {
      this.alarmAt = now;
      this.alarmReason = reasons[0];
    }

    let phase;
    if (this.alarmAt !== null) phase = 'stop';
    else if (n === 0) phase = 'waiting';
    else if (postPeak || (pct !== null && cfg.alertPct > 0 && pct * 100 >= cfg.alertPct - 10)) phase = 'ready';
    else if (n < 10 || this.peakRate < 1) phase = 'starting';
    else phase = 'popping';

    return { n, pct, rateNow, sinceLast, curve, curveOk, postPeak, phase, reasons };
  }

  summary(now) {
    const n = this.count;
    return {
      pops: n,
      kernels: this.kernels,
      pct: this.kernels > 0 ? n / this.kernels : null,
      firstPop: this.first,
      lastPop: this.last,
      peakRate: this.peakRate,
      peakAt: this.peakAt,
      alarmAt: this.alarmAt,
      duration: now,
    };
  }
}
