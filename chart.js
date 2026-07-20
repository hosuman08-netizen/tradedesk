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

  // ── indicator math ─────────────────────────────────────────────────────────
  // Every series is index-aligned to the input array and NaN-filled until it has
  // enough lookback to be defined — so a value is only drawn where it is real.
  // These are the textbook definitions (Wilder RSI, standard EMA/MACD, session
  // VWAP), not decorative approximations: the numbers match what a real terminal
  // would print for the same OHLCV.

  function sma(vals, n) {
    const out = new Array(vals.length).fill(NaN);
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (i >= n) sum -= vals[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  // EMA that tolerates a NaN prefix (so it can smooth a MACD line that only
  // becomes defined partway through). Seeded with the SMA of the first n samples.
  function emaSeries(vals, n) {
    const out = new Array(vals.length).fill(NaN);
    const k = 2 / (n + 1);
    let prev = 0, count = 0, sum = 0;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (!Number.isFinite(v)) continue;
      count++;
      if (count < n) { sum += v; continue; }
      if (count === n) { sum += v; prev = sum / n; out[i] = prev; continue; }
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function bollinger(closes, n, k) {
    const mid = sma(closes, n);
    const upper = new Array(closes.length).fill(NaN);
    const lower = new Array(closes.length).fill(NaN);
    for (let i = n - 1; i < closes.length; i++) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) { const dd = closes[j] - mid[i]; s += dd * dd; }
      const sd = Math.sqrt(s / n);
      upper[i] = mid[i] + k * sd;
      lower[i] = mid[i] - k * sd;
    }
    return { mid: mid, upper: upper, lower: lower };
  }

  // Session VWAP: cumulative typical-price × volume, anchored at each local day
  // boundary — the standard intraday anchoring, deterministic per bar.
  function vwap(bars) {
    const out = new Array(bars.length).fill(NaN);
    let cumPV = 0, cumV = 0, day = null;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i], dt = new Date(b.t);
      const key = dt.getFullYear() + '-' + dt.getMonth() + '-' + dt.getDate();
      if (key !== day) { day = key; cumPV = 0; cumV = 0; }
      const tp = (b.h + b.l + b.c) / 3;
      cumPV += tp * b.v; cumV += b.v;
      out[i] = cumV > 0 ? cumPV / cumV : b.c;
    }
    return out;
  }

  // Wilder's RSI — the smoothing every charting package uses, not a plain SMA of
  // gains, so it agrees with TradingView/Binance to the decimal.
  function rsi(closes, n) {
    const out = new Array(closes.length).fill(NaN);
    let avgG = 0, avgL = 0;
    for (let i = 1; i < closes.length; i++) {
      const ch = closes[i] - closes[i - 1];
      const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
      if (i <= n) {
        avgG += g; avgL += l;
        if (i === n) { avgG /= n; avgL /= n; out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL); }
      } else {
        avgG = (avgG * (n - 1) + g) / n;
        avgL = (avgL * (n - 1) + l) / n;
        out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
      }
    }
    return out;
  }

  function macd(closes, fast, slow, signal) {
    const ef = emaSeries(closes, fast), es = emaSeries(closes, slow);
    const line = closes.map(function (_, i) {
      return (Number.isFinite(ef[i]) && Number.isFinite(es[i])) ? ef[i] - es[i] : NaN;
    });
    const sig = emaSeries(line, signal);
    const hist = line.map(function (v, i) {
      return (Number.isFinite(v) && Number.isFinite(sig[i])) ? v - sig[i] : NaN;
    });
    return { line: line, signal: sig, hist: hist };
  }

  // Indicator identity colours. Each is always paired with a text label in the
  // legend, so meaning never rides on hue alone.
  const IND = {
    ema7: '#e6b45e', ema25: '#5b9bd5', ema99: '#b07cc6',
    ma: '#d98a4b', boll: '#9a7b4f', vwap: '#3fb5a0',
    rsi: '#e6b45e', macdLine: '#5b9bd5', macdSignal: '#e6b45e'
  };

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
    this.overlays = [];     // price-pane indicators: ema / ma / boll / vwap
    this.osc = null;        // one lower-pane oscillator: rsi / macd
    this._bind();
  }

  // cfg = { overlays:[{kind,period,k}], osc:{kind,period|fast,slow,signal} | null }
  Chart.prototype.setIndicators = function (cfg) {
    this.overlays = (cfg && cfg.overlays) || [];
    this.osc = (cfg && cfg.osc) || null;
    this.render();
  };

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
    // Reserve a lower pane when an oscillator (RSI/MACD) is active. The price +
    // volume region shrinks to make room; nothing overlaps.
    const oscH = this.osc ? Math.max(64, Math.round(H * 0.22)) : 0;
    const oscGap = this.osc ? 10 : 0;
    const mainH = H - oscH - oscGap;
    const oscTop = mainH + oscGap;
    const volH = Math.round(mainH * 0.20);
    const priceH = mainH - volH - 6;

    // Global indices of the visible window, so index-aligned indicator series
    // (computed over the full history for correct lookback) line up with bars.
    const gEnd = this.bars.length - this.offset;
    const gStart = Math.max(0, gEnd - this.view);
    const closes = this.bars.map(function (b) { return b.c; });
    const self = this;

    // Build the visible portion of each overlay series once.
    const ovSeries = this.overlays.map(function (ov) {
      if (ov.kind === 'ema') return { ov: ov, type: 'line', color: ov.color || IND['ema' + ov.period] || GOLD, data: emaSeries(closes, ov.period), label: 'EMA ' + ov.period };
      if (ov.kind === 'ma') return { ov: ov, type: 'line', color: ov.color || IND.ma, data: sma(closes, ov.period), label: 'MA ' + ov.period };
      if (ov.kind === 'vwap') return { ov: ov, type: 'line', color: ov.color || IND.vwap, data: vwap(self.bars), label: 'VWAP' };
      if (ov.kind === 'boll') { const b = bollinger(closes, ov.period, ov.k); return { ov: ov, type: 'band', color: ov.color || IND.boll, data: b, label: 'BOLL ' + ov.period }; }
      return { type: 'none', data: [] };
    });

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
    // Bollinger bands / VWAP can sit outside the candle range — grow the scale so
    // an active overlay is never clipped at the pane edge.
    ovSeries.forEach(function (s) {
      for (let i = 0; i < bars.length; i++) {
        const g = gStart + i;
        if (s.type === 'line') { const v = s.data[g]; if (Number.isFinite(v)) { if (v > hi) hi = v; if (v < lo) lo = v; } }
        else if (s.type === 'band') { const u = s.data.upper[g], d2 = s.data.lower[g]; if (Number.isFinite(u) && u > hi) hi = u; if (Number.isFinite(d2) && d2 < lo) lo = d2; }
      }
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
    const labelEvery = Math.max(1, Math.ceil(bars.length / Math.max(2, Math.floor(W / 74))));
    ctx.textAlign = 'center'; ctx.fillStyle = AXIS;
    for (let i = 0; i < bars.length; i += labelEvery) {
      const px = x(i);
      if (px > W - 20) continue;
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, 0); ctx.lineTo(Math.round(px) + 0.5, mainH); ctx.stroke();
      if (oscH) { ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, oscTop); ctx.lineTo(Math.round(px) + 0.5, H); ctx.stroke(); }
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

    // ── indicator overlays (EMA / MA / Bollinger / VWAP) ──────────────────
    // Clipped to the price pane so no line bleeds into the volume or osc pane.
    function drawLine(data, color, dash) {
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = 1.4;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < bars.length; i++) {
        const v = data[gStart + i];
        if (!Number.isFinite(v)) { started = false; continue; }
        const px = x(i), py = y(v);
        if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; }
      }
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, priceH); ctx.clip();
    ovSeries.forEach(function (s) {
      if (s.type === 'line') drawLine(s.data, s.color);
      else if (s.type === 'band') {
        // Faint fill between the bands, then the three lines.
        ctx.save();
        ctx.fillStyle = 'rgba(154,123,79,0.10)';
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < bars.length; i++) { const u = s.data.upper[gStart + i]; if (!Number.isFinite(u)) { continue; } const px = x(i), py = y(u); if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; } }
        for (let i = bars.length - 1; i >= 0; i--) { const d2 = s.data.lower[gStart + i]; if (!Number.isFinite(d2)) continue; ctx.lineTo(x(i), y(d2)); }
        ctx.closePath(); ctx.fill();
        ctx.restore();
        drawLine(s.data.upper, s.color);
        drawLine(s.data.lower, s.color);
        drawLine(s.data.mid, s.color, [2, 3]);
      }
    });
    ctx.restore();

    // ── indicator legend (top-left) — values at the hovered or latest bar ──
    if (ovSeries.length) {
      const legIdx = (this.cross && this.cross.x < W)
        ? gStart + Math.max(0, Math.min(bars.length - 1, Math.floor(this.cross.x / bw)))
        : gEnd - 1;
      ctx.font = FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      let ly = 10;
      ovSeries.forEach(function (s) {
        let txt;
        if (s.type === 'band') {
          const u = s.data.upper[legIdx], m = s.data.mid[legIdx], d2 = s.data.lower[legIdx];
          if (!Number.isFinite(m)) return;
          txt = s.label + '  ' + d2.toFixed(self.decimals) + ' · ' + m.toFixed(self.decimals) + ' · ' + u.toFixed(self.decimals);
        } else {
          const v = s.data[legIdx];
          if (!Number.isFinite(v)) return;
          txt = s.label + '  ' + v.toFixed(self.decimals);
        }
        ctx.fillStyle = s.color;
        ctx.fillRect(4, ly - 1, 8, 2);
        ctx.fillText(txt, 16, ly);
        ly += 13;
      });
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

    // ── lower oscillator pane (RSI or MACD) ───────────────────────────────
    if (this.osc) {
      const oscIdx = (this.cross && this.cross.x < W)
        ? gStart + Math.max(0, Math.min(bars.length - 1, Math.floor(this.cross.x / bw)))
        : gEnd - 1;
      ctx.save();
      // top divider
      ctx.strokeStyle = GRID; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, oscTop + 0.5); ctx.lineTo(W, oscTop + 0.5); ctx.stroke();
      ctx.font = FONT; ctx.textBaseline = 'middle';

      if (this.osc.kind === 'rsi') {
        const r = rsi(closes, this.osc.period);
        const yv = v => oscTop + (1 - v / 100) * oscH;
        // 30/70 guide band + midline
        ctx.fillStyle = 'rgba(197,164,110,0.06)';
        ctx.fillRect(0, yv(70), W, yv(30) - yv(70));
        [30, 50, 70].forEach(function (g) {
          ctx.strokeStyle = g === 50 ? GRID : 'rgba(139,111,71,0.35)';
          ctx.setLineDash(g === 50 ? [] : [3, 3]);
          ctx.beginPath(); ctx.moveTo(0, Math.round(yv(g)) + 0.5); ctx.lineTo(W, Math.round(yv(g)) + 0.5); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = AXIS; ctx.textAlign = 'left'; ctx.fillText(String(g), W + 6, yv(g));
        });
        ctx.strokeStyle = IND.rsi; ctx.lineWidth = 1.4; ctx.beginPath();
        let started = false;
        for (let i = 0; i < bars.length; i++) { const v = r[gStart + i]; if (!Number.isFinite(v)) { started = false; continue; } const px = x(i), py = yv(v); if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; } }
        ctx.stroke();
        const rv = r[oscIdx];
        ctx.fillStyle = IND.rsi; ctx.textAlign = 'left';
        ctx.fillText('RSI ' + this.osc.period + '  ' + (Number.isFinite(rv) ? rv.toFixed(1) : '—'), 6, oscTop + 9);
      } else if (this.osc.kind === 'macd') {
        const m = macd(closes, this.osc.fast, this.osc.slow, this.osc.signal);
        let mMax = 0;
        for (let i = 0; i < bars.length; i++) {
          const g = gStart + i;
          [m.line[g], m.signal[g], m.hist[g]].forEach(function (v) { if (Number.isFinite(v)) mMax = Math.max(mMax, Math.abs(v)); });
        }
        mMax = mMax || 1;
        const midY = oscTop + oscH / 2;
        const yv = v => midY - (v / mMax) * (oscH / 2 - 4);
        // zero line
        ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(0, Math.round(midY) + 0.5); ctx.lineTo(W, Math.round(midY) + 0.5); ctx.stroke();
        // histogram
        for (let i = 0; i < bars.length; i++) {
          const v = m.hist[gStart + i]; if (!Number.isFinite(v)) continue;
          const px = x(i), py = yv(v);
          ctx.fillStyle = v >= 0 ? 'rgba(46,189,133,0.55)' : 'rgba(229,84,75,0.55)';
          ctx.fillRect(px - body / 2, Math.min(py, midY), Math.max(1, body), Math.abs(py - midY));
        }
        function oscLine(data, color) {
          ctx.strokeStyle = color; ctx.lineWidth = 1.3; ctx.beginPath();
          let started = false;
          for (let i = 0; i < bars.length; i++) { const v = data[gStart + i]; if (!Number.isFinite(v)) { started = false; continue; } const px = x(i), py = yv(v); if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; } }
          ctx.stroke();
        }
        oscLine(m.line, IND.macdLine);
        oscLine(m.signal, IND.macdSignal);
        const lv = m.line[oscIdx], sv = m.signal[oscIdx], hv = m.hist[oscIdx];
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillStyle = AXIS; ctx.fillText('MACD ' + this.osc.fast + ' ' + this.osc.slow + ' ' + this.osc.signal, 6, oscTop + 9);
        ctx.fillStyle = IND.macdLine; ctx.fillText(Number.isFinite(lv) ? lv.toFixed(this.decimals) : '—', 120, oscTop + 9);
        ctx.fillStyle = IND.macdSignal; ctx.fillText(Number.isFinite(sv) ? sv.toFixed(this.decimals) : '—', 176, oscTop + 9);
        ctx.fillStyle = (hv >= 0 ? UP : DOWN); ctx.fillText(Number.isFinite(hv) ? (hv >= 0 ? '+' : '') + hv.toFixed(this.decimals) : '—', 232, oscTop + 9);
      }
      ctx.restore();
    }

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
