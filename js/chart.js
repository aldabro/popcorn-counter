/*
 * Pops-per-second column chart drawn on a <canvas>, with a hover/touch tooltip.
 * Colours come from CSS custom properties so light/dark themes just work.
 */

const BIN_CHOICES = [1, 2, 5, 10, 15, 30];

export function fmtTime(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '–';
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function niceStep(max, ticks = 4) {
  const raw = max / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

function fmtNum(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export class RateChart {
  constructor(canvas, tooltip) {
    this.canvas = canvas;
    this.tooltip = tooltip;
    this.ctx = canvas.getContext('2d');
    this.bins = [];
    this.binSize = 1;
    this.layout = null;
    this.hover = -1;
    this.markers = [];

    const move = (e) => {
      const r = canvas.getBoundingClientRect();
      this.setHover(e.clientX - r.left);
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerdown', move);
    canvas.addEventListener('pointerleave', () => this.setHover(null));
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  /**
   * @param {number[]} pops sorted pop times (s since start)
   * @param {number} now seconds since start
   * @param {{t:number,label:string}[]} markers vertical markers (e.g. the alarm)
   */
  update(pops, now, markers = []) {
    const width = this.canvas.clientWidth || 300;
    const span = Math.max(now, 10);
    const maxBins = Math.max(10, Math.floor((width - 40) / 6));
    this.binSize = BIN_CHOICES.find((b) => span / b <= maxBins) || 60;
    const nBins = Math.ceil(span / this.binSize);
    const bins = new Array(nBins).fill(0);
    for (const t of pops) {
      const i = Math.floor(t / this.binSize);
      if (i >= 0 && i < nBins) bins[i]++;
    }
    this.bins = bins;
    this.span = nBins * this.binSize;
    this.now = now;
    this.markers = markers;
    this.draw();
  }

  css(name) {
    return getComputedStyle(this.canvas).getPropertyValue(name).trim();
  }

  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const colBar = this.css('--chart-bar') || '#eb6834';
    const colBarHover = this.css('--chart-bar-hover') || colBar;
    const colGrid = this.css('--chart-grid') || '#e5e2dc';
    const colText = this.css('--text-muted') || '#6b6862';
    const colMarker = this.css('--critical') || '#c62828';
    g.font = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

    const rates = this.bins.map((v) => v / this.binSize);
    const maxRate = Math.max(1, ...rates);
    const step = niceStep(maxRate);
    const yMax = Math.ceil(maxRate / step) * step;

    const padL = 30;
    const padR = 8;
    const padT = 18;
    const padB = 20;
    const pw = W - padL - padR;
    const ph = H - padT - padB;
    const x = (t) => padL + (t / (this.span || 10)) * pw;
    const y = (v) => padT + ph - (v / yMax) * ph;

    // grid + y labels
    g.strokeStyle = colGrid;
    g.lineWidth = 1;
    g.fillStyle = colText;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      g.beginPath();
      g.moveTo(padL, yy);
      g.lineTo(W - padR, yy);
      g.stroke();
      g.fillText(fmtNum(v), padL - 6, yy);
    }

    // x labels (time)
    g.textAlign = 'center';
    g.textBaseline = 'top';
    const tStep = niceStep(this.span || 10, Math.max(2, Math.floor(pw / 70)));
    const tStepNice = [5, 10, 15, 20, 30, 60, 120, 300].find((s) => s >= tStep) || 600;
    for (let t = 0; t <= (this.span || 10) + 1e-9; t += tStepNice) {
      g.fillText(fmtTime(t), Math.min(W - padR - 12, Math.max(padL + 12, x(t))), H - padB + 5);
    }

    // bars
    const slot = pw / Math.max(1, this.bins.length);
    const gap = slot > 4 ? 2 : slot > 2.5 ? 1 : 0;
    const bw = Math.min(24, slot - gap);
    const layout = [];
    for (let i = 0; i < rates.length; i++) {
      const r = rates[i];
      const cx = padL + slot * i + slot / 2;
      layout.push({ x0: padL + slot * i, x1: padL + slot * (i + 1), i });
      if (!r) continue;
      const top = y(r);
      const bottom = y(0);
      const h = Math.max(1, bottom - top);
      const rad = Math.min(4, bw / 2, h);
      g.fillStyle = i === this.hover ? colBarHover : colBar;
      g.beginPath();
      const x0 = cx - bw / 2;
      g.moveTo(x0, bottom);
      g.lineTo(x0, bottom - h + rad);
      g.quadraticCurveTo(x0, bottom - h, x0 + rad, bottom - h);
      g.lineTo(x0 + bw - rad, bottom - h);
      g.quadraticCurveTo(x0 + bw, bottom - h, x0 + bw, bottom - h + rad);
      g.lineTo(x0 + bw, bottom);
      g.closePath();
      g.fill();
    }
    this.layout = layout;

    // markers (e.g. "alarm")
    for (const m of this.markers) {
      if (m.t === null || m.t === undefined) continue;
      const xx = Math.round(x(m.t)) + 0.5;
      g.strokeStyle = colMarker;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(xx, padT - 4);
      g.lineTo(xx, padT + ph);
      g.stroke();
      g.fillStyle = colText;
      g.textBaseline = 'bottom';
      g.textAlign = xx > W - 60 ? 'right' : 'left';
      g.fillText(m.label, xx + (g.textAlign === 'left' ? 4 : -4), padT + 8);
    }

    // peak label
    if (rates.length && maxRate > 0) {
      const iPeak = rates.indexOf(Math.max(...rates));
      if (rates[iPeak] > 0) {
        const cx = padL + slot * iPeak + slot / 2;
        g.fillStyle = colText;
        g.textBaseline = 'bottom';
        g.textAlign = cx < padL + 40 ? 'left' : cx > W - 40 ? 'right' : 'center';
        g.fillText(`peak ${fmtNum(+rates[iPeak].toFixed(1))}/s`, cx, y(rates[iPeak]) - 3);
      }
    }
    this.renderTooltip();
  }

  setHover(px) {
    let idx = -1;
    if (px !== null && this.layout) {
      const hit = this.layout.find((l) => px >= l.x0 && px < l.x1);
      if (hit) idx = hit.i;
    }
    if (idx !== this.hover) {
      this.hover = idx;
      this.draw();
    }
  }

  renderTooltip() {
    const tip = this.tooltip;
    if (!tip) return;
    if (this.hover < 0 || !this.layout || !this.layout[this.hover]) {
      tip.hidden = true;
      return;
    }
    const i = this.hover;
    const n = this.bins[i];
    const t0 = i * this.binSize;
    const rate = n / this.binSize;
    tip.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'tip-head';
    head.textContent = `${fmtTime(t0)} – ${fmtTime(t0 + this.binSize)}`;
    const body = document.createElement('div');
    body.textContent =
      this.binSize === 1 ? `${n} pop${n === 1 ? '' : 's'}` : `${n} pops · ${fmtNum(+rate.toFixed(1))}/s`;
    tip.append(head, body);
    tip.hidden = false;
    const l = this.layout[i];
    const W = this.canvas.clientWidth;
    const cx = (l.x0 + l.x1) / 2;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(W - tw, Math.max(0, cx - tw / 2))}px`;
  }
}
