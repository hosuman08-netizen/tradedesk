/* chart.js — self-contained canvas candlestick + depth renderer for TradeForge.
 *
 * No external chart library: everything ships in-app so the terminal works
 * offline and inside restrictive webviews. Implements the layout that TradingView,
 * Kraken and Binance all converge on — OHLC candles over a volume histogram,
 * right-hand price scale, bottom time scale, crosshair with an OHLC readout —
 * plus price lines for your average entry and your resting orders.
 */
(function (global) {
  'use strict';

  const UP = '#2ebd85', DOWN = '#e5544b';
  const GRID = '#1b1712', AXIS = '#8b6f47', TEXT = '#f5f1e6', GOLD = '#c5a46e';
  const FONT = '10px ui-monospace, SFMono-Regular, Menlo, monospace';

  function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const step = n >= 5 ? 5 : n >= 2 ? 2 : 1;
    return step * mag;
  }

  function Chart(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bars = [];
    this.lines = [];
    this.decimals = 2;
    this.tf = '1m';
    this.view = 90;         // visible bar count
    this.offset = 0;        // bars scrolled back from the right edge
    this.cross = null;
    this.padRight = 58;
    this.padBottom = 20;
    this.onHover = null;
    this._bind();
  }

  Chart.prototype._bind = function () {
    const self = this;
    const c = this.canvas;

    c.addEventListener('wheel', function (e) {
      e.preventDefault();
      const prev = self.view;
      self.view = Math.max(24, Math.min(400, Math.round(self.view * (e.deltaY > 0 ? 1.12 : 0.89))));
      // keep the right edge anchored unless the user has panned away
      if (self.offset > 0) self.offset = Math.max(0, self.offset + (self.view - prev) / 2 | 0);
      self.clampOffset();
      self.render();
    }, { passive: false });

    let dragging = false, lastX = 0, moved = 0;
    function down(x) { dragging = true; lastX = x; moved = 0; c.style.cursor = 'grabbing'; }
    function move(x, y, inside) {
      if (dragging) {
        const w = self.plotW();
        const bw = w / self.view;
        const dx = x - lastX;
        if (Math.abs(dx) >= bw) {
          const steps = Math.trunc(dx / bw);
          self.offset += steps;
          lastX += steps * bw;
          moved += Math.abs(steps);
          self.clampOffset();
          self.render();
        }
        return;
      }
      if (inside) { self.cross = { x: x, y: y }; self.render(); }
    }
    function up() { dragging = false; c.style.cursor = 'crosshair'; }

    c.addEventListener('mousedown', function (e) { down(e.offsetX); });
    c.addEventListener('mousemove', function (e) { move(e.offsetX, e.offsetY, true); });
    c.addEventListener('mouseleave', function () { dragging = false; self.cross = null; self.render(); if (self.onHover) self.onHover(null); });
    global.addEventListener('mouseup', up);

    c.addEventListener('touchstart', function (e) {
      const r = c.getBoundingClientRect(), t = e.touches[0];
      down(t.clientX - r.left);
      self.cross = { x: t.clientX - r.left, y: t.clientY - r.top };
      self.render();
    }, { passive: true });
    c.addEventListener('touchmove', function (e) {
      const r = c.getBoundingClientRect(), t = e.touches[0];
      move(t.clientX - r.left, t.clientY - r.top, false);
    }, { passive: true });
    c.addEventListener('touchend', function () { up(); self.cross = null; self.render(); if (self.onHover) self.onHover(null); }, { passive: true });
  };

  Chart.prototype.clampOffset = function () {
    this.offset = Math.max(0, Math.min(Math.max(0, this.bars.length - this.view), this.offset));
  };

  Chart.prototype.plotW = function () { return this.canvas.clientWidth - this.padRight; };

  Chart.prototype.setData = function (bars, opts) {
    opts = opts || {};
    const atEdge = this.offset === 0;
    this.bars = bars || [];
    if (opts.decimals != null) this.decimals = opts.decimals;
    if (opts.tf) this.tf = opts.tf;
    this.lines = opts.lines || [];
    if (atEdge) this.offset = 0;
    this.clampOffset();
    this.render();
  };

  Chart.prototype.visible = function () {
    const end = this.bars.length - this.offset;
    return this.bars.slice(Math.max(0, end - this.view), Math.max(0, end));
  };

  Chart.prototype.render = function () {
    const c = this.canvas, ctx = this.ctx;
    const cssW = c.clientWidth || 640, cssH = c.clientHeight || 360;
    const dpr = global.devicePixelRatio || 1;
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const bars = this.visible();
    if (!bars.length) {
      ctx.fillStyle = AXIS; ctx.font = FONT; ctx.textAlign = 'center';
      ctx.fillText('no data', cssW / 2, cssH / 2);
      return;
    }

    const W = cssW - this.padRight;
    const H = cssH - this.padBottom;
    const volH = Math.round(H * 0.20);
    const priceH = H - volH - 6;

    let hi = -Infinity, lo = Infinity, maxV = 0;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].h > hi) hi = bars[i].h;
      if (bars[i].l < lo) lo = bars[i].l;
      if (bars[i].v > maxV) maxV = bars[i].v;
    }
    // Include overlay price lines in the scale so they never sit off-screen.
    this.lines.forEach(function (l) {
      if (!Number.isFinite(l.price)) return;
      if (l.price > hi) hi = l.price;
      if (l.price < lo) lo = l.price;
    });
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1;
    hi += pad; lo -= pad;
    const span = hi - lo || 1;

    const bw = W / bars.length;
    const body = Math.max(1, Math.min(14, bw * 0.68));
    const y = p => priceH - ((p - lo) / span) * priceH;
    const x = i => i * bw + bw / 2;

    // ── grid + price scale ────────────────────────────────────────────────
    const step = niceStep(span, Math.max(3, Math.round(priceH / 46)));
    ctx.font = FONT; ctx.textBaseline = 'middle';
    for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
      const py = y(p);
      ctx.strokeStyle = GRID; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, Math.round(py) + 0.5); ctx.lineTo(W, Math.round(py) + 0.5); ctx.stroke();
      ctx.fillStyle = AXIS; ctx.textAlign = 'left';
      ctx.fillText(p.toFixed(this.decimals), W + 6, py);
    }

    // ── time scale ────────────────────────────────────────────────────────
    const self = this;
    const labelEvery = Math.max(1, Math.ceil(bars.length / Math.max(2, Math.floor(W / 74))));
    ctx.textAlign = 'center'; ctx.fillStyle = AXIS;
    for (let i = 0; i < bars.length; i += labelEvery) {
      const px = x(i);
      if (px > W - 20) continue;
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, 0); ctx.lineTo(Math.round(px) + 0.5, H); ctx.stroke();
      // Skip labels that would be clipped by the left edge.
      if (px < 22) continue;
      ctx.fillStyle = AXIS;
      ctx.fillText(self.timeLabel(bars[i].t), px, H + 10);
    }

    // ── volume histogram ──────────────────────────────────────────────────
    const volTop = priceH + 6;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const h = maxV ? (b.v / maxV) * volH : 0;
      ctx.fillStyle = b.c >= b.o ? 'rgba(46,189,133,0.34)' : 'rgba(229,84,75,0.34)';
      ctx.fillRect(x(i) - body / 2, volTop + volH - h, body, h);
    }

    // ── candles ───────────────────────────────────────────────────────────
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const up = b.c >= b.o;
      const col = up ? UP : DOWN;
      const cx = x(i);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, y(b.h));
      ctx.lineTo(Math.round(cx) + 0.5, y(b.l));
      ctx.stroke();
      const yo = y(b.o), yc = y(b.c);
      const top = Math.min(yo, yc);
      const hgt = Math.max(1, Math.abs(yc - yo));
      ctx.fillStyle = col;
      ctx.fillRect(cx - body / 2, top, body, hgt);
    }

    // ── overlay price lines (avg entry, resting orders) ───────────────────
    this.lines.forEach(function (l) {
      if (!Number.isFinite(l.price)) return;
      const py = y(l.price);
      if (py < 0 || py > priceH) return;
      ctx.save();
      ctx.strokeStyle = l.color || GOLD;
      ctx.setLineDash(l.dash || [4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, Math.round(py) + 0.5); ctx.lineTo(W, Math.round(py) + 0.5); ctx.stroke();
      ctx.restore();
      if (l.label) {
        ctx.font = FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const w = ctx.measureText(l.label).width + 8;
        ctx.fillStyle = l.color || GOLD;
        ctx.globalAlpha = 0.18; ctx.fillRect(2, py - 7, w, 14); ctx.globalAlpha = 1;
        ctx.fillStyle = l.color || GOLD;
        ctx.fillText(l.label, 6, py);
      }
    });

    // ── last price marker ─────────────────────────────────────────────────
    const last = bars[bars.length - 1];
    const lastY = y(last.c);
    const lastCol = last.c >= last.o ? UP : DOWN;
    ctx.save();
    ctx.strokeStyle = lastCol; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, Math.round(lastY) + 0.5); ctx.lineTo(W, Math.round(lastY) + 0.5); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = lastCol;
    ctx.fillRect(W + 1, lastY - 8, this.padRight - 1, 16);
    ctx.fillStyle = '#0a0806'; ctx.font = '600 ' + FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(last.c.toFixed(this.decimals), W + 5, lastY);

    // ── crosshair ─────────────────────────────────────────────────────────
    if (this.cross && this.cross.x < W) {
      const i = Math.max(0, Math.min(bars.length - 1, Math.floor(this.cross.x / bw)));
      const cx = x(i), cy = this.cross.y;
      ctx.save();
      ctx.strokeStyle = 'rgba(197,164,110,0.5)'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(cx) + 0.5, 0); ctx.lineTo(Math.round(cx) + 0.5, H); ctx.stroke();
      if (cy < priceH) {
        ctx.beginPath(); ctx.moveTo(0, Math.round(cy) + 0.5); ctx.lineTo(W, Math.round(cy) + 0.5); ctx.stroke();
      }
      ctx.restore();
      if (cy < priceH) {
        const pv = lo + (1 - cy / priceH) * span;
        ctx.fillStyle = '#241d15';
        ctx.fillRect(W + 1, cy - 8, this.padRight - 1, 16);
        ctx.fillStyle = TEXT; ctx.font = FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(pv.toFixed(this.decimals), W + 5, cy);
      }
      if (this.onHover) this.onHover(bars[i]);
    }
  };

  Chart.prototype.timeLabel = function (t) {
    const d = new Date(t);
    const p = n => String(n).padStart(2, '0');
    if (this.tf === '1D') return (d.getMonth() + 1) + '/' + d.getDate();
    if (this.tf === '4h' || this.tf === '1h') return p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + 'h';
    return p(d.getHours()) + ':' + p(d.getMinutes());
  };

  /* Depth chart: cumulative resting size by price. Bids climb right-to-left in
   * green, asks climb left-to-right in red — the standard reading. */
  function Depth(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  Depth.prototype.render = function (book, decimals) {
    const c = this.canvas, ctx = this.ctx;
    const cssW = c.clientWidth || 300, cssH = c.clientHeight || 110;
    const dpr = global.devicePixelRatio || 1;
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!book || !book.bids.length) return;

    const H = cssH - 12;
    const half = cssW / 2;
    const maxCum = book.maxCum || 1;
    const bids = book.bids, asks = book.asks;
    const loP = bids[bids.length - 1].price, hiP = asks[asks.length - 1].price;
    const spanP = (hiP - loP) || 1;
    const xOf = p => ((p - loP) / spanP) * cssW;
    const yOf = cum => H - (cum / maxCum) * H;

    function area(levels, color, fill) {
      ctx.beginPath();
      ctx.moveTo(xOf(levels[0].price), H);
      for (let i = 0; i < levels.length; i++) {
        // step profile — cumulative size is constant between levels
        ctx.lineTo(xOf(levels[i].price), yOf(i ? levels[i - 1].cum : levels[i].cum));
        ctx.lineTo(xOf(levels[i].price), yOf(levels[i].cum));
      }
      const lastX = xOf(levels[levels.length - 1].price);
      ctx.lineTo(lastX, H);
      ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    area(bids, UP, 'rgba(46,189,133,0.16)');
    area(asks, DOWN, 'rgba(229,84,75,0.16)');

    ctx.strokeStyle = 'rgba(197,164,110,0.45)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(half, 0); ctx.lineTo(half, H); ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = FONT; ctx.fillStyle = AXIS; ctx.textBaseline = 'top';
    ctx.textAlign = 'left'; ctx.fillText(loP.toFixed(decimals), 2, H + 2);
    ctx.textAlign = 'center'; ctx.fillStyle = GOLD; ctx.fillText(book.mid.toFixed(decimals), half, H + 2);
    ctx.textAlign = 'right'; ctx.fillStyle = AXIS; ctx.fillText(hiP.toFixed(decimals), cssW - 2, H + 2);
  };

  /* Sparkline for the market list — a compact 24h shape, coloured by direction. */
  function sparkline(canvas, values, up) {
    const ctx = canvas.getContext('2d');
    const cssW = canvas.clientWidth || 60, cssH = canvas.clientHeight || 22;
    const dpr = global.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!values || values.length < 2) return;
    let hi = -Infinity, lo = Infinity;
    for (let i = 0; i < values.length; i++) { if (values[i] > hi) hi = values[i]; if (values[i] < lo) lo = values[i]; }
    const span = (hi - lo) || 1;
    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
      const x = (i / (values.length - 1)) * cssW;
      const y = cssH - 2 - ((values[i] - lo) / span) * (cssH - 4);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.strokeStyle = up ? UP : DOWN;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  global.TFChart = { Chart: Chart, Depth: Depth, sparkline: sparkline, UP: UP, DOWN: DOWN };

})(typeof window !== 'undefined' ? window : globalThis);
