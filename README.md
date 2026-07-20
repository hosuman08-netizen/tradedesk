# TradeForge — Fictional Trading Simulation

A single-page web app (PWA) with two halves: a **paper trading terminal**
(candles, order book, matching engine, P&L) and the original **P2P deal board**
(post a listing, negotiate by voice). Both share one wallet.

> **Fictional & entertainment only.** No real goods, money, or investment are
> involved. Every symbol is an invented in-app unit — no real tickers, no fiat.
> Nothing in this app is financial advice or real trading. 18+.

## Terminal

- **Candle chart** — OHLC candles over a volume histogram, 1m/5m/15m/1h/4h/1D,
  crosshair with OHLC readout, wheel zoom, drag pan. Your average entry and every
  resting order are drawn as price lines. Rendered on canvas, no chart library.
- **Order book** — cumulative-depth ladder with price grouping (1× / 5× / 20×),
  spread readout, your own resting size marked, plus a depth chart and an
  Upbit-style buy-pressure meter.
- **Order types** — market, limit, stop-limit, trailing stop, and OCO.
- **Order ticket** — buying power, 25/50/75/100% sizing slider, live order total
  and maker/taker fee estimate.
- **Blotter** — Open orders / Positions / Trades / Order history kept separate,
  with cancel and one-click close-at-market.
- **Market trades tape** and a shock rail explaining each jump in the price path.

## How the simulation works

Prices are a **pure function of wall-clock time**, so reloading resumes the same
market rather than rerolling it:

- seeded log-return random walk with an Ornstein–Uhlenbeck pull toward a drifting
  anchor (prevents runaway paths)
- **GARCH(1,1)** conditional variance → genuine volatility clustering
- Poisson jump process → news shocks, surfaced in the shock rail
- AR(1) volume coupled to |return| → volume autocorrelation
- 1-minute bars are generated as sub-steps of each 15-minute bar, so **1m
  aggregates exactly into 5m/15m/1h/4h/1D** — no per-timeframe fakery
- within a minute the tick path is a **Brownian bridge** pinned to the canonical
  bar, so a tab open for hours never drifts off the path a fresh load computes
  (verified: zero price drift after 3 simulated hours)

**Matching** is price-time priority against the simulated tape. Each resting
order carries a queue position; prints burn through the queue first, and fill
size is `min(print size, order remaining)` — so **partial fills emerge naturally**
rather than being special-cased. Fees are 0.02% maker / 0.06% taker.

**P&L** is average-entry based. Buying re-averages the entry price (weighted
average); selling realizes `(exit − avgEntry) × qty − fee` against it. Unrealized
P&L moves equity only; **only realized P&L settles into cash**, and fees are
charged to realized, never to unrealized.

## Deal board (original)

- **Hot Deals** — live listings with real countdown timers.
- **Post Trade** — title, details, price, currency; an optional voice pitch
  attaches a pitch score.
- **Voice Negotiate** — pitch a live deal by voice for a capped discount
  (max 15%, once per deal). A stronger pitch earns a bigger discount.
- **Journal** — a running log of posts, negotiations, and closed deals.

## Currencies (in-app only)

- **CR (Credits)** — the terminal's quote currency and the deal board's balance.
- **TFC** and the other listed symbols — spot positions in the terminal.
- A one-time paper account of 100,000 CR is granted on first run and can be reset.

## Tech

Static client-only app. No backend, no accounts, no real payments; state lives in
`localStorage`.

| File | Role |
|---|---|
| `market-engine.js` | price simulation, order book, matching engine, portfolio/P&L |
| `chart.js` | canvas candlestick, depth chart, sparklines |
| `terminal.js` | terminal UI wiring |
| `script.js` | deal board + view routing + shared wallet |
| `voice-pitch.js` | voice pitch scoring |

`./verify.sh` must pass (syntax gate, runtime crash gate, share-attribution audit).

## Design

SENSE-aligned: restrained gold shell, 8px grid, one protagonist per surface,
motion only where it reports state. Green/red are reserved exclusively for
direction and never carry meaning alone — an arrow glyph always rides along, so
the UI stays readable for colour-blind users. Displayed numbers match the
underlying state exactly.
