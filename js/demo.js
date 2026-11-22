/*
 * Synthetic popcorn for the demo mode (and for testing the detector).
 * Generates a mono AudioBuffer with kitchen-like background noise
 * (hum, rumble, hiss, faint oil sizzle) and one short noise burst per pop.
 * Pop times follow a slightly right-skewed bell curve, like a real batch.
 */

function rng(seed) {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand) {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * @param {BaseAudioContext} ctx
 * @param {object} o
 * @returns {{buffer: AudioBuffer, popTimes: number[]}}
 */
export function makeDemoBuffer(ctx, o = {}) {
  const {
    kernels = 160,
    popYield = 0.92,
    duration = 60,
    center = 26, // s, peak of popping
    spreadEarly = 6, // s, std-dev before the peak
    spreadLate = 8.5, // s, std-dev after the peak (late stragglers)
    seed = 7,
    noise = 1, // background loudness multiplier
    sizzleRate = 40, // faint oil crackles per second
  } = o;

  const rand = rng(seed);
  const fs = ctx.sampleRate;
  const n = Math.round(duration * fs);
  const buffer = ctx.createBuffer(1, n, fs);
  const d = buffer.getChannelData(0);

  // Background: hum + low rumble + hiss
  let lp = 0;
  const lpK = Math.exp((-2 * Math.PI * 300) / fs);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    lp = lpK * lp + (1 - lpK) * (rand() * 2 - 1);
    d[i] =
      noise *
      (0.02 * Math.sin(2 * Math.PI * 100 * t) +
        0.008 * Math.sin(2 * Math.PI * 200 * t + 1) +
        0.25 * lp +
        0.003 * (rand() * 2 - 1));
  }

  // Faint sizzle: tiny clicks (should NOT be counted)
  const nSizzle = Math.round(sizzleRate * duration);
  for (let k = 0; k < nSizzle; k++) {
    const i0 = Math.floor(rand() * (n - 64));
    const amp = noise * (0.002 + rand() * 0.006);
    for (let j = 0; j < 24; j++) d[i0 + j] += amp * (rand() * 2 - 1) * Math.exp(-j / 6);
  }

  // Pops
  const popTimes = [];
  for (let k = 0; k < kernels; k++) {
    if (rand() > popYield) continue; // an unpopped "old maid"
    const g = gauss(rand);
    const t = center + g * (g < 0 ? spreadEarly : spreadLate);
    if (t < 1 || t > duration - 0.5) continue;
    popTimes.push(t);
  }
  popTimes.sort((a, b) => a - b);

  for (const t of popTimes) {
    const amp = Math.pow(10, -1.5 + rand() * 1.2); // ≈ -30 … -6 dBFS
    const tau = (1.5 + rand() * 3.5) / 1000; // 1.5–5 ms decay
    const f0 = 1500 + rand() * 4500; // body resonance
    const r = Math.exp(-Math.PI * 600 / fs);
    const c1 = 2 * r * Math.cos((2 * Math.PI * f0) / fs);
    const c2 = -r * r;
    const len = Math.min(Math.ceil(tau * 7 * fs), n);
    const i0 = Math.floor(t * fs);
    let y1 = 0;
    let y2 = 0;
    // normalise resonator gain roughly
    const g0 = (1 - r) * 1.5;
    for (let j = 0; j < len && i0 + j < n; j++) {
      const env = Math.exp(-j / (tau * fs));
      const x = (rand() * 2 - 1) * env;
      const y = g0 * x + c1 * y1 + c2 * y2;
      y2 = y1;
      y1 = y;
      d[i0 + j] += amp * (0.55 * x + 0.45 * y * 6);
    }
  }

  // Soft clip so nothing exceeds full scale
  for (let i = 0; i < n; i++) {
    const v = d[i];
    if (v > 0.95 || v < -0.95) d[i] = Math.tanh(v);
  }

  return { buffer, popTimes };
}
