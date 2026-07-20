/* market-engine.js — TradeForge Terminal simulation core (FICTIONAL).
 *
 * Everything here is DETERMINISTIC: prices, order book depth and the trade tape
 * are derived from a seeded PRNG keyed by (symbol, absolute time index). The same
 * wall-clock second always produces the same market, so a reload never "rerolls"
 * the tape — the chart you leave is the chart you come back to.
 *
 * Model (standard quant building blocks, not decoration):
 *   - log-return random walk (GBM) with Ornstein–Uhlenbeck pull toward a drifting anchor
 *   - GARCH(1,1) conditional variance  -> genuine volatility clustering
 *   - Poisson jump process              -> news spikes, surfaced in the news rail
 *   - AR(1) volume with |return| coupling -> volume autocorrelation
 *   - multi-resolution consistency: 1m bars are generated as sub-steps of each 15m
 *     bar, so 1m aggregates EXACTLY into 5m/15m/1h/4h/1D. No per-timeframe fakery.
 *
 * Matching is price-time priority against the simulated tape, including queue
 * position — so partial fills emerge naturally rather than being special-cased.
 *
 * Symbols are invented in-app units (no real tickers, no fiat). Not investment.
 */
(function (global) {
  'use strict';

  // ───────────────────────── deterministic randomness ─────────────────────────

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // FNV-style mix of two 32-bit ints → stable seed for any (symbol, index) pair.
  function hash2(a, b) {
    let h = 2166136261 >>> 0;
    h = Math.imul(h ^ (a & 0xffff), 16777619);
    h = Math.imul(h ^ ((a >>> 16) & 0xffff), 16777619);
    h = Math.imul(h ^ (b & 0xffff), 16777619);
    h = Math.imul(h ^ ((b >>> 16) & 0xffff), 16777619);
    h ^= h >>> 13;
    return h >>> 0;
  }

  // Box–Muller: one standard normal per call, second value cached.
  function gaussian(rnd) {
    const u = Math.max(1e-12, 1 - rnd());
    const v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // ───────────────────────────── market definition ────────────────────────────

  const MIN = 60000;
  const M15 = 15 * MIN;
  // Fixed genesis so the path is identical for every visitor and every reload.
  const GENESIS = Date.UTC(2026, 0, 1, 0, 0, 0);
  const MAX_15M_BARS = 20160;   // ~210 days of history, bounded work
  const RECENT_1M = 4320;       // keep 3 days of 1m bars for the fast timeframes

  // sigma = per-minute return stdev. vol0 = notional daily volume in base units.
  const SYMBOLS = [
    { id: 'TFC', name: 'TradeForge Coin', seed: 10133, p0: 2.40,   sigma: 0.00110, mu: 4.0e-8,  kappa: 0.0035, jumpP: 0.00110, jumpS: 0.020, vol0: 2_400_000, tick: 0.001,   qStep: 1 },
    { id: 'VLT', name: 'Vault Shard',     seed: 20477, p0: 18.60,  sigma: 0.00085, mu: 2.4e-8,  kappa: 0.0050, jumpP: 0.00070, jumpS: 0.016, vol0: 320_000,   tick: 0.01,    qStep: 0.1 },
    { id: 'MEM', name: 'MemeForge Token', seed: 31771, p0: 0.3150, sigma: 0.00265, mu: -1.2e-8, kappa: 0.0020, jumpP: 0.00240, jumpS: 0.045, vol0: 18_000_000, tick: 0.0001, qStep: 10 },
    { id: 'ECO', name: 'Echo Essence',    seed: 40913, p0: 0.0842, sigma: 0.00180, mu: 6.0e-8,  kappa: 0.0028, jumpP: 0.00150, jumpS: 0.030, vol0: 44_000_000, tick: 0.00001, qStep: 100 },
    { id: 'ORE', name: 'Ore Ingot',       seed: 55291, p0: 7.85,   sigma: 0.00062, mu: 1.0e-8,  kappa: 0.0075, jumpP: 0.00050, jumpS: 0.012, vol0: 640_000,   tick: 0.005,   qStep: 0.5 },
    { id: 'LGN', name: 'Legion Bond',     seed: 61609, p0: 124.50, sigma: 0.00034, mu: 8.0e-9,  kappa: 0.0120, jumpP: 0.00025, jumpS: 0.008, vol0: 42_000,    tick: 0.05,    qStep: 0.01 }
  ];

  const QUOTE = 'CR';                 // quote currency: in-app Credits
  const FEE_MAKER = 0.0002;           // 0.02% — resting liquidity
  const FEE_TAKER = 0.0006;           // 0.06% — liquidity taking

  // GARCH(1,1). alpha+beta = 0.97 → slow-decaying volatility clusters.
  const G_ALPHA = 0.09, G_BETA = 0.88;

  const NEWS = [
    'liquidity pool rebalanced', 'foundry output revised', 'guild treasury vote passes',
    'bridge maintenance concluded', 'staking ratio hits new high', 'large holder unstakes',
    'burn schedule accelerated', 'index inclusion announced', 'settlement window widened',
    'market maker adds depth', 'supply cap adjustment filed', 'oracle feed upgraded'
  ];

  // ─────────────────────────── price path generation ──────────────────────────

  const cache = Object.create(null);

  function symbolById(id) {
    for (let i = 0; i < SYMBOLS.length; i++) if (SYMBOLS[i].id === id) return SYMBOLS[i];
    return SYMBOLS[0];
  }

  /* The generator is a resumable state machine that emits one canonical 1-minute
   * bar per call. History and the live feed both run through it, which is what
   * keeps a tab that has been open for hours on exactly the same path as a tab
   * that just loaded — there is no separate "live" price process to drift.
   *
   * Randomness is drawn from a stream seeded by the absolute 15-minute slot, so
   * the path is a pure function of wall-clock time. */
  function makeGen(sym, startSlot) {
    const omega = (1 - G_ALPHA - G_BETA) * sym.sigma * sym.sigma;
    const volBase = sym.vol0 / 1440;
    const g = {
      price: sym.p0,
      sigma2: sym.sigma * sym.sigma,
      lastR: 0,
      vol: volBase,
      slot: startSlot,
      pos: 0,
      rnd: mulberry32(hash2(sym.seed, startSlot)),
      events: []
    };

    g.nextMinute = function () {
      if (g.pos >= 15) { g.slot++; g.pos = 0; g.rnd = mulberry32(hash2(sym.seed, g.slot)); }
      const rnd = g.rnd;
      const minIdx = Math.floor((g.slot * M15) / MIN) + g.pos;
      // anchor drifts slowly; OU pulls price back toward it (prevents runaway walks)
      const anchor = sym.p0 * Math.exp(sym.mu * (g.slot - startSlot) * 15);

      const o = g.price;
      let h = o, l = o;
      const sigma = Math.sqrt(g.sigma2);
      const pull = sym.kappa * (Math.log(anchor) - Math.log(o));

      for (let k = 0; k < 2; k++) {
        const r = (sym.mu + pull) / 2 + (sigma / Math.SQRT2) * gaussian(rnd);
        g.price = g.price * Math.exp(r);
        if (g.price > h) h = g.price;
        if (g.price < l) l = g.price;
      }

      // Poisson jump — a discrete news shock, recorded so the rail can explain it.
      if (rnd() < sym.jumpP) {
        const dir = rnd() < 0.5 ? -1 : 1;
        const mag = sym.jumpS * (0.5 + rnd());
        g.price = g.price * Math.exp(dir * mag);
        if (g.price > h) h = g.price;
        if (g.price < l) l = g.price;
        g.events.push({
          t: minIdx * MIN, sym: sym.id, dir: dir,
          pct: (Math.exp(dir * mag) - 1) * 100,
          text: NEWS[hash2(sym.seed, minIdx) % NEWS.length]
        });
        if (g.events.length > 40) g.events.shift();
      }

      const c = g.price;
      const r1 = Math.log(c / o);
      // AR(1) volume with |return| coupling → bursts persist, like real tape.
      const shock = 1 + 2.4 * Math.min(4, Math.abs(r1) / Math.max(1e-9, sigma));
      g.vol = 0.72 * g.vol + 0.28 * volBase * shock * (0.55 + 0.9 * rnd());

      // GARCH(1,1) update on the realised return → volatility clusters
      g.sigma2 = omega + G_ALPHA * g.lastR * g.lastR + G_BETA * g.sigma2;
      g.lastR = r1;
      g.sigma1m = sigma;
      g.pos++;

      return { t: minIdx * MIN, o: o, h: h, l: l, c: c, v: g.vol, sigma: sigma };
    };

    return g;
  }

  /* Build history up to (but excluding) the currently forming minute, then leave
   * the generator parked so the live feed can continue from exactly there. */
  function buildHistory(sym) {
    const nowMin = Math.floor(Date.now() / MIN);
    const startSlot = Math.floor(GENESIS / M15);
    let endSlot = Math.floor((nowMin * MIN) / M15);
    if (endSlot - startSlot > MAX_15M_BARS) endSlot = startSlot + MAX_15M_BARS;

    const gen = makeGen(sym, startSlot);
    const bars15 = [];
    const bars1 = [];
    const keep1mFrom = nowMin - RECENT_1M;
    const totalMinutes = (endSlot - startSlot) * 15;

    let cur = null;
    for (let i = 0; i < totalMinutes; i++) {
      const b = gen.nextMinute();
      if (b.t >= keep1mFrom * MIN) bars1.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
      const slotT = Math.floor(b.t / M15) * M15;
      if (cur && cur.t === slotT) {
        cur.h = Math.max(cur.h, b.h);
        cur.l = Math.min(cur.l, b.l);
        cur.c = b.c;
        cur.v += b.v;
      } else {
        cur = { t: slotT, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
        bars15.push(cur);
      }
    }

    // Fast-forward the generator across any whole minutes between the end of the
    // 15m grid and the current minute, so `gen` is aligned with wall-clock time.
    const generatedThrough = Math.floor((endSlot * M15) / MIN);
    for (let m = generatedThrough; m < nowMin; m++) {
      const b = gen.nextMinute();
      bars1.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
      rollBarInto(bars15, b);
    }
    while (bars1.length > RECENT_1M) bars1.shift();

    return {
      bars1m: bars1,
      bars15m: bars15,
      gen: gen,
      genMin: nowMin,        // absolute minute the generator will emit next
      price: gen.price,
      lastMin: nowMin
    };
  }

  function rollBarInto(bars15, bar) {
    const slotT = Math.floor(bar.t / M15) * M15;
    const last = bars15[bars15.length - 1];
    if (last && last.t === slotT) {
      last.h = Math.max(last.h, bar.h);
      last.l = Math.min(last.l, bar.l);
      last.c = bar.c;
      last.v += bar.v;
    } else {
      bars15.push({ t: slotT, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v });
      if (bars15.length > MAX_15M_BARS) bars15.shift();
    }
  }

  function state(id) {
    if (!cache[id]) {
      const sym = symbolById(id);
      const h = buildHistory(sym);
      h.sym = sym;
      h.live = null;        // the forming 1m bar
      h.tape = [];          // recent prints (market trades)
      h.lastSec = 0;
      cache[id] = h;
      advance(id);
    }
    return cache[id];
  }

  /* Advance to wall-clock now. Completed minutes are closed out and the generator
   * emits the next canonical bar; within a minute, per-second ticks are replayed
   * from the start of that minute. Both are pure functions of absolute time, so a
   * reload lands on the same market a continuously-open tab would be showing. */
  function advance(id) {
    const st = cache[id];
    if (!st) return [];
    const nowSec = Math.floor(Date.now() / 1000);
    const nowMin = Math.floor(nowSec / 60);
    const fills = [];

    // Close out finished minutes (bounded, in case the tab slept for a long time).
    let guard = 0;
    while (st.lastMin < nowMin && guard++ < 4320) {
      if (st.live) {
        // The bar keeps the canonical open/close; the intraday extremes come from
        // the path that was actually traversed.
        st.live.c = st.target.c;
        st.live.h = Math.max(st.live.h, st.target.h);
        st.live.l = Math.min(st.live.l, st.target.l);
        st.live.v = st.target.v;
        st.bars1m.push(st.live);
        if (st.bars1m.length > RECENT_1M) st.bars1m.shift();
        rollBarInto(st.bars15m, st.live);
      }
      st.lastMin++;
      st.live = null;
      st.target = null;
    }

    if (!st.live) {
      // Skip the generator forward if whole minutes elapsed while we were away,
      // so it stays aligned with wall-clock time.
      while (st.genMin < nowMin && guard++ < 4320) { st.gen.nextMinute(); st.genMin++; }
      st.target = st.gen.nextMinute();
      st.genMin++;
      st.price = st.target.o;
      st.live = { t: nowMin * MIN, o: st.target.o, h: st.target.o, l: st.target.o, c: st.target.o, v: 0 };
      st.lastSec = nowMin * 60 - 1;
    }

    const from = Math.max(st.lastSec + 1, nowMin * 60);
    for (let s = from; s <= nowSec; s++) tick(st, s, fills);
    st.lastSec = nowSec;
    st.price = st.live.c;
    return fills;
  }

  /* One second of market activity.
   *
   * The intra-minute path is a Brownian bridge pinned to the canonical bar: the
   * deterministic deviation is scaled by sqrt(f*(1-f)), which is zero at both
   * ends. So the second-by-second wobble is real and random-looking, yet the
   * minute always opens and closes exactly where the generator said it would —
   * the live feed can never drift away from the canonical path.
   */
  function tick(st, sec, fills) {
    const sym = st.sym;
    const target = st.target;
    const rnd = mulberry32(hash2(sym.seed ^ 0x5bf03635, sec));
    const before = st.live.c;
    const secInMin = sec - Math.floor(sec / 60) * 60;

    const prints = [];
    const n = 1 + (hash2(sym.seed, sec) % 3);                // 1–3 prints per second
    const secVol = target.v / 60;
    const drift = Math.log(target.c / target.o);

    for (let i = 0; i < n; i++) {
      const f = (secInMin + (i + 1) / n) / 60;               // fraction of the minute
      const bridge = Math.sqrt(Math.max(0, f * (1 - f))) * target.sigma * 1.6;
      const px0 = target.o * Math.exp(drift * f + bridge * gaussian(rnd));
      const px = round(px0, sym.tick);
      st.live.c = px0;
      if (px0 > st.live.h) st.live.h = px0;
      if (px0 < st.live.l) st.live.l = px0;
      const qty = roundQty((secVol / n) * (0.35 + 1.5 * Math.pow(rnd(), 1.6)), sym.qStep);
      if (qty <= 0) continue;
      prints.push({ t: sec * 1000, price: px, qty: qty, side: px0 >= before ? 'buy' : 'sell' });
    }

    for (let i = 0; i < prints.length; i++) {
      st.live.v += prints[i].qty;
      st.tape.push(prints[i]);
      matchPrints(sym, prints[i], before, fills);
    }
    if (st.tape.length > 80) st.tape.splice(0, st.tape.length - 80);
  }

  function round(v, tick) { return Math.round(v / tick) * tick; }
  function roundQty(v, step) { return Math.round(v / step) * step; }

  // ──────────────────────────────── order book ────────────────────────────────

  /* Depth ladder around the mid. Level sizes evolve smoothly (interpolated between
   * 5-second keyframes) so the book breathes instead of strobing, and resting user
   * orders are folded in at their own price level. */
  function book(id, group, levels) {
    const st = state(id);
    const sym = st.sym;
    levels = levels || 12;
    group = group || 1;
    const step = sym.tick * group;
    const mid = st.price;
    const sec = Math.floor(Date.now() / 1000);
    const slot = Math.floor(sec / 5), frac = (sec % 5) / 5;
    const unit = sym.vol0 / 1440 / 6;

    function size(side, i) {
      const a = mulberry32(hash2(sym.seed ^ (side === 'bid' ? 0x11 : 0x22), slot * 64 + i))();
      const b = mulberry32(hash2(sym.seed ^ (side === 'bid' ? 0x11 : 0x22), (slot + 1) * 64 + i))();
      const w = a + (b - a) * frac;                     // smooth keyframe blend
      const shape = 0.35 + 1.55 * Math.pow(i / levels, 0.75);   // thin at touch
      return roundQty(unit * shape * (0.45 + 1.6 * w), sym.qStep);
    }

    const bids = [], asks = [];
    const bestBid = round(mid - step / 2, sym.tick);
    const bestAsk = round(mid + step / 2, sym.tick);
    for (let i = 0; i < levels; i++) {
      bids.push({ price: round(bestBid - i * step, sym.tick), size: size('bid', i), mine: 0 });
      asks.push({ price: round(bestAsk + i * step, sym.tick), size: size('ask', i), mine: 0 });
    }

    // Fold resting user orders into the ladder they actually sit in.
    account.orders.forEach(function (o) {
      if (o.symbol !== id || o.status !== 'open' || o.type === 'market') return;
      const px = o.limitPrice;
      if (!Number.isFinite(px)) return;
      const arr = o.side === 'buy' ? bids : asks;
      let best = null, bestD = Infinity;
      for (let i = 0; i < arr.length; i++) {
        const d = Math.abs(arr[i].price - px);
        if (d < bestD) { bestD = d; best = arr[i]; }
      }
      if (best && bestD <= step) { best.mine += o.remaining; best.size += o.remaining; }
    });

    let cb = 0, ca = 0;
    bids.forEach(function (l) { cb += l.size; l.cum = cb; });
    asks.forEach(function (l) { ca += l.size; l.cum = ca; });
    const maxCum = Math.max(cb, ca) || 1;
    bids.forEach(function (l) { l.depth = l.cum / maxCum; });
    asks.forEach(function (l) { l.depth = l.cum / maxCum; });

    return {
      bids: bids, asks: asks, mid: mid,
      spread: bestAsk - bestBid,
      spreadPct: ((bestAsk - bestBid) / mid) * 100,
      maxCum: maxCum
    };
  }

  // ─────────────────────────────── account state ──────────────────────────────

  const account = {
    cash: 0,                 // free + reserved quote currency (CR)
    positions: {},           // id -> { qty, avgEntry, realized }
    orders: [],              // resting + historical orders
    fills: [],               // executions
    dayBase: 0,
    dayKey: '',
    seq: 1
  };

  function loadAccount() {
    try {
      const raw = localStorage.getItem('tf2_account');
      if (raw) {
        const p = JSON.parse(raw);
        account.cash = Number(p.cash) || 0;
        account.positions = p.positions || {};
        account.orders = p.orders || [];
        account.fills = p.fills || [];
        account.dayBase = Number(p.dayBase) || 0;
        account.dayKey = p.dayKey || '';
        account.seq = Number(p.seq) || 1;
      }
    } catch (e) { /* corrupt storage → fall through to a fresh account */ }

    if (!localStorage.getItem('tf2_funded')) {
      // One-time paper-account grant. Stated plainly in the UI; nothing real.
      account.cash = 100000;
      account.positions = {};
      const legacy = parseFloat(localStorage.getItem('tf_balance'));
      if (Number.isFinite(legacy) && legacy > 0) {
        account.positions.TFC = { qty: legacy, avgEntry: state('TFC').price, realized: 0 };
      }
      localStorage.setItem('tf2_funded', '1');
      save();
    }
    rollDay();
  }

  function rollDay() {
    const key = new Date().toISOString().slice(0, 10);
    if (account.dayKey !== key) {
      account.dayKey = key;
      account.dayBase = equity();
      save();
    }
  }

  function save() {
    try {
      localStorage.setItem('tf2_account', JSON.stringify({
        cash: account.cash, positions: account.positions,
        orders: account.orders.slice(-120), fills: account.fills.slice(-200),
        dayBase: account.dayBase, dayKey: account.dayKey, seq: account.seq
      }));
    } catch (e) { /* quota — keep trading in memory */ }
    syncLegacy();
  }

  // Keep the original TradeForge wallet in step with the terminal account.
  function syncLegacy() {
    const tfc = account.positions.TFC ? account.positions.TFC.qty : 0;
    try {
      localStorage.setItem('tf_balance', String(tfc));
      localStorage.setItem('tf_credits', String(Math.round(account.cash)));
    } catch (e) { /* ignore */ }
    if (typeof global.tfSetBalances === 'function') global.tfSetBalances(tfc, account.cash);
  }

  function position(id) {
    if (!account.positions[id]) account.positions[id] = { qty: 0, avgEntry: 0, realized: 0 };
    return account.positions[id];
  }

  // Quote reserved by resting buys; base reserved by resting sells.
  function reservedCash() {
    return account.orders.reduce(function (s, o) {
      if (o.status !== 'open' || o.side !== 'buy') return s;
      const px = Number.isFinite(o.limitPrice) ? o.limitPrice : o.stopPrice;
      return s + (Number.isFinite(px) ? px * o.remaining : 0);
    }, 0);
  }

  function reservedQty(id) {
    return account.orders.reduce(function (s, o) {
      return (o.status === 'open' && o.side === 'sell' && o.symbol === id) ? s + o.remaining : s;
    }, 0);
  }

  function buyingPower() { return Math.max(0, account.cash - reservedCash()); }

  function equity() {
    let eq = account.cash;
    for (const id in account.positions) {
      const p = account.positions[id];
      if (p.qty) eq += p.qty * lastPrice(id);
    }
    return eq;
  }

  function lastPrice(id) { return state(id).price; }

  /* Unrealized PnL is average-entry based and NEVER touches cash — it only moves
   * equity. Realized PnL (net of fees) is what actually settles into cash. */
  function unrealized(id) {
    const p = position(id);
    if (!p.qty) return { pnl: 0, pct: 0 };
    const pnl = (lastPrice(id) - p.avgEntry) * p.qty;      // sign-general: shorts invert
    const cost = Math.abs(p.avgEntry * p.qty);
    return { pnl: pnl, pct: cost ? (pnl / cost) * 100 : 0 };
  }

  function portfolio() {
    rollDay();
    const eq = equity();
    let uPnl = 0, realized = 0;
    const rows = [];
    for (const id in account.positions) {
      const p = account.positions[id];
      realized += p.realized || 0;
      if (!p.qty) continue;
      const u = unrealized(id);
      uPnl += u.pnl;
      rows.push({
        symbol: id, qty: p.qty, avgEntry: p.avgEntry,
        price: lastPrice(id), value: p.qty * lastPrice(id),
        pnl: u.pnl, pct: u.pct
      });
    }
    rows.sort(function (a, b) { return b.value - a.value; });
    const dayPnl = account.dayBase ? eq - account.dayBase : 0;
    return {
      cash: account.cash, buyingPower: buyingPower(), equity: eq,
      unrealized: uPnl, realized: realized,
      dayPnl: dayPnl,
      dayPct: account.dayBase ? (dayPnl / account.dayBase) * 100 : 0,
      positions: rows
    };
  }

  // ─────────────────────────────── order lifecycle ────────────────────────────

  /* Apply one execution to the book of record.
   * Buys re-average the entry price (weighted average — the thing that gives
   * "가짜" away when it is missing). Sells realize against that average and the
   * fee is charged into realized PnL, never into the unrealized figure. */
  function applyFill(order, qty, price, liquidity) {
    const p = position(order.symbol);
    const notional = qty * price;
    const fee = notional * (liquidity === 'maker' ? FEE_MAKER : FEE_TAKER);

    if (order.side === 'buy') {
      const newQty = p.qty + qty;
      p.avgEntry = newQty !== 0 ? (p.avgEntry * p.qty + price * qty) / newQty : 0;
      p.qty = newQty;
      account.cash -= notional + fee;
    } else {
      const realized = (price - p.avgEntry) * qty - fee;
      p.realized = (p.realized || 0) + realized;
      p.qty -= qty;
      if (Math.abs(p.qty) < 1e-9) { p.qty = 0; p.avgEntry = 0; }
      account.cash += notional - fee;
      order.realized = (order.realized || 0) + realized;
    }

    order.filled += qty;
    order.remaining = Math.max(0, order.remaining - qty);
    order.avgFill = order.filled ? ((order.avgFill || 0) * (order.filled - qty) + price * qty) / order.filled : price;
    order.fee = (order.fee || 0) + fee;
    if (order.remaining <= 1e-9) {
      order.status = 'filled';
      order.closedAt = Date.now();
      if (order.ocoId) cancelOco(order.ocoId, order.id);
    } else {
      order.status = 'open';
      order.partial = true;
    }

    const fill = {
      id: account.seq++, orderId: order.id, symbol: order.symbol, side: order.side,
      qty: qty, price: price, fee: fee, liquidity: liquidity, t: Date.now()
    };
    account.fills.unshift(fill);
    if (account.fills.length > 200) account.fills.pop();
    return fill;
  }

  function cancelOco(ocoId, exceptId) {
    account.orders.forEach(function (o) {
      if (o.ocoId === ocoId && o.id !== exceptId && o.status === 'open') {
        o.status = 'cancelled';
        o.closedAt = Date.now();
        o.note = 'OCO sibling filled';
      }
    });
  }

  /* Match the simulated tape against resting user orders using price-time
   * priority. Each resting order carries `queueAhead` — the size that was already
   * resting at its price when it was placed. Prints first burn through the queue,
   * and only then fill the user. Partial fills are the natural consequence of
   * fill = min(print size remaining, order remaining) — no special-casing. */
  function matchPrints(sym, print, prevPrice, fills) {
    const candidates = account.orders.filter(function (o) {
      return o.status === 'open' && o.symbol === sym.id && o.type !== 'market';
    });
    if (!candidates.length) return;

    // Stop orders arm first: a print through the stop converts them to live limits.
    candidates.forEach(function (o) {
      if (!o.stopPrice || o.armed) return;
      const crossed = o.side === 'buy' ? print.price >= o.stopPrice : print.price <= o.stopPrice;
      if (crossed) {
        o.armed = true;
        o.triggeredAt = Date.now();
        if (o.trailing) o.limitPrice = round(print.price, sym.tick);
      }
    });

    // Trailing stops ratchet with the favourable extreme, never against it.
    candidates.forEach(function (o) {
      if (!o.trailing || o.armed) return;
      if (o.side === 'sell') {
        o.peak = Math.max(o.peak || print.price, print.price);
        o.stopPrice = round(o.peak * (1 - o.trailPct / 100), sym.tick);
      } else {
        o.peak = Math.min(o.peak || print.price, print.price);
        o.stopPrice = round(o.peak * (1 + o.trailPct / 100), sym.tick);
      }
    });

    const live = candidates.filter(function (o) {
      if (o.stopPrice && !o.armed) return false;
      if (!Number.isFinite(o.limitPrice)) return false;
      return o.side === 'buy' ? print.price <= o.limitPrice : print.price >= o.limitPrice;
    });
    if (!live.length) return;

    // Price-time priority: best price first, then oldest.
    live.sort(function (a, b) {
      if (a.side === 'buy') { if (b.limitPrice !== a.limitPrice) return b.limitPrice - a.limitPrice; }
      else if (a.limitPrice !== b.limitPrice) return a.limitPrice - b.limitPrice;
      return a.placedAt - b.placedAt;
    });

    // A print that sweeps *through* a level clears the queue resting at it.
    const swept = function (o) {
      return o.side === 'buy' ? print.price < o.limitPrice : print.price > o.limitPrice;
    };

    let avail = print.qty;
    for (let i = 0; i < live.length && avail > 1e-9; i++) {
      const o = live[i];
      if (swept(o)) o.queueAhead = 0;
      if (o.queueAhead > 0) {
        const burn = Math.min(o.queueAhead, avail);
        o.queueAhead -= burn;
        avail -= burn;
        if (avail <= 1e-9) break;
      }
      const qty = Math.min(o.remaining, avail);
      if (qty <= 1e-9) continue;
      // Resting orders provide liquidity → maker fee.
      const f = applyFill(o, qty, o.limitPrice, 'maker');
      avail -= qty;
      if (fills) fills.push(f);
    }
  }

  /* Market order: walk the visible ladder, consuming level by level. The fill is
   * a size-weighted average across the levels touched, so large orders genuinely
   * pay slippage instead of getting a perfect touch price. */
  function executeMarket(order) {
    const st = state(order.symbol);
    const sym = st.sym;
    const b = book(order.symbol, 1, 14);
    const levels = order.side === 'buy' ? b.asks : b.bids;
    let remaining = order.remaining;
    let notional = 0, got = 0;

    for (let i = 0; i < levels.length && remaining > 1e-9; i++) {
      const take = Math.min(remaining, levels[i].size);
      notional += take * levels[i].price;
      got += take;
      remaining -= take;
    }
    if (got <= 0) return { ok: false, error: 'No liquidity available.' };
    // Beyond the visible ladder, price walks off the last level.
    if (remaining > 1e-9) {
      const edge = levels[levels.length - 1].price * (order.side === 'buy' ? 1.002 : 0.998);
      notional += remaining * edge;
      got += remaining;
    }
    const avg = round(notional / got, sym.tick);
    applyFill(order, got, avg, 'taker');
    return { ok: true, price: avg, qty: got };
  }

  /* Validate and place an order. Every rejection happens BEFORE any mutation, so
   * a failed order can never leave the balance drifting. */
  function placeOrder(req) {
    const sym = symbolById(req.symbol);
    const st = state(sym.id);
    const side = req.side === 'sell' ? 'sell' : 'buy';
    const type = req.type || 'market';
    const qty = roundQty(Number(req.qty), sym.qStep);

    if (!(qty > 0)) return { ok: false, error: 'Enter a quantity.' };

    // Only read the fields this order type actually uses. Carrying a leftover
    // stop price onto a plain limit order would arm a phantom trigger and the
    // order would never fill.
    const usesLimit = type === 'limit' || type === 'stop-limit' || type === 'oco';
    const usesStop = type === 'stop-limit' || type === 'oco';
    const limitPrice = usesLimit && Number.isFinite(Number(req.limitPrice)) ? round(Number(req.limitPrice), sym.tick) : NaN;
    const stopPrice = usesStop && Number.isFinite(Number(req.stopPrice)) ? round(Number(req.stopPrice), sym.tick) : NaN;

    if (type === 'limit' && !(limitPrice > 0)) return { ok: false, error: 'Enter a limit price.' };
    if (type === 'stop-limit' && !(limitPrice > 0 && stopPrice > 0)) return { ok: false, error: 'Enter both stop and limit prices.' };
    if (type === 'trailing-stop' && !(Number(req.trailPct) > 0)) return { ok: false, error: 'Enter a trailing distance (%).' };
    if (type === 'oco' && !(limitPrice > 0 && stopPrice > 0)) return { ok: false, error: 'OCO needs a take-profit and a stop price.' };

    // Funding checks
    const refPrice = type === 'market' ? st.price : (limitPrice || stopPrice || st.price);
    if (side === 'buy') {
      const need = qty * refPrice * (1 + FEE_TAKER);
      if (need > buyingPower() + 1e-6) {
        return { ok: false, error: 'Insufficient buying power: need ' + fmt(need, 2) + ' ' + QUOTE + ', have ' + fmt(buyingPower(), 2) + '.' };
      }
    } else {
      const free = position(sym.id).qty - reservedQty(sym.id);
      if (qty > free + 1e-9) {
        return { ok: false, error: 'Insufficient ' + sym.id + ': ' + fmt(free, 4) + ' free (spot only, no shorting).' };
      }
    }

    const base = {
      id: account.seq++, symbol: sym.id, side: side, type: type,
      qty: qty, filled: 0, remaining: qty, avgFill: 0, fee: 0,
      status: 'open', placedAt: Date.now(), limitPrice: limitPrice, stopPrice: stopPrice
    };

    if (type === 'market') {
      base.status = 'open';
      account.orders.unshift(base);
      const r = executeMarket(base);
      if (!r.ok) {
        base.status = 'rejected';
        base.note = r.error;
        save();
        return r;
      }
      save();
      return { ok: true, order: base, message: 'Market ' + side + ' filled: ' + fmt(r.qty, 4) + ' ' + sym.id + ' @ ' + fmt(r.price, decimals(sym)) };
    }

    if (type === 'trailing-stop') {
      base.trailing = true;
      base.trailPct = Number(req.trailPct);
      base.peak = st.price;
      base.stopPrice = round(st.price * (side === 'sell' ? 1 - base.trailPct / 100 : 1 + base.trailPct / 100), sym.tick);
      base.limitPrice = base.stopPrice;
      base.queueAhead = 0;
    } else if (type === 'stop-limit') {
      setQueue(base, sym, side, limitPrice);
    } else if (type === 'oco') {
      // Two linked orders: a take-profit limit and a protective stop-limit.
      const ocoId = 'oco' + account.seq;
      const tp = setQueue(Object.assign({}, base, { id: account.seq++, type: 'limit', stopPrice: NaN, ocoId: ocoId }), sym, side, limitPrice);
      const sl = Object.assign({}, base, { id: account.seq++, type: 'stop-limit', limitPrice: stopPrice, stopPrice: stopPrice, ocoId: ocoId, queueAhead: 0 });
      account.orders.unshift(sl);
      account.orders.unshift(tp);
      save();
      return { ok: true, order: tp, message: 'OCO placed: take-profit ' + fmt(limitPrice, decimals(sym)) + ' / stop ' + fmt(stopPrice, decimals(sym)) };
    } else {
      setQueue(base, sym, side, limitPrice);
      // A limit order priced through the book crosses immediately as a taker.
      const crosses = side === 'buy' ? limitPrice >= st.price : limitPrice <= st.price;
      if (crosses) {
        account.orders.unshift(base);
        applyFill(base, base.remaining, limitPrice, 'taker');
        save();
        return { ok: true, order: base, message: 'Limit ' + side + ' crossed and filled @ ' + fmt(limitPrice, decimals(sym)) };
      }
    }

    account.orders.unshift(base);
    save();
    return {
      ok: true, order: base,
      message: (type === 'trailing-stop' ? 'Trailing stop' : type === 'stop-limit' ? 'Stop-limit' : 'Limit')
        + ' ' + side + ' resting · ' + fmt(base.queueAhead, 0) + ' ' + sym.id + ' ahead in queue'
    };
  }

  /* Size already resting at a price level = the queue this order must wait behind
   * under price-time priority. An order priced beyond the visible ladder has no
   * measurable queue; it is reported as such rather than pretending to be first. */
  function queueAt(sym, side, price) {
    const b = book(sym.id, 1, 14);
    const arr = side === 'buy' ? b.bids : b.asks;
    const lo = Math.min(arr[0].price, arr[arr.length - 1].price);
    const hi = Math.max(arr[0].price, arr[arr.length - 1].price);
    if (price < lo - sym.tick || price > hi + sym.tick) return { size: 0, outside: true };
    let bestD = Infinity, size = 0;
    for (let i = 0; i < arr.length; i++) {
      const d = Math.abs(arr[i].price - price);
      if (d < bestD) { bestD = d; size = arr[i].size; }
    }
    return { size: size, outside: false };
  }

  function setQueue(order, sym, side, price) {
    const q = queueAt(sym, side, price);
    order.queueAhead = q.size;
    order.outsideBook = q.outside;
    return order;
  }

  function cancelOrder(id) {
    const o = account.orders.find(function (x) { return x.id === id; });
    if (!o || o.status !== 'open') return { ok: false, error: 'Order is no longer open.' };
    o.status = 'cancelled';
    o.closedAt = Date.now();
    if (o.ocoId) cancelOco(o.ocoId, o.id);
    save();
    return { ok: true };
  }

  function cancelAll(symbol) {
    let n = 0;
    account.orders.forEach(function (o) {
      if (o.status === 'open' && (!symbol || o.symbol === symbol)) {
        o.status = 'cancelled'; o.closedAt = Date.now(); n++;
      }
    });
    if (n) save();
    return n;
  }

  // Flatten a position at market — the X button behaviour on the positions table.
  function closePosition(id) {
    const p = position(id);
    if (!p.qty) return { ok: false, error: 'No open position.' };
    cancelAll(id);
    return placeOrder({ symbol: id, side: p.qty > 0 ? 'sell' : 'buy', type: 'market', qty: Math.abs(p.qty) });
  }

  function resetAccount() {
    account.cash = 100000;
    account.positions = {};
    account.orders = [];
    account.fills = [];
    account.dayKey = '';
    account.dayBase = 0;
    account.seq = 1;
    rollDay();
    save();
  }

  // ───────────────────────────────── read APIs ────────────────────────────────

  const TF = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1D': 1440 };

  /* Aggregate bars for a timeframe. 1m/5m come from the 1-minute series; anything
   * 15m and above aggregates the 15m series. Because the 15m series was BUILT from
   * those same 1m sub-steps, every timeframe is mutually consistent. */
  function candles(id, tf, count) {
    const st = state(id);
    const mult = TF[tf] || 1;
    const src = mult < 15 ? st.bars1m : st.bars15m;
    const unit = (mult < 15 ? 1 : 15) * MIN;
    const group = Math.max(1, Math.round((mult * MIN) / unit));
    count = count || 180;

    const out = [];
    const span = mult * MIN;
    // Walk backwards so the newest bucket is always complete at the right edge.
    const need = count * group;
    const start = Math.max(0, src.length - need);
    for (let i = start; i < src.length; i++) {
      const b = src[i];
      const slot = Math.floor(b.t / span) * span;
      const last = out[out.length - 1];
      if (last && last.t === slot) {
        last.h = Math.max(last.h, b.h);
        last.l = Math.min(last.l, b.l);
        last.c = b.c;
        last.v += b.v;
      } else {
        out.push({ t: slot, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
      }
    }

    // Merge the still-forming minute into the newest bucket.
    if (st.live) {
      const slot = Math.floor(st.live.t / span) * span;
      const last = out[out.length - 1];
      if (last && last.t === slot) {
        last.h = Math.max(last.h, st.live.h);
        last.l = Math.min(last.l, st.live.l);
        last.c = st.live.c;
        last.v += st.live.v;
      } else {
        out.push({ t: slot, o: st.live.o, h: st.live.h, l: st.live.l, c: st.live.c, v: st.live.v });
      }
    }
    return out.slice(-count);
  }

  // 24h summary computed from the actual 1m series — not a decorative number.
  function ticker(id) {
    const st = state(id);
    const bars = st.bars1m;
    const cutoff = Date.now() - 24 * 3600 * 1000;
    let open = null, high = -Infinity, low = Infinity, vol = 0;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].t < cutoff) continue;
      if (open === null) open = bars[i].o;
      if (bars[i].h > high) high = bars[i].h;
      if (bars[i].l < low) low = bars[i].l;
      vol += bars[i].v;
    }
    if (open === null) { open = st.price; high = st.price; low = st.price; }
    if (st.live) { high = Math.max(high, st.live.h); low = Math.min(low, st.live.l); vol += st.live.v; }
    const price = st.price;
    return {
      symbol: id, name: st.sym.name, price: price, open: open,
      high: high, low: low, volume: vol,
      change: price - open,
      changePct: open ? ((price - open) / open) * 100 : 0,
      tick: st.sym.tick, decimals: decimals(st.sym), qStep: st.sym.qStep
    };
  }

  function tape(id, n) {
    const st = state(id);
    return st.tape.slice(-(n || 24)).reverse();
  }

  /* Upbit-style 체결강도 (buy pressure): taker-buy volume as a share of total over
   * the recent tape. 100 = balanced, >100 = buyers lifting offers. */
  function buyPressure(id) {
    const t = state(id).tape;
    let buy = 0, sell = 0;
    for (let i = Math.max(0, t.length - 40); i < t.length; i++) {
      if (t[i].side === 'buy') buy += t[i].qty; else sell += t[i].qty;
    }
    if (!sell) return buy ? 200 : 100;
    return Math.min(400, (buy / sell) * 100);
  }

  function news(id) {
    const st = state(id);
    return st.gen.events.slice(-8).reverse();
  }

  function decimals(sym) {
    const s = String(sym.tick);
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  }

  function fmt(v, d) {
    if (!Number.isFinite(v)) return '—';
    return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function tickAll() {
    const out = [];
    SYMBOLS.forEach(function (s) { if (cache[s.id]) { const f = advance(s.id); if (f && f.length) out.push.apply(out, f); } });
    if (out.length) save();
    return out;
  }

  global.MarketEngine = {
    SYMBOLS: SYMBOLS, QUOTE: QUOTE, FEE_MAKER: FEE_MAKER, FEE_TAKER: FEE_TAKER, TF: TF,
    symbolById: symbolById, decimals: decimals, fmt: fmt, round: round, roundQty: roundQty,
    init: loadAccount, state: state, advance: advance, tickAll: tickAll,
    candles: candles, ticker: ticker, book: book, tape: tape, buyPressure: buyPressure, news: news,
    lastPrice: lastPrice, portfolio: portfolio, position: position, buyingPower: buyingPower,
    reservedQty: reservedQty, equity: equity, unrealized: unrealized,
    placeOrder: placeOrder, cancelOrder: cancelOrder, cancelAll: cancelAll,
    closePosition: closePosition, resetAccount: resetAccount,
    account: account, save: save
  };

})(typeof window !== 'undefined' ? window : globalThis);
