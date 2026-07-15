// p13 TradeForge - Trade app. p6 Voice + p10 Credits + FOMO.
let wallet = null;
// Balances are the source of truth for every order. Persisted so the ledger
// stays accurate across reloads (was inert/reset before → balance desync bug).
let balance = loadNum('p13_balance', 1250);   // $EROS
let credits = loadNum('p13_credits', 450);    // Credits
let trades = JSON.parse(localStorage.getItem('p13_trades') || '[]');
let codex = JSON.parse(localStorage.getItem('p13_codex') || '[]');

function loadNum(key, fallback) {
  const v = parseFloat(localStorage.getItem(key));
  return Number.isFinite(v) ? v : fallback;
}

// Single writer for balances → never drift between memory and storage.
function saveBalances() {
  localStorage.setItem('p13_balance', String(balance));
  localStorage.setItem('p13_credits', String(credits));
}

function updateWallet() {
  const el = document.getElementById('wallet-info');
  if (el) el.innerHTML = `${wallet || '0xDemo'} • ${balance.toLocaleString()} $EROS / ${credits.toLocaleString()} Credits`;
}

function connectWallet() {
  wallet = '0x' + Math.random().toString(16).slice(2, 10);
  updateWallet();
}

function recordVoiceTrade() {
  const preview = document.getElementById('voice-preview');
  preview.innerHTML = 'Recording p6 Voice for trade (Lung Surprise Eye)...';

  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    const rec = new MediaRecorder(stream);
    let chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, {type:'audio/webm'});
      const url = URL.createObjectURL(blob);
      
      let surprise = 0.3;
      if (window.getP6LungSurprise) surprise = window.getP6LungSurprise();
      
      preview.innerHTML = `<audio controls src="${url}"></audio><br>Surprise: ${surprise.toFixed(2)} — Trade trust boosted!`;
      window._p13Voice = { url, surprise };
      stream.getTracks().forEach(t => t.stop());
    };
    rec.start();
    setTimeout(() => rec.stop(), 4000);
  }).catch(() => {
    preview.innerHTML = 'Voice fallback. Surprise 0.68';
    window._p13Voice = { surprise: 0.68 };
  });
}

function postTrade() {
  const title = document.getElementById('trade-title').value || 'Untitled Trade';
  const desc = document.getElementById('trade-desc').value || 'No details.';
  const price = Math.max(1, parseInt(document.getElementById('trade-price').value) || 1000);
  const curEl = document.getElementById('trade-currency');
  const currency = curEl && curEl.value === '$EROS' ? '$EROS' : 'Credits';
  const surprise = window._p13Voice ? window._p13Voice.surprise : 0.3;

  if (!wallet) {
    alert('Connect wallet (p10 credits).');
    return;
  }

  const trade = {
    id: Date.now(),
    title,
    desc,
    price,
    currency,
    seller: wallet,          // so a poster can't accept their own deal
    surprise,
    voiceUrl: window._p13Voice ? window._p13Voice.url : null,
    timestamp: new Date().toISOString(),
    expiry: Date.now() + 24 * 3600 * 1000,
    status: 'open',
    buyers: []
  };

  trades.unshift(trade);
  localStorage.setItem('p13_trades', JSON.stringify(trades));
  
  addToCodex(`Posted: ${title}. Voice surprise ${surprise}. FOMO active.`);

  // Honest confirmation: report the real live-deal count, not a fabricated number.
  const now = Date.now();
  const live = trades.filter(t => t.status === 'open' && (!t.expiry || t.expiry > now)).length;
  alert(`Trade posted! ${live} live deal${live === 1 ? '' : 's'} on the board now.`);
  document.getElementById('trade-title').value = '';
  document.getElementById('trade-desc').value = '';
  showFeed();
}

function showPost() {
  hideAll();
  document.getElementById('post').classList.remove('hidden');
  setActiveNav('post');
}

function showFeed() {
  hideAll();
  document.getElementById('feed').classList.remove('hidden');
  setActiveNav('feed');
  refreshFomoHeader();
  const list = document.getElementById('trade-list');
  list.innerHTML = '';
  
  if (trades.length === 0) {
    list.innerHTML = `<div class="empty">
      <div class="empty-mark">🜂</div>
      <p>No live deals yet.</p>
      <button class="primary" onclick="showPost()">Post the first trade</button>
    </div>`;
    return;
  }
  
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  trades.forEach(trade => {
    const closed = trade.status !== 'open';
    const leftSec = trade.expiry ? Math.max(0, Math.floor((trade.expiry - Date.now())/1000)) : 0;
    const expired = !closed && leftSec <= 0;
    const mins = Math.floor(leftSec / 60);
    const fomo = closed ? '✓ closed'
      : expired ? 'expired'
      : mins >= 60 ? `⏱ ${Math.floor(mins/60)}h ${mins%60}m left`
      : `⏱ ${mins}m left`;
    const fomoClass = (!closed && !expired && mins < 60) ? 'urgent' : '';
    const inactive = closed || expired;
    const currency = trade.currency || 'Credits';
    const desc = trade.desc.length > 80 ? esc(trade.desc.slice(0,80)).trimEnd() + '…' : esc(trade.desc);
    // Button label reflects real state: open→Accept, closed→Deal Closed, expired→Expired.
    const label = closed ? 'Deal Closed' : expired ? 'Expired' : 'Accept Deal';
    const el = document.createElement('div');
    el.className = 'trade-card' + (inactive ? ' expired' : '');
    el.innerHTML = `
      <div class="tc-head">
        <strong class="tc-title">${esc(trade.title)}</strong>
        <span class="tc-time ${fomoClass}">${fomo}</span>
      </div>
      <p class="tc-desc">${desc}</p>
      <div class="tc-meta">
        <span class="tc-price">${trade.negotiated ? `<s class="tc-was">${trade.origPrice.toLocaleString()}</s> ` : ''}${trade.price.toLocaleString()} <em>${esc(currency)}${trade.negotiated ? ` · −${trade.discountPct}%` : ''}</em></span>
        <span class="surprise">👁 ${trade.surprise.toFixed(2)}${trade.voiceUrl ? ' 🎙' : ''}</span>
      </div>
      <button class="primary" onclick="acceptTrade(${trade.id})"${inactive ? ' disabled' : ''}>${label}</button>
      <button class="ghost" onclick="birthTradeArtifact(${trade.id})">Birth Artifact → p17/p10</button>
    `;
    list.appendChild(el);
  });
}

// Real order settlement: validate → deduct the exact currency → close the deal.
// Every branch returns before mutating so balances can never drift on a failed order.
function acceptTrade(id) {
  const trade = trades.find(t => t.id === id);
  if (!trade) return;
  if (!wallet) { alert('Connect wallet first.'); return; }

  // Deal is one-shot: once closed it stays closed (was re-acceptable → double-spend).
  if (trade.status !== 'open') { alert('This deal is already closed.'); return; }
  if (trade.expiry && trade.expiry <= Date.now()) { alert('This deal has expired.'); return; }
  if (trade.seller && trade.seller === wallet) { alert("You can't accept your own trade."); return; }

  const cost = trade.price;
  const currency = trade.currency || 'Credits';
  const isEros = currency === '$EROS';
  const have = isEros ? balance : credits;

  // Insufficient funds → optional p10 bridge (Credits only). No silent overspend.
  if (have < cost) {
    const short = cost - have;
    if (isEros) {
      alert(`Need ${short.toLocaleString()} more $EROS. Balance unchanged.`);
      return;
    }
    if (!confirm(`Short ${short.toLocaleString()} Credits. Bridge from p10 Stable?`)) return;
    if (!bridgeCreditsFromP10(short)) return;   // tops up exactly the shortfall, or aborts
    if (credits < cost) { alert('Bridge fell short. Order cancelled, balances unchanged.'); return; }
  }

  // Settle: atomic single deduction, persisted immediately.
  if (isEros) balance -= cost; else credits -= cost;
  saveBalances();

  trade.status = 'accepted';
  trade.closedAt = Date.now();
  trade.buyer = wallet;
  if (!trade.buyers.includes(wallet)) trade.buyers.push(wallet);
  localStorage.setItem('p13_trades', JSON.stringify(trades));

  addToCodex(`Closed "${trade.title}" −${cost.toLocaleString()} ${currency}. Balance now ${(isEros?balance:credits).toLocaleString()} ${currency}.`);

  updateWallet();
  showFeed();
  alert(`Deal closed! −${cost.toLocaleString()} ${currency}. Birth an artifact to cross p17.`);
}

function showVoice() {
  hideAll();
  document.getElementById('voice').classList.remove('hidden');
  setActiveNav('voice');
  populateNegotiateTargets();
}

// Fill the negotiate picker with live, open deals (real state, not placeholders).
function populateNegotiateTargets() {
  const sel = document.getElementById('negotiate-target');
  if (!sel) return;
  const now = Date.now();
  const open = trades.filter(t => t.status === 'open' && (!t.expiry || t.expiry > now));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  if (open.length === 0) {
    sel.innerHTML = '<option value="">No live deals to negotiate</option>';
    return;
  }
  sel.innerHTML = open.map(t => {
    const cur = t.currency || 'Credits';
    const neg = t.negotiated ? ' (already −' + t.discountPct + '%)' : '';
    return `<option value="${t.id}">${esc(t.title)} — ${t.price.toLocaleString()} ${esc(cur)}${neg}</option>`;
  }).join('');
}

// Max discount a single voice negotiation can win, and floor per trade.
const NEGOTIATE_MAX_PCT = 15;   // capped so numbers stay honest (no fake 90%-off)

// Real effect: convert a measured surprise (0..1) into a bounded discount and
// apply it to the actual trade price. Persists, one negotiation per deal.
// Returns a result object the UI renders — the price change is genuine.
function applyNegotiationDiscount(tradeId, surprise) {
  const trade = trades.find(t => t.id === tradeId);
  if (!trade) return { ok: false, reason: 'Deal not found.' };
  if (trade.status !== 'open') return { ok: false, reason: 'Deal already closed.' };
  if (trade.expiry && trade.expiry <= Date.now()) return { ok: false, reason: 'Deal expired.' };
  if (trade.negotiated) return { ok: false, reason: `Already negotiated (−${trade.discountPct}%).`, trade };
  if (trade.seller && trade.seller === wallet) return { ok: false, reason: "Can't negotiate your own deal." };

  const s = Math.max(0, Math.min(1, surprise));
  const pct = Math.round(s * NEGOTIATE_MAX_PCT);           // 0..15, honest mapping
  if (pct <= 0) return { ok: false, reason: 'Pitch too flat — no discount. Try again.', trade };

  const original = trade.origPrice || trade.price;
  const newPrice = Math.max(1, Math.round(original * (1 - pct / 100)));
  trade.origPrice = original;
  trade.price = newPrice;
  trade.discountPct = pct;
  trade.negotiated = true;
  localStorage.setItem('p13_trades', JSON.stringify(trades));

  addToCodex(`Negotiated "${trade.title}": ${original.toLocaleString()} → ${newPrice.toLocaleString()} ${trade.currency || 'Credits'} (−${pct}%, surprise ${s.toFixed(2)}).`);
  return { ok: true, pct, original, newPrice, trade };
}

function renderNegotiation(result, res, surprise, audioUrl) {
  const audio = audioUrl ? `<audio controls src="${audioUrl}"></audio><br>` : '';
  if (!res.ok) {
    result.innerHTML = `${audio}Surprise ${surprise.toFixed(2)}. ${res.reason}`;
    return;
  }
  const cur = (res.trade.currency || 'Credits');
  result.innerHTML = `${audio}Surprise ${surprise.toFixed(2)} → <strong>−${res.pct}%</strong>. `
    + `${res.original.toLocaleString()} → <strong>${res.newPrice.toLocaleString()} ${cur}</strong>. Locked in.`;
  populateNegotiateTargets();
}

function startVoiceNegotiation() {
  const result = document.getElementById('negotiation-result');
  const sel = document.getElementById('negotiate-target');
  const tradeId = sel ? parseInt(sel.value) : NaN;
  if (!wallet) { result.innerHTML = 'Connect wallet to negotiate.'; return; }
  if (!Number.isFinite(tradeId)) { result.innerHTML = 'Pick a live deal first.'; return; }
  result.innerHTML = 'p6 Voice negotiation started... speak your pitch.';

  const finish = (surprise, url) => {
    const res = applyNegotiationDiscount(tradeId, surprise);
    renderNegotiation(result, res, surprise, url);
  };

  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    const rec = new MediaRecorder(stream);
    let chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, {type:'audio/webm'});
      const url = URL.createObjectURL(blob);
      let surprise = 0.3;
      if (window.getP6LungSurprise) surprise = window.getP6LungSurprise();
      finish(surprise, url);
      stream.getTracks().forEach(t => t.stop());
    };
    rec.start();
    setTimeout(() => rec.stop(), 5000);
  }).catch(() => {
    // No mic: still a real (fallback) surprise value drives a real discount.
    let surprise = 0.5;
    if (window.getP6LungSurprise) { const s = window.getP6LungSurprise(); if (s > 0) surprise = s; }
    finish(surprise, null);
  });
}

function showCodex() {
  hideAll();
  document.getElementById('codex').classList.remove('hidden');
  setActiveNav('codex');
  const list = document.getElementById('codex-list');
  list.innerHTML = '<h3>Trade Codex (ALWAYS LEARNING + p6 spores)</h3>';
  
  if (codex.length === 0) {
    list.innerHTML += '<p>Post or accept trades to build codex.</p>';
    return;
  }
  
  codex.slice(0,8).forEach(c => {
    const div = document.createElement('div');
    div.className = 'notebook-entry';
    div.innerHTML = `<small>${new Date(c.time).toLocaleString()}</small><br>${c.note}`;
    list.appendChild(div);
  });
}

function addToCodex(note) {
  codex.unshift({ time: Date.now(), note });
  if (codex.length > 20) codex.pop();
  localStorage.setItem('p13_codex', JSON.stringify(codex));
}

function hideAll() {
  document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
}

// One protagonist per screen: highlight the active nav button (SENSE 시선 순서).
function setActiveNav(view) {
  document.querySelectorAll('.nav button').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
  });
}

// Honest FOMO header: numbers reflect real trade state (code-display 100% match).
function refreshFomoHeader() {
  const el = document.getElementById('fomo-header');
  if (!el) return;
  const now = Date.now();
  const active = trades.filter(t => t.status === 'open' && (!t.expiry || t.expiry > now)).length;
  const soon = trades.filter(t => t.status === 'open' && t.expiry && t.expiry > now && (t.expiry - now) < 3600 * 1000).length;
  el.textContent = soon > 0
    ? `🔥 ${active} active • ${soon} expiring within 1h`
    : `🔥 ${active} active`;
}

function initP13() {
  updateWallet();
  
  // Seed demo trades
  if (trades.length === 0) {
    trades = [
      { id: 1, title: "Coffee Beans Bulk", desc: "From Colombia, 10 tons.", price: 300, currency: 'Credits', seller: '0xSeedA', surprise: 0.68, voiceUrl: null, timestamp: new Date().toISOString(), status: 'open', buyers: [], expiry: Date.now() + 3600*1000 },
      { id: 2, title: "Electronics Components", desc: "Asia supplier.", price: 800, currency: '$EROS', seller: '0xSeedB', surprise: 0.55, voiceUrl: null, timestamp: new Date().toISOString(), status: 'open', buyers: [], expiry: Date.now() + 7200*1000 }
    ];
    localStorage.setItem('p13_trades', JSON.stringify(trades));
  }
  
  // p6 cross
  if (window.getP6LungSurprise) {
    console.log('[p13] p6 Lung Surprise Eye ready for negotiations.');
  }
  
  // Real FOMO timer (deficiency fix)
  setInterval(() => {
    const now = Date.now();
    trades.forEach(t => {
      if (t.expiry && t.status === 'open') {
        const left = Math.max(0, Math.floor((t.expiry - now)/1000));
        if (left < 60 && left > 0) console.log(`[FOMO] Trade ${t.id} expires in ${left}s`);
      }
    });
    // live update feed if visible
    const feed = document.getElementById('feed');
    if (feed && !feed.classList.contains('hidden')) showFeed();
  }, 30000);

  // Default view = Hot Deals (the hook), single-view discipline
  showFeed();
}

// Births: p13 -> cross birth artifact (feeds p17 wallet or p14)
function birthTradeArtifact(tradeId) {
  const trade = trades.find(t=>t.id===tradeId);
  if (!trade) return;
  const artifact = { id: 'art'+Date.now(), from:'p13', title: trade.title, value: Math.floor(trade.price*0.1), surprise: trade.surprise, ts: Date.now() };
  let arts = JSON.parse(localStorage.getItem('legion_birth_artifacts')||'[]');
  arts.unshift(artifact);
  localStorage.setItem('legion_birth_artifacts', JSON.stringify(arts.slice(0,10)));
  // p10 integration: credit graft
  let p10b = parseFloat(localStorage.getItem('p10_balance')||'1284.7');
  localStorage.setItem('p10_balance', (p10b + 12).toFixed(2));
  addToCodex(`BIRTH: Trade Artifact ${trade.title} spawned. +12 p10 graft.`);
  alert('Birth: Trade Artifact born! Cross to p17 wallet + p10 boost.');
}

// Cross-bridge: top up exactly `need` Credits from p10 Stable.
// Rate: 1 Credit costs 1.25 p10 (0.8 Credits per p10). Charges the real p10 cost
// for the exact shortfall — no rounding slippage, no over/under-crediting.
function bridgeCreditsFromP10(need) {
  const RATE = 0.8;                         // Credits received per p10 spent
  const p10Cost = Math.ceil(need / RATE);   // p10 to spend to cover `need` Credits
  const p10b = parseFloat(localStorage.getItem('p10_balance') || '1284.7');
  if (p10b < p10Cost) {
    alert(`p10 Stable short: need ${p10Cost} p10 (have ${p10b.toFixed(2)}).`);
    return false;
  }
  localStorage.setItem('p10_balance', (p10b - p10Cost).toFixed(2));
  credits += need;                          // deliver exactly the shortfall
  saveBalances();
  updateWallet();
  addToCodex(`Bridged ${need.toLocaleString()} Credits from p10 (−${p10Cost} p10).`);
  return true;
}

function showCrossNav() {
  const nav = document.createElement('div');
  nav.className = 'cross-nav';
  nav.innerHTML = `<button onclick="window.open('../p17-coin-wallet-app/index.html','_blank')">p17 Wallet</button>
  <button onclick="window.open('../p10-stable-fee-app/index.html','_blank')">p10 Stable</button>
  <button onclick="window.open('../p20-saju-miniapp/index.html','_blank')">p20 Saju</button>
  <button onclick="window.open('../p14-construction-app/index.html','_blank')">p14 Build</button>`;
  document.body.appendChild(nav);
}

window.onload = () => { initP13(); showCrossNav(); };
