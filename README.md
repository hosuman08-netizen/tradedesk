# TradeForge — Fictional Trade Simulation

A single-page web app (PWA) simulating a trade marketplace. Users post buy/sell
listings, browse live deals, negotiate by voice, and settle with in-app tokens.

> **Fictional & entertainment only.** No real goods, money, or investment are
> involved. Nothing in this app is financial advice or real trading. 18+.

## Features

- **Hot Deals** — browse live listings with real countdown timers.
- **Post Trade** — create a listing with a title, details, price, and currency
  (Credits or TFC). Optional voice pitch attaches a pitch score.
- **Voice Negotiate** — pitch a live deal by voice to earn a capped discount
  (max 15%, once per deal). A stronger pitch earns a bigger discount.
- **Journal** — a running log of your posts, negotiations, and closed deals.

## Currencies (in-app only)

- **Credits** and **TFC** — fictional in-app balances stored locally.
- A **reserve** pool can convert into Credits to cover a shortfall
  (rate: 0.8 Credits per reserve unit).

## Tech

- Static client-only app: `index.html`, `style.css`, `script.js`,
  `voice-pitch.js`. State persists in `localStorage`. No backend, no accounts,
  no real payments.
- `node --check script.js` must pass.

## Design

SENSE-aligned: one protagonist per screen, restrained gold accent, 8px grid,
generous whitespace. Displayed numbers match the underlying state exactly.
