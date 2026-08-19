/* terminal.js — TradeForge Terminal UI.
 *
 * Wires the deterministic market engine to an exchange-standard layout:
 * market list · candles + volume · order book with cumulative depth · depth chart ·
 * trade tape with buy pressure · order ticket · and the four-way blotter that every
 * real venue separates (Open Orders / Positions / Trades / Order History).
 *
 * FICTIONAL SIMULATION. Invented in-app units, no real tickers, no fiat, no money.
 */
(function (global) {
  'use strict';

  const M = global.MarketEngine;
  const C = global.TFChart;
  if (!M || !C) return;

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const T = {
    symbol: 'TFC',
    tf: '15m',
    group: 1,
    side: 'buy',
    type: 'limit',
    blotter: 'open',
    chart: null,
    depth: null,
    priceTouched: false,   // has the user typed their own limit price?
    lastPrices: {},
    seenFills: 0,
    ind: { ema7: true, ema25: true, ema99: false, ma25: false, boll: false, vwap: false, osc: 'none' },
    replay: { on: false, idx: 0, speed: 0, timer: null }
  };

  function d(sym) { return M.decimals(M.symbolById(sym)); }
  function fmt(v, n) { return M.fmt(v, n); }

  // Compact volume/qty formatting — full precision would drown the tables.
  function compact(v) {
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v.toFixed(a < 10 ? 2 : 0);
  }

  function signed(v, n) { return (v > 0 ? '+' : '') + fmt(v, n); }
  // Direction is never colour-only: an arrow carries the same meaning for
  // colour-blind users (WCAG — do not encode information in hue alone).
  function arrow(v) { return v > 0 ? '▲' : v < 0 ? '▼' : '·'; }
  function cls(v) { return v > 0 ? 'up' : v < 0 ? 'down' : 'flat'; }

  // ───────────────────────────── ticker + header ──────────────────────────────

  function renderTicker() {
    const t = M.ticker(T.symbol);
    const dec = t.decimals;
    setFlash('tk-price', fmt(t.price, dec));
    const ch = $('tk-change');
    if (ch) {
      ch.className = 'tk-change ' + cls(t.changePct);
      ch.textContent = arrow(t.changePct) + ' ' + signed(t.change, dec) + ' (' + signed(t.changePct, 2) + '%)';
    }
    setText('tk-high', fmt(t.high, dec));
    setText('tk-low', fmt(t.low, dec));
    setText('tk-vol', compact(t.volume) + ' ' + t.symbol);
    setText('tk-sym', t.symbol + '/' + M.QUOTE);
    setText('tk-name', t.name);
    const dt = document.title;
    const want = fmt(t.price, dec) + ' ' + t.symbol + ' · TradeForge';
    if (dt !== want) document.title = want;
  }

  function setText(id, v) { const el = $(id); if (el && el.textContent !== v) el.textContent = v; }

  // Price flash: green/red pulse on change — motion as a state signal, not decoration.
  function setFlash(id, v) {
    const el = $(id);
    if (!el) return;
    const prev = el.textContent;
    if (prev === v) return;
    const up = parseFloat(v.replace(/,/g, '')) >= parseFloat(String(prev).replace(/,/g, ''));
    el.textContent = v;
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth;
    el.classList.add(up ? 'flash-up' : 'flash-down');
  }

  // ─────────────────────────────── market list ────────────────────────────────

  function favs() {
    try { return JSON.parse(localStorage.getItem('tf2_favs') || '[]'); } catch (e) { return []; }
  }
  function toggleFav(id) {
    const f = favs();
    const i = f.indexOf(id);
    if (i >= 0) f.splice(i, 1); else f.push(id);
    localStorage.setItem('tf2_favs', JSON.stringify(f));
    renderMarkets(true);
  }
  global.tfToggleFav = function (e, id) { e.stopPropagation(); toggleFav(id); };

  function renderMarkets(rebuild) {
    const list = $('mk-list');
    if (!list) return;
    const f = favs();
    const rows = M.SYMBOLS.map(function (s) { return M.ticker(s.id); });
    // Stable order: favourites first, then the fixed listing order. Re-sorting by
    // a live field would make rows jump under the cursor on every tick.
    rows.sort(function (a, b) {
      const fa = f.indexOf(a.symbol) >= 0 ? 0 : 1, fb = f.indexOf(b.symbol) >= 0 ? 0 : 1;
      return fa - fb;
    });

    if (rebuild || list.children.length !== rows.length) {
      list.innerHTML = rows.map(function (r) {
        return '<div class="mk-row' + (r.symbol === T.symbol ? ' sel' : '') + '" data-sym="' + r.symbol + '" onclick="tfSelect(\'' + r.symbol + '\')">'
          + '<span class="mk-fav' + (f.indexOf(r.symbol) >= 0 ? ' on' : '') + '" onclick="tfToggleFav(event,\'' + r.symbol + '\')">★</span>'
          + '<span class="mk-id"><b>' + r.symbol + '</b><em>' + esc(r.name) + '</em></span>'
          + '<canvas class="mk-spark" width="54" height="20"></canvas>'
          + '<span class="mk-px" data-f="px"></span>'
          + '<span class="mk-ch" data-f="ch"></span>'
          + '</div>';
      }).join('');
    }

    // Update each row by symbol, never by index — the DOM order and the data
    // order must not be assumed to agree, or prices land on the wrong market.
    rows.forEach(function (r) {
      const el = list.querySelector('[data-sym="' + r.symbol + '"]');
      if (!el) return;
      el.classList.toggle('sel', r.symbol === T.symbol);
      const px = el.querySelector('[data-f="px"]');
      const ch = el.querySelector('[data-f="ch"]');
      if (px) {
        const v = fmt(r.price, r.decimals);
        if (px.textContent !== v) {
          const prev = parseFloat(px.textContent.replace(/,/g, ''));
          px.textContent = v;
          px.classList.remove('flash-up', 'flash-down');
          void px.offsetWidth;
          px.classList.add(r.price >= prev ? 'flash-up' : 'flash-down');
        }
      }
      if (ch) {
        ch.className = 'mk-ch ' + cls(r.changePct);
        ch.textContent = arrow(r.changePct) + signed(r.changePct, 2) + '%';
      }
      const spark = el.querySelector('canvas');
      if (spark && (rebuild || sparkTick % 10 === 0)) {
        const bars = M.candles(r.symbol, '15m', 48);
        C.sparkline(spark, bars.map(function (b) { return b.c; }), r.changePct >= 0);
      }
    });
    sparkTick++;
  }
  let sparkTick = 0;

  global.tfSelect = function (sym) {
    if (T.symbol === sym) return;
    T.symbol = sym;
    T.priceTouched = false;
    localStorage.setItem('tf2_symbol', sym);
    tfReplayLive();
    renderMarkets(true);
    renderTicker();
    syncOrderForm(true);
    renderChart(true);
    renderBook();
    renderTape();
    renderNews();
    renderBlotter();
  };

  // ──────────────────────────────── chart ─────────────────────────────────────

  function chartLines() {
    const lines = [];
    const p = M.position(T.symbol);
    if (p.qty) lines.push({ price: p.avgEntry, color: '#c5a46e', label: 'avg ' + fmt(p.avgEntry, d(T.symbol)) });
    M.account.orders.forEach(function (o) {
      if (o.status !== 'open' || o.symbol !== T.symbol) return;
      const px = Number.isFinite(o.limitPrice) ? o.limitPrice : o.stopPrice;
      if (!Number.isFinite(px)) return;
      lines.push({
        price: px,
        color: o.side === 'buy' ? C.UP : C.DOWN,
        dash: [2, 4],
        label: o.side === 'buy' ? 'buy ' + compact(o.remaining) : 'sell ' + compact(o.remaining)
      });
    });
    return lines;
  }

  function candleSeries() {
    return M.candles(T.symbol, T.tf, 400);
  }

  function replaySlice() {
    const all = candleSeries();
    if (!T.replay.on) return all;
    const n = Math.max(24, Math.min(all.length, T.replay.idx || all.length));
    return all.slice(0, n);
  }

  function stopReplayTimer() {
    if (T.replay.timer) { clearInterval(T.replay.timer); T.replay.timer = null; }
  }

  function replayStamp() {
    if (!T.replay.on) return 'live sim';
    const bars = replaySlice();
    const b = bars[bars.length - 1];
    if (!b) return 'replay';
    const dt = new Date(b.t);
    return dt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }

  function syncReplayUi() {
    const all = candleSeries();
    const scrub = $('rp-scrub');
    if (scrub) {
      scrub.max = String(Math.max(24, all.length));
      const idx = T.replay.on ? Math.max(24, Math.min(all.length, T.replay.idx || all.length)) : all.length;
      if (document.activeElement !== scrub) scrub.value = String(idx);
    }
    const live = $('rp-live'), x1 = $('rp-1x'), x4 = $('rp-4x'), st = $('rp-stamp');
    if (live) live.classList.toggle('on', !T.replay.on);
    if (x1) x1.classList.toggle('on', T.replay.on && T.replay.speed === 1);
    if (x4) x4.classList.toggle('on', T.replay.on && T.replay.speed === 4);
    if (st) st.textContent = replayStamp();
  }

  function renderChart(reset) {
    if (!T.chart) return;
    if (reset) T.chart.offset = 0;
    T.chart.setData(replaySlice(), {
      decimals: d(T.symbol), tf: T.tf, lines: T.replay.on ? [] : chartLines()
    });
    syncReplayUi();
  }

  global.tfReplayLive = function () {
    stopReplayTimer();
    T.replay.on = false;
    T.replay.speed = 0;
    T.replay.idx = 0;
    renderChart(true);
  };

  global.tfReplayScrub = function (v) {
    const all = candleSeries();
    stopReplayTimer();
    T.replay.on = true;
    T.replay.speed = 0;
    T.replay.idx = Math.max(24, Math.min(all.length, Number(v) || all.length));
    renderChart(false);
  };

  global.tfReplaySpeed = function (spd) {
    const all = candleSeries();
    stopReplayTimer();
    T.replay.on = true;
    T.replay.speed = spd === 4 ? 4 : 1;
    if (!T.replay.idx || T.replay.idx >= all.length) T.replay.idx = 24;
    const step = function () {
      const series = candleSeries();
      T.replay.idx = (T.replay.idx || 24) + 1;
      if (T.replay.idx >= series.length) {
        tfReplayLive();
        return;
      }
      renderChart(false);
    };
    T.replay.timer = setInterval(step, T.replay.speed === 4 ? 100 : 400);
    renderChart(false);
  };

  global.tfSetTf = function (tf) {
    T.tf = tf;
    localStorage.setItem('tf2_tf', tf);
    tfReplayLive();
    Array.prototype.forEach.call(document.querySelectorAll('#tf-bar button'), function (b) {
      b.classList.toggle('on', b.dataset.tf === tf);
    });
    renderChart(true);
  };

  // ── technical indicators ─────────────────────────────────────────────────
  // Config is pure UI state; the chart computes every series deterministically
  // from the same OHLCV bars it draws, so displayed values match the candles.

  function loadInd() {
    try {
      const saved = JSON.parse(localStorage.getItem('tf2_ind') || '{}');
      Object.keys(T.ind).forEach(function (k) { if (saved[k] != null) T.ind[k] = saved[k]; });
    } catch (e) { /* keep defaults */ }
  }

  function applyIndicators() {
    if (!T.chart) return;
    const ov = [];
    if (T.ind.ema7) ov.push({ kind: 'ema', period: 7 });
    if (T.ind.ema25) ov.push({ kind: 'ema', period: 25 });
    if (T.ind.ema99) ov.push({ kind: 'ema', period: 99 });
    if (T.ind.ma25) ov.push({ kind: 'ma', period: 25 });
    if (T.ind.boll) ov.push({ kind: 'boll', period: 20, k: 2 });
    if (T.ind.vwap) ov.push({ kind: 'vwap' });
    let osc = null;
    if (T.ind.osc === 'rsi') osc = { kind: 'rsi', period: 14 };
    else if (T.ind.osc === 'macd') osc = { kind: 'macd', fast: 12, slow: 26, signal: 9 };
    T.chart.setIndicators({ overlays: ov, osc: osc });
    // Reflect the active count on the button so state is visible when closed.
    const btn = $('ind-btn');
    if (btn) {
      const n = ov.length + (osc ? 1 : 0);
      btn.classList.toggle('active', n > 0);
      const c = btn.querySelector('.ind-count');
      if (n > 0) {
        if (c) c.textContent = n; else { const s = document.createElement('b'); s.className = 'ind-count'; s.textContent = n; btn.appendChild(s); }
      } else if (c) { c.remove(); }
    }
  }

  function syncIndMenu() {
    Array.prototype.forEach.call(document.querySelectorAll('#ind-menu input[data-ind]'), function (i) {
      i.checked = !!T.ind[i.dataset.ind];
    });
    Array.prototype.forEach.call(document.querySelectorAll('#ind-menu input[data-osc]'), function (i) {
      i.checked = (i.dataset.osc === T.ind.osc);
    });
  }

  function persistInd() { localStorage.setItem('tf2_ind', JSON.stringify(T.ind)); }

  global.tfToggleInd = function (key) {
    T.ind[key] = !T.ind[key];
    persistInd();
    applyIndicators();
  };

  global.tfSetOsc = function (v) {
    T.ind.osc = v;
    persistInd();
    applyIndicators();
  };

  global.tfIndMenu = function (e) {
    if (e) e.stopPropagation();
    const menu = $('ind-menu'), btn = $('ind-btn');
    if (!menu) return;
    const open = menu.classList.toggle('hidden') === false;
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) syncIndMenu();
  };

  // Click-away close — the menu should not linger over the chart.
  document.addEventListener('click', function (e) {
    const menu = $('ind-menu');
    if (!menu || menu.classList.contains('hidden')) return;
    if (e.target.closest && (e.target.closest('#ind-menu') || e.target.closest('#ind-btn'))) return;
    menu.classList.add('hidden');
    const btn = $('ind-btn'); if (btn) btn.setAttribute('aria-expanded', 'false');
  });

  function onHover(bar) {
    const el = $('ohlc-readout');
    if (!el) return;
    if (!bar) { el.innerHTML = ohlcDefault(); return; }
    const dec = d(T.symbol);
    const up = bar.c >= bar.o;
    const chg = bar.o ? ((bar.c - bar.o) / bar.o) * 100 : 0;
    el.innerHTML = '<span class="' + (up ? 'up' : 'down') + '">'
      + 'O ' + fmt(bar.o, dec) + ' H ' + fmt(bar.h, dec) + ' L ' + fmt(bar.l, dec) + ' C ' + fmt(bar.c, dec)
      + '</span> <span class="' + cls(chg) + '">' + signed(chg, 2) + '%</span>'
      + ' <span class="dim">Vol ' + compact(bar.v) + '</span>';
  }

  function ohlcDefault() {
    const bars = replaySlice();
    const b = bars[bars.length - 1];
    if (!b) return '';
    const dec = d(T.symbol);
    const chg = b.o ? ((b.c - b.o) / b.o) * 100 : 0;
    return '<span class="' + (b.c >= b.o ? 'up' : 'down') + '">O ' + fmt(b.o, dec) + ' H ' + fmt(b.h, dec)
      + ' L ' + fmt(b.l, dec) + ' C ' + fmt(b.c, dec) + '</span> <span class="' + cls(chg) + '">'
      + signed(chg, 2) + '%</span> <span class="dim">Vol ' + compact(b.v) + '</span>';
  }

  // ───────────────────────────── order book + depth ───────────────────────────

  global.tfSetGroup = function (g) {
    T.group = g;
    Array.prototype.forEach.call(document.querySelectorAll('#ob-group button'), function (b) {
      b.classList.toggle('on', Number(b.dataset.g) === g);
    });
    renderBook();
  };

  function renderBook() {
    const b = M.book(T.symbol, T.group, 11);
    const dec = d(T.symbol);
    const asks = $('ob-asks'), bids = $('ob-bids');

    // Cumulative-volume background bar: the width encodes total depth to that level,
    // which is how Kraken/Binance render the "wall" behind each price.
    function row(l, side) {
      const pct = (l.depth * 100).toFixed(1);
      const mine = l.mine > 0 ? '<i class="ob-mine" title="your resting order">◆</i>' : '';
      return '<div class="ob-row ' + side + '" style="--d:' + pct + '%" onclick="tfPickPrice(' + l.price + ')">'
        + '<span class="ob-p">' + fmt(l.price, dec) + '</span>'
        + '<span class="ob-s">' + compact(l.size) + mine + '</span>'
        + '<span class="ob-c">' + compact(l.cum) + '</span></div>';
    }

    if (asks) asks.innerHTML = b.asks.slice().reverse().map(function (l) { return row(l, 'ask'); }).join('');
    if (bids) bids.innerHTML = b.bids.map(function (l) { return row(l, 'bid'); }).join('');

    const mid = $('ob-mid');
    if (mid) {
      const last = M.tape(T.symbol, 1)[0];
      const up = !last || last.side === 'buy';
      mid.className = 'ob-mid ' + (up ? 'up' : 'down');
      mid.innerHTML = '<b>' + arrow(up ? 1 : -1) + ' ' + fmt(b.mid, dec) + '</b>'
        + '<em>spread ' + fmt(b.spread, dec) + ' · ' + b.spreadPct.toFixed(3) + '%</em>';
    }

    if (T.depth) T.depth.render(b, dec);

    // 체결강도 — taker buy volume as a share of the recent tape.
    // The track is the sell share (red) and the fill is the buy share (green),
    // so the split itself is the reading — a same-colour fill would be invisible.
    const bp = M.buyPressure(T.symbol);
    const bar = $('bp-bar'), val = $('bp-val');
    if (bar) {
      const share = Math.max(3, Math.min(97, (bp / (bp + 100)) * 100));
      bar.style.width = share.toFixed(1) + '%';
    }
    if (val) {
      val.className = 'bp-val ' + (bp >= 100 ? 'up' : 'down');
      val.textContent = bp.toFixed(0) + '%';
    }
  }

  global.tfPickPrice = function (p) {
    const el = $('of-price');
    if (!el) return;
    if (T.type === 'market') global.tfSetType('limit');
    el.value = p;
    T.priceTouched = true;
    syncOrderForm();
  };

  // ──────────────────────────────── trade tape ────────────────────────────────

  let lastTapeKey = '';

  function renderTape() {
    const el = $('tape-list');
    if (!el) return;
    const dec = d(T.symbol);
    const rows = M.tape(T.symbol, 22);
    if (!rows.length) { el.innerHTML = ''; return; }

    const key = t => t.t + ':' + t.price + ':' + t.qty + ':' + t.side;
    // Only the prints that arrived since the last paint animate in. Re-running the
    // entrance animation on every row each second reads as flicker, not as a feed.
    let fresh = rows.length;
    for (let i = 0; i < rows.length; i++) {
      if (key(rows[i]) === lastTapeKey) { fresh = i; break; }
    }
    lastTapeKey = key(rows[0]);

    el.innerHTML = rows.map(function (t, i) {
      const dt = new Date(t.t);
      const p = n => String(n).padStart(2, '0');
      return '<div class="tp-row ' + (t.side === 'buy' ? 'up' : 'down') + (i < fresh ? ' fresh' : '') + '">'
        + '<span>' + (t.side === 'buy' ? '▲' : '▼') + ' ' + fmt(t.price, dec) + '</span>'
        + '<span>' + compact(t.qty) + '</span>'
        + '<span class="dim">' + p(dt.getHours()) + ':' + p(dt.getMinutes()) + ':' + p(dt.getSeconds()) + '</span>'
        + '</div>';
    }).join('');
  }

  function renderNews() {
    const el = $('news-list');
    if (!el) return;
    const items = M.news(T.symbol);
    if (!items.length) { el.innerHTML = '<span class="dim">No shocks in range.</span>'; return; }
    el.innerHTML = items.map(function (n) {
      const dt = new Date(n.t);
      return '<span class="nw ' + (n.dir > 0 ? 'up' : 'down') + '">'
        + arrow(n.dir) + ' ' + esc(n.sym) + ' ' + esc(n.text) + ' <b>' + signed(n.pct, 1) + '%</b>'
        + ' <em>' + (dt.getMonth() + 1) + '/' + dt.getDate() + '</em></span>';
    }).join('');
  }

  // ─────────────────────────────── order ticket ───────────────────────────────

  global.tfSetSide = function (side) {
    T.side = side;
    $('of-buy').classList.toggle('on', side === 'buy');
    $('of-sell').classList.toggle('on', side === 'sell');
    const form = $('order-form');
    if (form) form.className = 'ticket ' + side;
    seedPrices(T.type);   // trigger/limit defaults are side-dependent
    syncOrderForm();
  };

  global.tfSetType = function (type) {
    T.type = type;
    const sel = $('of-type');
    if (sel && sel.value !== type) sel.value = type;
    $('row-price').classList.toggle('hidden', type === 'market' || type === 'trailing-stop');
    $('row-stop').classList.toggle('hidden', type !== 'stop-limit' && type !== 'oco');
    $('row-trail').classList.toggle('hidden', type !== 'trailing-stop');
    const pl = $('lbl-price');
    if (pl) pl.textContent = type === 'oco' ? 'Take-profit price' : 'Limit price';
    const sl = $('lbl-stop');
    if (sl) sl.textContent = type === 'oco' ? 'Stop price' : 'Stop trigger';
    seedPrices(type);
    syncOrderForm();
  };

  /* Seed coherent defaults for the chosen type. A buy stop-limit whose limit sits
   * below its trigger can never fill, so the defaults must not suggest it:
   *   stop-limit → limit at the trigger (marketable once armed)
   *   OCO        → take-profit on the profitable side, stop on the protective side
   */
  function seedPrices(type) {
    const last = M.lastPrice(T.symbol);
    const dec = d(T.symbol);
    const stopEl = $('of-stop'), priceEl = $('of-price');
    if (type === 'stop-limit') {
      const stop = last * (T.side === 'buy' ? 1.02 : 0.98);
      if (stopEl) stopEl.value = stop.toFixed(dec);
      if (priceEl) priceEl.value = stop.toFixed(dec);
      T.priceTouched = true;
    } else if (type === 'oco') {
      if (priceEl) priceEl.value = (last * (T.side === 'sell' ? 1.05 : 0.95)).toFixed(dec);
      if (stopEl) stopEl.value = (last * (T.side === 'sell' ? 0.97 : 1.03)).toFixed(dec);
      T.priceTouched = true;
    } else if (type === 'limit') {
      T.priceTouched = false;
    }
  }

  function maxQty() {
    const px = refPrice();
    if (T.side === 'buy') return px > 0 ? M.buyingPower() / (px * (1 + M.FEE_TAKER)) : 0;
    return Math.max(0, M.position(T.symbol).qty - M.reservedQty(T.symbol));
  }

  function refPrice() {
    if (T.type === 'market' || T.type === 'trailing-stop') return M.lastPrice(T.symbol);
    const v = parseFloat($('of-price') ? $('of-price').value : '');
    return Number.isFinite(v) && v > 0 ? v : M.lastPrice(T.symbol);
  }

  global.tfSetPct = function (pct) {
    const sym = M.symbolById(T.symbol);
    const q = M.roundQty(maxQty() * (pct / 100), sym.qStep);
    const el = $('of-qty');
    if (el) el.value = q > 0 ? String(q) : '';
    const sl = $('of-slider');
    if (sl) sl.value = String(pct);
    syncOrderForm();
  };

  global.tfSlider = function (v) {
    global.tfSetPct(Number(v));
  };

  // Keep the ticket honest: available balance, total and fee always reflect the
  // exact numbers the engine will charge.
  function syncOrderForm(hard) {
    const sym = M.symbolById(T.symbol);
    const dec = d(T.symbol);
    const priceEl = $('of-price');
    if (priceEl && (hard || !T.priceTouched || !priceEl.value)) {
      priceEl.value = M.lastPrice(T.symbol).toFixed(dec);
    }
    if (hard) {
      // Delegate trigger/limit seeding so a symbol switch can't leave an
      // incoherent pair (e.g. a buy stop-limit priced below its own trigger).
      seedPrices(T.type);
      const q = $('of-qty'); if (q) q.value = '';
      const sl = $('of-slider'); if (sl) sl.value = '0';
    }

    const px = refPrice();
    const qty = parseFloat($('of-qty') ? $('of-qty').value : '') || 0;
    const notional = qty * px;
    const feeRate = (T.type === 'market') ? M.FEE_TAKER : M.FEE_MAKER;
    const fee = notional * feeRate;

    setText('of-avail', T.side === 'buy'
      ? fmt(M.buyingPower(), 2) + ' ' + M.QUOTE
      : fmt(Math.max(0, M.position(T.symbol).qty - M.reservedQty(T.symbol)), 4) + ' ' + T.symbol);
    setText('of-avail-lbl', T.side === 'buy' ? 'Buying power' : 'Available ' + T.symbol);
    setText('of-total', fmt(notional, 2) + ' ' + M.QUOTE);
    setText('of-fee', fmt(fee, 4) + ' ' + M.QUOTE + ' · ' + (feeRate * 100).toFixed(2) + '% ' + (T.type === 'market' ? 'taker' : 'maker'));
    setText('of-unit', sym.id);
    setText('of-quote', M.QUOTE);

    const btn = $('of-submit');
    if (btn) {
      btn.className = 'of-submit ' + T.side;
      btn.textContent = (T.side === 'buy' ? 'Buy ' : 'Sell ') + T.symbol
        + (T.type === 'market' ? ' at market' : T.type === 'oco' ? ' · OCO' : '');
    }
    const mx = maxQty();
    const sl2 = $('of-slider');
    if (sl2 && qty > 0 && mx > 0) sl2.value = String(Math.min(100, Math.round((qty / mx) * 100)));
  }

  global.tfQtyInput = function () { syncOrderForm(); };
  global.tfPriceInput = function () { T.priceTouched = true; syncOrderForm(); };

  global.tfSubmit = function () {
    const req = {
      symbol: T.symbol,
      side: T.side,
      type: T.type,
      qty: parseFloat($('of-qty').value),
      limitPrice: parseFloat($('of-price').value),
      stopPrice: parseFloat($('of-stop').value),
      trailPct: parseFloat($('of-trail').value)
    };
    const r = M.placeOrder(req);
    if (!r.ok) { toast(r.error, 'bad'); return; }
    toast(r.message, T.side === 'buy' ? 'up' : 'down');
    if (global.legionTrack) global.legionTrack('activate');
    $('of-qty').value = '';
    $('of-slider').value = '0';
    syncOrderForm();
    renderAll();
  };

  // ─────────────────────────── portfolio + blotter ────────────────────────────

  function renderPortfolio() {
    const p = M.portfolio();
    setText('pf-equity', fmt(p.equity, 2));
    setText('pf-bp', fmt(p.buyingPower, 2));
    const day = $('pf-day');
    if (day) {
      day.className = 'pf-v ' + cls(p.dayPnl);
      day.textContent = arrow(p.dayPnl) + ' ' + signed(p.dayPnl, 2) + ' (' + signed(p.dayPct, 2) + '%)';
    }
    const un = $('pf-unreal');
    if (un) { un.className = 'pf-v ' + cls(p.unrealized); un.textContent = signed(p.unrealized, 2); }
    const re = $('pf-real');
    if (re) { re.className = 'pf-v ' + cls(p.realized); re.textContent = signed(p.realized, 2); }
  }

  global.tfBlotter = function (tab) {
    T.blotter = tab;
    Array.prototype.forEach.call(document.querySelectorAll('#bl-tabs button'), function (b) {
      b.classList.toggle('on', b.dataset.b === tab);
    });
    renderBlotter();
  };

  function table(head, rows, empty) {
    if (!rows.length) return '<div class="bl-empty">' + empty + '</div>';
    return '<div class="bl-scroll"><table class="bl"><thead><tr>'
      + head.map(function (h) { return '<th>' + h + '</th>'; }).join('')
      + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  }

  function ts(t) {
    const dt = new Date(t);
    const p = n => String(n).padStart(2, '0');
    return p(dt.getMonth() + 1) + '/' + p(dt.getDate()) + ' ' + p(dt.getHours()) + ':' + p(dt.getMinutes()) + ':' + p(dt.getSeconds());
  }

  function renderBlotter() {
    const el = $('bl-body');
    if (!el) return;
    const orders = M.account.orders;

    if (T.blotter === 'open') {
      const open = orders.filter(function (o) { return o.status === 'open'; });
      setCount('c-open', open.length);
      el.innerHTML = table(
        ['Time', 'Market', 'Side', 'Type', 'Price', 'Amount', 'Filled', 'Queue', ''],
        open.map(function (o) {
          const dec = d(o.symbol);
          const px = Number.isFinite(o.limitPrice) ? fmt(o.limitPrice, dec) : 'market';
          const pctF = o.qty ? (o.filled / o.qty) * 100 : 0;
          const state = (Number.isFinite(o.stopPrice) && !o.armed)
            ? '<em class="dim">arms @ ' + fmt(o.stopPrice, dec) + '</em>'
            : o.outsideBook ? '<em class="dim">beyond book</em>'
              : o.queueAhead > 0 ? compact(o.queueAhead) + ' ahead'
                : '<span class="up">at front</span>';
          return '<tr><td class="dim">' + ts(o.placedAt) + '</td><td><b>' + o.symbol + '</b></td>'
            + '<td class="' + (o.side === 'buy' ? 'up' : 'down') + '">' + arrow(o.side === 'buy' ? 1 : -1) + ' ' + o.side + '</td>'
            + '<td class="dim">' + o.type + (o.ocoId ? ' · oco' : '') + '</td>'
            + '<td>' + px + '</td><td>' + compact(o.qty) + '</td>'
            + '<td><div class="fillbar"><i style="width:' + pctF.toFixed(1) + '%"></i></div>' + pctF.toFixed(0) + '%</td>'
            + '<td class="dim">' + state + '</td>'
            + '<td><button class="x" onclick="tfCancel(' + o.id + ')" title="Cancel order">✕</button></td></tr>';
        }),
        'No resting orders. A limit order placed away from the market will wait here with its queue position.'
      );
      return;
    }

    if (T.blotter === 'positions') {
      const p = M.portfolio();
      setCount('c-pos', p.positions.length);
      el.innerHTML = table(
        ['Market', 'Size', 'Avg entry', 'Mark', 'Value', 'Unrealized', '%', ''],
        p.positions.map(function (r) {
          const dec = d(r.symbol);
          return '<tr><td><b>' + r.symbol + '</b></td><td>' + compact(r.qty) + '</td>'
            + '<td>' + fmt(r.avgEntry, dec) + '</td><td>' + fmt(r.price, dec) + '</td>'
            + '<td>' + fmt(r.value, 2) + '</td>'
            + '<td class="' + cls(r.pnl) + '">' + arrow(r.pnl) + ' ' + signed(r.pnl, 2) + '</td>'
            + '<td class="' + cls(r.pct) + '">' + signed(r.pct, 2) + '%</td>'
            + '<td><button class="x" onclick="tfClose(\'' + r.symbol + '\')" title="Close at market">✕</button></td></tr>';
        }),
        'No open positions. Buying re-averages your entry price; selling realizes against that average.'
      );
      return;
    }

    if (T.blotter === 'trades') {
      const fills = M.account.fills;
      setCount('c-trades', fills.length);
      el.innerHTML = table(
        ['Time', 'Market', 'Side', 'Price', 'Amount', 'Value', 'Fee', 'Role'],
        fills.slice(0, 60).map(function (f) {
          const dec = d(f.symbol);
          return '<tr><td class="dim">' + ts(f.t) + '</td><td><b>' + f.symbol + '</b></td>'
            + '<td class="' + (f.side === 'buy' ? 'up' : 'down') + '">' + arrow(f.side === 'buy' ? 1 : -1) + ' ' + f.side + '</td>'
            + '<td>' + fmt(f.price, dec) + '</td><td>' + compact(f.qty) + '</td>'
            + '<td>' + fmt(f.qty * f.price, 2) + '</td>'
            + '<td class="dim">' + fmt(f.fee, 4) + '</td>'
            + '<td class="dim">' + f.liquidity + '</td></tr>';
        }),
        'No executions yet. Every fill is logged here with its price, fee and maker/taker role.'
      );
      return;
    }

    const closed = orders.filter(function (o) { return o.status !== 'open'; });
    setCount('c-closed', closed.length);
    el.innerHTML = table(
      ['Time', 'Market', 'Side', 'Type', 'Price', 'Amount', 'Avg fill', 'Status'],
      closed.slice(0, 60).map(function (o) {
        const dec = d(o.symbol);
        const px = Number.isFinite(o.limitPrice) ? fmt(o.limitPrice, dec) : 'market';
        return '<tr><td class="dim">' + ts(o.closedAt || o.placedAt) + '</td><td><b>' + o.symbol + '</b></td>'
          + '<td class="' + (o.side === 'buy' ? 'up' : 'down') + '">' + arrow(o.side === 'buy' ? 1 : -1) + ' ' + o.side + '</td>'
          + '<td class="dim">' + o.type + '</td><td>' + px + '</td><td>' + compact(o.qty) + '</td>'
          + '<td>' + (o.avgFill ? fmt(o.avgFill, dec) : '—') + '</td>'
          + '<td class="dim">' + o.status + (o.note ? ' · ' + esc(o.note) : '') + '</td></tr>';
      }),
      'No order history yet.'
    );
  }

  function setCount(id, n) {
    const el = $(id);
    if (el) el.textContent = n ? ' ' + n : '';
  }

  global.tfCancel = function (id) {
    const r = M.cancelOrder(id);
    toast(r.ok ? 'Order cancelled.' : r.error, r.ok ? 'ok' : 'bad');
    renderAll();
  };

  global.tfClose = function (sym) {
    const r = M.closePosition(sym);
    toast(r.ok ? r.message : r.error, r.ok ? 'ok' : 'bad');
    renderAll();
  };

  global.tfCancelAll = function () {
    const n = M.cancelAll(null);
    toast(n ? n + ' order' + (n === 1 ? '' : 's') + ' cancelled.' : 'Nothing to cancel.', 'ok');
    renderAll();
  };

  global.tfReset = function () {
    if (!confirm('Reset the paper account to 100,000 ' + M.QUOTE + '? Positions, orders and history are cleared. (Simulation only.)')) return;
    M.resetAccount();
    toast('Paper account reset to 100,000 ' + M.QUOTE + '.', 'ok');
    renderAll();
  };

  // Share a P&L summary as text — no location leakage, no fabricated numbers.
  global.tfShare = function () {
    const p = M.portfolio();
    const txt = 'TradeForge paper terminal — equity ' + fmt(p.equity, 2) + ' ' + M.QUOTE
      + ' · day ' + signed(p.dayPnl, 2) + ' (' + signed(p.dayPct, 2) + '%)'
      + ' · realized ' + signed(p.realized, 2)
      + ' — fictional trading simulation, not investment.';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast('P&L summary copied.', 'ok'); }, function () { toast(txt, 'ok'); });
    } else {
      toast(txt, 'ok');
    }
    if (global.legionTrack) global.legionTrack('share');
  };

  // ──────────────────────────────── toasts ────────────────────────────────────

  function toast(msg, kind) {
    const host = $('toasts');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || 'ok');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(function () { el.classList.add('out'); }, 3200);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3700);
  }

  // ───────────────────────────────── loop ─────────────────────────────────────

  function renderAll() {
    renderTicker();
    renderMarkets(false);
    renderChart(false);
    renderBook();
    renderTape();
    renderPortfolio();
    renderBlotter();
    syncOrderForm();
    const rd = $('ohlc-readout');
    if (rd && !T.chart.cross) rd.innerHTML = ohlcDefault();
  }

  let tickCount = 0;

  function loop() {
    try {
      const fills = M.tickAll();
      if (fills && fills.length) {
        fills.forEach(function (f) {
          toast((f.side === 'buy' ? '▲ Bought ' : '▼ Sold ') + compact(f.qty) + ' ' + f.symbol
            + ' @ ' + fmt(f.price, d(f.symbol)) + ' · maker fill', f.side === 'buy' ? 'up' : 'down');
        });
        renderPortfolio();
        renderBlotter();
      }
      renderTicker();
      renderBook();
      renderTape();
      renderPortfolio();
      if (!T.replay.on) renderChart(false);
      if (tickCount % 3 === 0) renderMarkets(false);
      if (tickCount % 5 === 0 && T.blotter === 'positions') renderBlotter();
      if (tickCount % 30 === 0) renderNews();
      tickCount++;
      const rd = $('ohlc-readout');
      if (rd && T.chart && !T.chart.cross) rd.innerHTML = ohlcDefault();
    } catch (e) {
      if (global.console) console.warn('tick', e);
    }
  }

  // ─────────────────────────────────── init ───────────────────────────────────

  function init() {
    const canvas = $('chart-canvas');
    if (!canvas) return;

    T.symbol = localStorage.getItem('tf2_symbol') || 'TFC';
    if (!M.SYMBOLS.some(function (s) { return s.id === T.symbol; })) T.symbol = 'TFC';
    T.tf = localStorage.getItem('tf2_tf') || '15m';
    if (!M.TF[T.tf]) T.tf = '15m';

    M.init();

    T.chart = new C.Chart(canvas);
    T.chart.onHover = onHover;
    const dc = $('depth-canvas');
    if (dc) T.depth = new C.Depth(dc);

    // Timeframe bar
    const tfBar = $('tf-bar');
    if (tfBar) {
      tfBar.innerHTML = Object.keys(M.TF).map(function (k) {
        return '<button data-tf="' + k + '" class="' + (k === T.tf ? 'on' : '') + '" onclick="tfSetTf(\'' + k + '\')">' + k + '</button>';
      }).join('');
    }

    global.tfSetType(T.type);
    global.tfSetSide('buy');
    global.tfSetGroup(1);
    loadInd();
    applyIndicators();
    syncIndMenu();
    renderMarkets(true);
    renderNews();
    syncOrderForm(true);
    renderAll();

    global.addEventListener('resize', function () {
      renderChart(false);
      renderBook();
    });

    setInterval(loop, 1000);
    // Re-sync immediately when the tab comes back — replay is deterministic.
    document.addEventListener('visibilitychange', function () { if (!document.hidden) loop(); });
  }

  global.tfInitTerminal = function () {
    try { init(); } catch (e) { if (global.console) console.error('terminal init', e); }
  };

  // Canvases measure 0 while their section is display:none — re-render on reveal.
  global.tfRelayout = function () {
    try {
      if (!T.chart) return;
      renderChart(false);
      renderBook();
      renderBlotter();
    } catch (e) { /* non-fatal */ }
  };

})(typeof window !== 'undefined' ? window : globalThis);
