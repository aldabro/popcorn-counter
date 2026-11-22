import { Session, MIN_FIT_POPS } from './stats.js';
import { RateChart, fmtTime } from './chart.js';
import { makeDemoBuffer } from './demo.js';

const $ = (id) => document.getElementById(id);

/* ───────────── Constants ───────────── */

// Kernels per gram, from supplier spec sheets (kernels per 10 g ÷ 10)
const KPG = { butterfly: 6.5, mushroom: 5.2 };
// Share of a microwave bag's net weight that is kernels (rest: fat, salt)
const BAG_KERNEL_SHARE = 0.7;
// Demo batch
const DEMO_GRAMS = 25;
const DEMO_KERNELS = Math.round(DEMO_GRAMS * KPG.butterfly);
// Sensitivity 1…10 → dB above the noise floor a pop must reach
const SENS_DB = [22, 19, 16.5, 14, 12, 10, 8.5, 7, 6, 5];

const SETTINGS_KEY = 'popcorn-counter:settings';
const HISTORY_KEY = 'popcorn-counter:history';

/* ───────────── Storage (best effort) ───────────── */

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode etc. – fine */
  }
}

const DEFAULTS = {
  grams: '',
  form: 'loose',
  variety: 'butterfly',
  kpg: 6.5,
  sensitivity: 6,
  alertPct: 85,
  gapSec: 2.5,
  sound: true,
  demoSound: true,
  voiceFilter: true,
};
const settings = { ...DEFAULTS, ...load(SETTINGS_KEY, {}) };
const saveSettings = () => store(SETTINGS_KEY, settings);

/* ───────────── Derived values ───────────── */

function kernelsPerGram() {
  if (settings.variety === 'custom') {
    const v = parseFloat(settings.kpg);
    return v > 0 ? v : KPG.butterfly;
  }
  return KPG[settings.variety] || KPG.butterfly;
}

function estimatedKernels() {
  const g = parseFloat(settings.grams);
  if (!(g > 0)) return 0;
  const share = settings.form === 'bag' ? BAG_KERNEL_SHARE : 1;
  return Math.round(g * share * kernelsPerGram());
}

function detectorParams() {
  const th = SENS_DB[Math.min(10, Math.max(1, settings.sensitivity)) - 1];
  return {
    thresholdDb: th,
    riseDb: Math.min(9, Math.max(5, th * 0.8)),
    voiceFilter: settings.voiceFilter,
  };
}

/* ───────────── Setup form ───────────── */

const el = {
  grams: $('grams'),
  variety: $('variety'),
  kpg: $('kpg'),
  customField: $('custom-field'),
  formHint: $('form-hint'),
  estimate: $('estimate'),
  start: $('start'),
  demo: $('demo'),
  notice: $('notice'),
  setup: $('setup'),
  live: $('live'),
  status: $('status'),
  ack: $('ack'),
  count: $('count'),
  pct: $('pct'),
  pctLabel: $('pct-label'),
  pctBlock: $('pct-block'),
  progress: $('progress'),
  progressFill: $('progress-fill'),
  progressMarker: $('progress-marker'),
  popLayer: $('pop-layer'),
  demoTag: $('demo-tag'),
  meterFill: $('meter-fill'),
  meterFloor: $('meter-floor'),
  meterThreshold: $('meter-threshold'),
  meterHint: $('meter-hint'),
  finish: $('finish'),
  reset: $('reset'),
  again: $('again'),
  sensitivity: $('sensitivity'),
  sensitivityOut: $('sensitivity-out'),
  alertPct: $('alert-pct'),
  gapSec: $('gap-sec'),
  sound: $('sound'),
  demoSound: $('demo-sound'),
  voiceFilter: $('voice-filter'),
  voiceChip: $('voice-chip'),
  historyCard: $('history-card'),
  history: $('history'),
  clearHistory: $('clear-history'),
};

function renderEstimate() {
  const n = estimatedKernels();
  const kpg = kernelsPerGram();
  el.customField.hidden = settings.variety !== 'custom';
  el.formHint.textContent =
    settings.form === 'bag'
      ? 'Use the net weight printed on the bag. About 70% of it is kernels; the rest is oil or butter and salt.'
      : '';
  el.estimate.replaceChildren();
  if (n > 0) {
    const strong = document.createElement('strong');
    strong.textContent = `≈ ${n.toLocaleString()} kernels`;
    const g = parseFloat(settings.grams);
    const how =
      settings.form === 'bag'
        ? ` (${g} g × 70% kernels × ${kpg} per g)`
        : ` (${g} g × ${kpg} kernels per g)`;
    el.estimate.append(strong, how);
  } else {
    el.estimate.textContent =
      'Enter the amount to see what share has popped. Counting and the slow-down alarm work without it.';
  }
}

function initForm() {
  el.grams.value = settings.grams;
  el.variety.value = settings.variety;
  el.kpg.value = settings.kpg;
  document.querySelector(`input[name="form"][value="${settings.form}"]`).checked = true;
  el.sensitivity.value = settings.sensitivity;
  el.alertPct.value = String(settings.alertPct);
  el.gapSec.value = String(settings.gapSec);
  el.sound.checked = settings.sound;
  el.demoSound.checked = settings.demoSound;
  el.voiceFilter.checked = settings.voiceFilter;
  renderSensitivity();
  renderEstimate();

  el.grams.addEventListener('input', () => {
    settings.grams = el.grams.value;
    saveSettings();
    renderEstimate();
  });
  document.querySelectorAll('.chip[data-grams]').forEach((b) =>
    b.addEventListener('click', () => {
      el.grams.value = b.dataset.grams;
      settings.grams = b.dataset.grams;
      saveSettings();
      renderEstimate();
    }),
  );
  document.querySelectorAll('input[name="form"]').forEach((r) =>
    r.addEventListener('change', () => {
      settings.form = r.value;
      saveSettings();
      renderEstimate();
    }),
  );
  el.variety.addEventListener('change', () => {
    settings.variety = el.variety.value;
    saveSettings();
    renderEstimate();
  });
  el.kpg.addEventListener('input', () => {
    settings.kpg = el.kpg.value;
    saveSettings();
    renderEstimate();
  });
  el.sensitivity.addEventListener('input', () => {
    settings.sensitivity = parseInt(el.sensitivity.value, 10);
    saveSettings();
    renderSensitivity();
    if (audio) audio.node.port.postMessage({ type: 'params', ...detectorParams() });
  });
  el.voiceFilter.addEventListener('change', () => {
    settings.voiceFilter = el.voiceFilter.checked;
    saveSettings();
    if (audio) audio.node.port.postMessage({ type: 'params', ...detectorParams() });
    renderSlow();
  });
  el.alertPct.addEventListener('change', () => {
    settings.alertPct = parseFloat(el.alertPct.value);
    saveSettings();
    renderProgressMarker();
  });
  el.gapSec.addEventListener('change', () => {
    settings.gapSec = parseFloat(el.gapSec.value);
    saveSettings();
  });
  el.sound.addEventListener('change', () => {
    settings.sound = el.sound.checked;
    saveSettings();
  });
  el.demoSound.addEventListener('change', () => {
    settings.demoSound = el.demoSound.checked;
    saveSettings();
    if (audio && audio.gain) audio.gain.gain.value = settings.demoSound ? 0.8 : 0;
  });
}

function renderSensitivity() {
  const s = settings.sensitivity;
  const word = s <= 3 ? 'low' : s <= 7 ? 'normal' : 'high';
  el.sensitivityOut.textContent = `${s} (${word})`;
}

/* ───────────── Support check ───────────── */

function showNotice(msg) {
  el.notice.textContent = msg;
  el.notice.hidden = !msg;
}

function checkSupport() {
  const hasWorklet = typeof window.AudioWorkletNode === 'function';
  const hasMic = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  if (!hasWorklet) {
    el.start.disabled = true;
    el.demo.disabled = true;
    showNotice(
      'This browser is missing the audio features this app needs. Please use a current version of Chrome, Firefox, Safari or Edge.',
    );
    return;
  }
  if (!window.isSecureContext || !hasMic) {
    el.start.disabled = true;
    showNotice(
      window.isSecureContext
        ? 'This browser does not give web pages access to the microphone. The demo still works.'
        : 'Microphone access only works over HTTPS (or on localhost). Open the page via its https:// address. The demo still works.',
    );
  }
}

/* ───────────── Audio + session ───────────── */

let audio = null; // { ctx, node, src, stream, gain, kind }
let session = null;
let t0 = 0; // AudioContext time at which the session started
let state = 'setup'; // setup | running | finished
let finalNow = 0;
let meter = null;
let shownLevel = -120;
let silentSince = null;
let ignoredVoice = 0; // sounds the detector ignored as talking, this session
let voiceSeenAt = -Infinity; // session time when a voice was last heard
let countShown = -1;
let alarm = { started: false, acked: false, timer: null };
let wakeLock = null;
let slowTimer = null;
let rafId = null;
let lastEval = null;

const chart = new RateChart($('chart'), $('chart-tip'));

function now() {
  if (state === 'finished') return finalNow;
  return audio ? Math.max(0, audio.ctx.currentTime - t0) : 0;
}

async function start(kind) {
  showNotice('');
  el.start.disabled = el.demo.disabled = true;
  let ctx = null;
  let stream = null;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    const resumed = ctx.resume(); // must be called inside the click

    if (kind === 'mic') {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
    }

    await ctx.audioWorklet.addModule(new URL('./pop-worklet.js', import.meta.url));
    await resumed;

    const node = new AudioWorkletNode(ctx, 'pop-detector', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: detectorParams(),
    });
    node.connect(ctx.destination); // outputs silence; keeps the node running everywhere

    let src;
    let gain = null;
    let kernels;
    if (kind === 'mic') {
      src = ctx.createMediaStreamSource(stream);
      src.connect(node);
      kernels = estimatedKernels();
    } else {
      const { buffer } = makeDemoBuffer(ctx, {
        kernels: DEMO_KERNELS,
        seed: (Math.random() * 1e9) | 0,
      });
      src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(node);
      gain = ctx.createGain();
      gain.gain.value = settings.demoSound ? 0.8 : 0;
      src.connect(gain).connect(ctx.destination);
      src.onended = () => {
        if (audio && audio.src === src && state === 'running') finish();
      };
      src.start();
      kernels = DEMO_KERNELS;
    }

    node.port.onmessage = onWorkletMessage;
    audio = { ctx, node, src, stream, gain, kind };
    beginSession(kernels, kind === 'demo');
  } catch (err) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close().catch(() => {});
    showNotice(describeError(err));
  } finally {
    el.start.disabled = el.demo.disabled = false;
    checkSupport();
  }
}

function describeError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Microphone access was blocked. Allow it in your browser’s site settings (the icon next to the address bar) and try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found on this device.';
  if (name === 'NotReadableError') return 'The microphone is busy. Close other apps that use it and try again.';
  return `Could not start listening: ${err && err.message ? err.message : err}`;
}

function beginSession(kernels, demo) {
  session = new Session({ kernels, demo });
  t0 = audio.ctx.currentTime;
  state = 'running';
  resetAlarm();
  countShown = -1;
  silentSince = null;
  ignoredVoice = 0;
  voiceSeenAt = -Infinity;

  el.setup.hidden = true;
  el.live.hidden = false;
  el.finish.hidden = el.reset.hidden = false;
  el.again.hidden = true;
  el.demoTag.hidden = !demo;
  el.pctBlock.hidden = !(kernels > 0);
  el.progress.hidden = !(kernels > 0);
  el.pctLabel.textContent = `of ≈ ${kernels.toLocaleString()} kernels`;
  renderProgressMarker();
  window.scrollTo({ top: 0, behavior: 'smooth' });

  acquireWakeLock();
  clearInterval(slowTimer);
  slowTimer = setInterval(renderSlow, 250);
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(frame);
  renderSlow();
}

function onWorkletMessage(e) {
  const m = e.data;
  if (m.type === 'pop') {
    if (state !== 'running' || !session) return;
    const t = m.t - t0;
    if (t < 0) return;
    session.add(t);
    popEffect();
  } else if (m.type === 'ignored') {
    if (state === 'running' && m.t - t0 >= 0) ignoredVoice++;
  } else if (m.type === 'meter') {
    meter = m;
    if (m.voice) voiceSeenAt = m.t - t0;
  }
}

function resetCount() {
  if (state !== 'running') return;
  session = new Session({ kernels: session.kernels, demo: session.demo });
  t0 = audio.ctx.currentTime;
  ignoredVoice = 0;
  voiceSeenAt = -Infinity;
  resetAlarm();
  renderSlow();
}

function finish() {
  if (state !== 'running') return;
  renderSlow();
  finalNow = now();
  state = 'finished';
  stopAlarm();
  releaseWakeLock();
  clearInterval(slowTimer);
  cancelAnimationFrame(rafId);
  teardownAudio();

  el.finish.hidden = el.reset.hidden = true;
  el.again.hidden = false;
  el.meterFill.style.width = '0%';
  renderFast();
  renderFinished();
  if (!session.demo && session.count > 0) saveToHistory();
}

function teardownAudio() {
  if (!audio) return;
  const a = audio;
  audio = null;
  try {
    a.node.port.onmessage = null;
    if (a.src && a.src.stop && a.kind === 'demo') a.src.onended = null;
    if (a.src && a.src.stop && a.kind === 'demo') a.src.stop();
  } catch {
    /* already stopped */
  }
  if (a.stream) a.stream.getTracks().forEach((t) => t.stop());
  a.ctx.close().catch(() => {});
}

function newBatch() {
  state = 'setup';
  session = null;
  el.live.hidden = true;
  el.setup.hidden = false;
  renderEstimate();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ───────────── Wake lock ───────────── */

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {
    /* not allowed / not supported */
  }
}
function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state === 'running') {
    acquireWakeLock();
    if (audio && audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
  }
});

/* ───────────── Alarm ───────────── */

function resetAlarm() {
  stopAlarm();
  alarm = { started: false, acked: false, timer: null };
  el.ack.hidden = true;
}
function stopAlarm() {
  clearInterval(alarm.timer);
  alarm.timer = null;
  el.status.classList.remove('flash');
}
function startAlarm() {
  alarm.started = true;
  el.ack.hidden = false;
  el.status.classList.add('flash');
  ring();
  alarm.timer = setInterval(ring, 8000);
}
function ring() {
  if (alarm.acked || state !== 'running') return;
  if (navigator.vibrate) {
    try {
      navigator.vibrate([300, 150, 300, 150, 300]);
    } catch {
      /* ignore */
    }
  }
  if (!settings.sound || !audio) return;
  const { ctx, node } = audio;
  node.port.postMessage({ type: 'mute', seconds: 1.4 }); // don't count our own beeps
  const t = ctx.currentTime + 0.05;
  for (let i = 0; i < 3; i++) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = i === 2 ? 660 : 880;
    const s = t + i * 0.3;
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(0.5, s + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, s + 0.22);
    osc.connect(g).connect(ctx.destination);
    osc.start(s);
    osc.stop(s + 0.25);
  }
}
function ackAlarm() {
  alarm.acked = true;
  stopAlarm();
  el.ack.hidden = true;
  renderSlow();
}

/* ───────────── Rendering ───────────── */

function frame() {
  renderFast();
  if (state === 'running') rafId = requestAnimationFrame(frame);
}

function renderFast() {
  if (!session) return;
  const n = session.count;
  if (n !== countShown) {
    el.count.textContent = n.toLocaleString();
    if (n > countShown && countShown >= 0) {
      el.count.classList.remove('bump');
      void el.count.offsetWidth; // restart animation
      el.count.classList.add('bump');
    }
    countShown = n;
    if (session.kernels > 0) {
      const p = (n / session.kernels) * 100;
      el.pct.textContent = `${p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)}%`;
      el.progressFill.style.width = `${Math.min(100, p)}%`;
      el.progress.setAttribute('aria-valuenow', String(Math.round(Math.min(100, p))));
    }
  }

  if (meter && state === 'running') {
    const pos = (db) => Math.min(100, Math.max(0, ((db + 90) / 90) * 100));
    shownLevel = Math.max(meter.level, shownLevel - 2.5);
    const hot = meter.level >= meter.floor + meter.threshold;
    el.meterFill.style.width = `${pos(shownLevel)}%`;
    el.meterFill.classList.toggle('hot', hot);
    el.meterFloor.style.left = `${pos(meter.floor)}%`;
    el.meterThreshold.style.left = `${pos(meter.floor + meter.threshold)}%`;
  }
}

function renderProgressMarker() {
  const a = settings.alertPct;
  el.progressMarker.hidden = !(a > 0);
  el.progressMarker.style.left = `${Math.min(100, a)}%`;
  el.progressMarker.title = `Alarm at ${a}%`;
}

function setStatus(kind, icon, title, detail) {
  el.status.classList.remove('neutral', 'good', 'warning', 'critical');
  el.status.classList.add(kind);
  el.status.querySelector('.status-icon').textContent = icon;
  const titleEl = el.status.querySelector('.status-title');
  const changed = titleEl.textContent !== title;
  titleEl.textContent = title;
  el.status.querySelector('.status-detail').textContent = detail;
  // Announce only phase changes (the detail line updates several times a second)
  if (changed) {
    const sr = $('sr-status');
    sr.setAttribute('aria-live', kind === 'critical' ? 'assertive' : 'polite');
    sr.textContent = `${title} ${detail}`;
  }
}

function setText(id, text) {
  const node = $(id);
  if (node.textContent !== text) node.textContent = text;
}

function renderSlow() {
  if (!session) return;
  const t = now();
  const ev = session.evaluate(t, settings);
  lastEval = ev;

  // Status banner
  if (state === 'running') {
    if (ev.phase === 'stop' && !alarm.started) startAlarm();
    switch (ev.phase) {
      case 'waiting':
        setStatus('neutral', '👂', 'Listening…', 'Waiting for the first pop.');
        break;
      case 'starting':
        setStatus('neutral', '✨', 'First pops!', 'Popping is getting started.');
        break;
      case 'popping':
        setStatus('good', '🔥', 'Popping in full swing', `${ev.rateNow.toFixed(1)} pops per second right now.`);
        break;
      case 'ready': {
        const share = session.peakRate > 0 ? Math.round((ev.rateNow / session.peakRate) * 100) : 0;
        const detail = ev.postPeak
          ? `Popping is down to ${share}% of its peak. Get ready to take it off the heat.`
          : `${Math.round(ev.pct * 100)}% popped. The alarm goes off at ${settings.alertPct}%.`;
        setStatus('warning', '⏳', 'Slowing down, get ready', detail);
        break;
      }
      case 'stop':
        setStatus(
          'critical',
          '🛑',
          'Take it off the heat!',
          `Because ${session.alarmReason}.` + (alarm.acked ? ' Press Finish when you’re done.' : ''),
        );
        break;
    }
  }

  // Stats
  setText('s-elapsed', fmtTime(t));
  setText('s-first', session.first === null ? '–' : fmtTime(session.first));
  setText('s-rate', ev.rateNow.toFixed(1));
  setText('s-peak', session.peakRate > 0 ? session.peakRate.toFixed(1) : '–');
  setText('s-peak-at', session.peakRate > 0 ? `at ${fmtTime(session.peakAt)}` : '');
  setText('s-gap', ev.sinceLast === null ? '–' : `${ev.sinceLast.toFixed(1)} s`);
  if (ev.curveOk) {
    setText('s-curve', `${Math.min(99, Math.round(ev.curve.progress * 100))}%`);
    const left = ev.curve.doneAt - t;
    setText('s-curve-sub', left > 1 ? `≈ ${Math.round(left)} s to go` : 'nearly done');
  } else {
    setText('s-curve', '–');
    setText('s-curve-sub', ev.n < MIN_FIT_POPS ? `needs ${MIN_FIT_POPS}+ pops` : 'after the peak');
  }

  // Microphone hint
  if (state === 'running' && meter) {
    if (meter.level < -100) silentSince = silentSince === null ? t : silentSince;
    else silentSince = null;
    setText(
      'meter-hint',
      silentSince !== null && t - silentSince > 3
        ? 'No sound is reaching the microphone. Is the right microphone selected, or is it muted?'
        : 'Grey tick: background noise. A sound must jump past the orange tick to count as a pop.',
    );
  }

  // Voice filter feedback
  // held for 2 s so it doesn't flicker in the short pauses between phrases
  const talking = state === 'running' && settings.voiceFilter && t - voiceSeenAt < 2;
  el.voiceChip.hidden = !talking;
  const ignored = ignoredVoice
    ? `${ignoredVoice.toLocaleString()} voice ${ignoredVoice === 1 ? 'sound' : 'sounds'} ignored so far.`
    : 'Nothing ignored so far.';
  setText(
    'voice-hint',
    !settings.voiceFilter
      ? 'Talking filter is off: voices can be counted as pops.'
      : talking
        ? `🗣️ Hearing voices: only clear pops count while people talk. ${ignored}`
        : `🗣️ Talking filter is on. ${ignored}`,
  );

  const markers = session.alarmAt !== null ? [{ t: session.alarmAt, label: 'alarm' }] : [];
  chart.update(session.pops, t, markers);
}

function renderFinished() {
  const s = session.summary(finalNow);
  const parts = [`${s.pops.toLocaleString()} pops`];
  if (s.pct !== null) parts[0] += ` (${Math.round(s.pct * 100)}% of ≈ ${s.kernels.toLocaleString()} kernels)`;
  if (s.firstPop !== null) parts.push(`first pop after ${fmtTime(s.firstPop)}`);
  if (s.firstPop !== null && s.lastPop !== null) parts.push(`popping lasted ${fmtTime(s.lastPop - s.firstPop)}`);
  setStatus('good', '✅', session.demo ? 'Demo finished' : 'Finished, enjoy!', parts.join(' · ') + '.');
  el.ack.hidden = true;
  renderSlow();
}

function popEffect() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (el.popLayer.childElementCount > 14) return;
  const s = document.createElement('span');
  s.className = 'pop-fx';
  s.textContent = '🍿';
  s.style.left = `${8 + Math.random() * 84}%`;
  s.style.setProperty('--dx', `${(Math.random() - 0.5) * 60}px`);
  s.style.setProperty('--rot', `${(Math.random() - 0.5) * 120}deg`);
  s.addEventListener('animationend', () => s.remove());
  el.popLayer.append(s);
}

/* ───────────── History ───────────── */

function saveToHistory() {
  const s = session.summary(finalNow);
  const entry = {
    date: new Date().toISOString(),
    grams: parseFloat(settings.grams) || null,
    form: settings.form,
    kernels: s.kernels,
    pops: s.pops,
    pct: s.pct,
    firstPop: s.firstPop,
    popping: s.firstPop !== null && s.lastPop !== null ? s.lastPop - s.firstPop : null,
    peakRate: s.peakRate,
    alarmAt: s.alarmAt,
  };
  const list = load(HISTORY_KEY, []);
  list.unshift(entry);
  store(HISTORY_KEY, list.slice(0, 20));
  renderHistory();
}

function renderHistory() {
  const list = load(HISTORY_KEY, []);
  el.historyCard.hidden = list.length === 0;
  el.history.replaceChildren(
    ...list.map((h) => {
      const li = document.createElement('li');
      const d = new Date(h.date);
      const strong = document.createElement('strong');
      strong.textContent = d.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
      const bits = [];
      if (h.grams) bits.push(`${h.grams} g ${h.form === 'bag' ? 'bag' : 'kernels'}`);
      bits.push(`${h.pops} pops${h.pct !== null ? ` (${Math.round(h.pct * 100)}%)` : ''}`);
      if (h.firstPop !== null) bits.push(`first pop at ${fmtTime(h.firstPop)}`);
      if (h.popping !== null) bits.push(`popping lasted ${fmtTime(h.popping)}`);
      if (h.peakRate) bits.push(`peak ${h.peakRate.toFixed(1)}/s`);
      if (h.alarmAt !== null) bits.push(`alarm at ${fmtTime(h.alarmAt)}`);
      li.append(strong, document.createElement('br'), bits.join(' · '));
      return li;
    }),
  );
}

/* ───────────── Wire up ───────────── */

initForm();
checkSupport();
renderHistory();

el.start.addEventListener('click', () => start('mic'));
el.demo.addEventListener('click', () => start('demo'));
el.finish.addEventListener('click', finish);
el.reset.addEventListener('click', resetCount);
el.again.addEventListener('click', newBatch);
el.ack.addEventListener('click', ackAlarm);
el.clearHistory.addEventListener('click', () => {
  store(HISTORY_KEY, []);
  renderHistory();
});

// Exposed for debugging in the console
window.popcorn = {
  get session() {
    return session;
  },
  get evaluation() {
    return lastEval;
  },
};
