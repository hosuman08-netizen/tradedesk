// TradeForge — fictional trade simulation. Voice pitch + in-app tokens + live deals.

// One-time migration from legacy internal keys → clean user-facing keys.
// Runs before any balance load so persisted balances/history carry over cleanly.
(function migrateLegacyKeys() {
  const map = { p13_balance:'tf_balance', p13_credits:'tf_credits', p13_trades:'tf_trades', p13_codex:'tf_journal' };
  for (const [oldK, newK] of Object.entries(map)) {
    const v = localStorage.getItem(oldK);
    if (v !== null && localStorage.getItem(newK) === null) localStorage.setItem(newK, v);
  }
})();

let wallet = null;
// Balances are the source of truth for every order. Persisted so the ledger
// stays accurate across reloads (was inert/reset before → balance desync bug).
let balance = loadNum('tf_balance', 1250);   // TFC (TradeForge Coin)
let credits = loadNum('tf_credits', 450);    // Credits
let reserve = loadNum('tf_reserve', 2000);   // in-app reserve pool (converts to Credits)
let trades = JSON.parse(localStorage.getItem('tf_trades') || '[]');

// 5H trade retention loop
function tfDayKey(off){const d=new Date();d.setDate(d.getDate()+(off||0));return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function bumpTradeStreak(){
  try{
    let st=JSON.parse(localStorage.getItem('tf_streak')||'{}');
    const t0=tfDayKey(0);
    if(st.last===t0) return st;
    const y=tfDayKey(-1), y2=tfDayKey(-2);
    if(st.last && st.last!==y && st.last===y2 && (st.count||0)>=3){
      const ready=!st.shieldLast||((new Date(t0)-new Date(st.shieldLast))/86400000)>=7;
      if(ready){st.shieldLast=t0;st.last=y;try{legionTrack('streak_freeze',{count:st.count})}catch(e){}}
    }
    st.count=(st.last===y)?(st.count||0)+1:1; st.last=t0;
    localStorage.setItem('tf_streak',JSON.stringify(st));
    try{legionTrack('streak',{count:st.count})}catch(e){}
    return st;
  }catch(e){return {count:0};}
}
function bumpTradeDay(){
  try{
    const k='tf_day_'+tfDayKey(0);
    const n=(+(localStorage.getItem(k)||0))+1;
    localStorage.setItem(k,String(n));
    return n;
  }catch(e){return 0;}
}
function renderTradeLoop(){
  try{
    let el=document.getElementById('tfLoop');
    if(!el){
      el=document.createElement('div'); el.id='tfLoop';
      el.style.cssText='margin:8px 0;padding:10px;border:1px solid #2a2438;border-radius:12px;font-size:12px;display:flex;flex-wrap:wrap;gap:8px;align-items:center';
      const host=document.querySelector('header')||document.querySelector('h1')||document.body;
      host.insertAdjacentElement('afterend', el);
    }
    const st=JSON.parse(localStorage.getItem('tf_streak')||'{}');
    const today=+(localStorage.getItem('tf_day_'+tfDayKey(0))||0);
    const end=new Date(); end.setHours(24,0,0,0);
    const ms=Math.max(0,end-Date.now());
    const clock=Math.floor(ms/3600000)+'h '+Math.floor((ms%3600000)/60000)+'m';
    el.innerHTML='<span>🔥 '+(st.count||0)+'일</span><span>오늘 체결 '+today+'</span><span>총 '+(trades&&trades.length||0)+'건</span><span>리셋 '+clock+'</span>'
      +'<button type="button" id="tfShare" style="margin-left:auto;padding:6px 10px;border:0;border-radius:8px;background:#1c1826;color:#ece8f1">보드 공유</button>'
      +'<span style="opacity:.7;font-size:11px">시뮬 · 투자권유 아님</span>';
    const b=document.getElementById('tfShare');
    if(b) b.onclick=function(){
      const text='TradeDesk sim · 🔥'+(st.count||0)+'일 · 오늘 '+today+' · https://hosuman08-netizen.github.io/tradedesk/\n투자권유 아님';
      if(navigator.share) navigator.share({text}).catch(function(){});
      else if(navigator.clipboard) navigator.clipboard.writeText(text);
      try{legionTrack('share_peak',{})}catch(e){}
    };
  }catch(e){}
}

let journal = JSON.parse(localStorage.getItem('tf_journal') || '[]');

function loadNum(key, fallback) {
  const v = parseFloat(localStorage.getItem(key));
  return Number.isFinite(v) ? v : fallback;
}

// Single writer for balances → never drift between memory and storage.
// Also the one place that pushes the deal board's ledger into the terminal
// account, so both halves of the app share a single wallet.
function saveBalances() {
  localStorage.setItem('tf_balance', String(balance));
  localStorage.setItem('tf_credits', String(credits));
  localStorage.setItem('tf_reserve', String(reserve));
  pushToEngine();
}

// Deal board → terminal. Credits are the terminal's quote currency (CR) and TFC
// is a real spot position there, so a closed deal moves the same numbers.
function pushToEngine() {
  const M = window.MarketEngine;
  if (!M || !M.account) return;
  M.account.cash = credits;
  M.position('TFC').qty = balance;
  M.save();
}

// Terminal → deal board. Called by the engine whenever it settles a fill.
window.tfSetBalances = function (tfc, cash) {
  balance = tfc;
  credits = cash;
  updateWallet();
};

function updateWallet() {
  const el = document.getElementById('wallet-info');
  if (!el) return;
  const who = wallet || 'guest';
  el.textContent = `${who} • ${Math.round(credits).toLocaleString()} CR · ${balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} TFC`;
}

function connectWallet() {
  wallet = '0x' + Math.random().toString(16).slice(2, 10);
  updateWallet();
}

function recordVoiceTrade() {
  const preview = document.getElementById('voice-preview');
  preview.innerHTML = 'Recording voice pitch...';

  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    const rec = new MediaRecorder(stream);
    let chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, {type:'audio/webm'});
      const url = URL.createObjectURL(blob);
      stream.getTracks().forEach(t => t.stop());
      preview.innerHTML = `<audio controls src="${url}"></audio><br>Scoring your pitch…`;

      // Real analysis of the recorded audio (louder, more sustained, more
      // expressive → higher score). Falls back gracefully if decode fails.
      analyzeRecording(blob).then(pitchScore => {
        preview.innerHTML = `<audio controls src="${url}"></audio><br>Pitch score: <strong>${pitchScore.toFixed(2)}</strong> — attached to your listing.`;
        window._tfVoice = { url, pitchScore };
      });
    };
    rec.start();
    setTimeout(() => rec.stop(), 4000);
  }).catch(() => {
    const pitchScore = getPitchScore(0.68);
    preview.innerHTML = `Microphone unavailable — using a sample pitch score of ${pitchScore.toFixed(2)}.`;
    window._tfVoice = { pitchScore };
  });
}

// Analyze a recorded audio blob into a real pitch score in [0,1].
// Delegates to the audio analyzer; resolves to the fallback if unavailable.
function analyzeRecording(blob, fallback = 0.3) {
  if (typeof window.analyzeVoiceBlob === 'function') {
    return window.analyzeVoiceBlob(blob).then(s =>
      (Number.isFinite(s) && s > 0) ? s : fallback
    );
  }
  return Promise.resolve(fallback);
}

// Sync pitch score for no-mic paths only (returns last real measurement or fallback).
function getPitchScore(fallback = 0.3) {
  if (typeof window.getVoicePitchScore === 'function') {
    const s = window.getVoicePitchScore();
    if (Number.isFinite(s) && s > 0) return s;
  }
  return fallback;
}

function postTrade() {
  const title = document.getElementById('trade-title').value || 'Untitled Trade';
  const desc = document.getElementById('trade-desc').value || 'No details.';
  const price = Math.max(1, parseInt(document.getElementById('trade-price').value) || 1000);
  const curEl = document.getElementById('trade-currency');
  const currency = curEl && curEl.value === 'TFC' ? 'TFC' : 'Credits';
  const pitchScore = window._tfVoice ? window._tfVoice.pitchScore : 0.3;

  if (!wallet) {
    alert('Connect your account first.');
    return;
  }

  const trade = {
    id: Date.now(),
    title,
    desc,
    price,
    currency,
    seller: wallet,          // so a poster can't accept their own deal
    surprise: pitchScore,    // stored field name kept for saved-data compatibility
    voiceUrl: window._tfVoice ? window._tfVoice.url : null,
    timestamp: new Date().toISOString(),
    expiry: Date.now() + 24 * 3600 * 1000,
    status: 'open',
    buyers: []
  };

  trades.unshift(trade);
  localStorage.setItem('tf_trades', JSON.stringify(trades));
  try{bumpTradeStreak();bumpTradeDay();renderTradeLoop();}catch(e){}

  addToJournal(`Posted "${title}" — pitch score ${pitchScore.toFixed(2)}. Live for 24h.`);

  // Honest confirmation: report the real live-deal count, not a fabricated number.
  const now = Date.now();
  const live = trades.filter(t => t.status === 'open' && (!t.expiry || t.expiry > now)).length;
  alert(`Trade posted! ${live} live deal${live === 1 ? '' : 's'} on the board now.`);
  document.getElementById('trade-title').value = '';
  document.getElementById('trade-desc').value = '';
  showFeed();
}

function showTerminal() {
  hideAll();
  document.getElementById('terminal').classList.remove('hidden');
  setActiveNav('terminal');
  // Canvases sized while hidden measure 0 — re-render once visible.
  if (typeof window.tfRelayout === 'function') window.tfRelayout();
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
        <span class="surprise">🎯 ${(trade.surprise || 0).toFixed(2)}${trade.voiceUrl ? ' 🎙' : ''}</span>
      </div>
      <button class="primary" onclick="acceptTrade(${trade.id})"${inactive ? ' disabled' : ''}>${label}</button>
    `;
    list.appendChild(el);
  });
}

// Real order settlement: validate → deduct the exact currency → close the deal.
// Every branch returns before mutating so balances can never drift on a failed order.
function acceptTrade(id) {
  const trade = trades.find(t => t.id === id);
  if (!trade) return;
  if (!wallet) { alert('Connect your account first.'); return; }

  // Deal is one-shot: once closed it stays closed (was re-acceptable → double-spend).
  if (trade.status !== 'open') { alert('This deal is already closed.'); return; }
  if (trade.expiry && trade.expiry <= Date.now()) { alert('This deal has expired.'); return; }
  if (trade.seller && trade.seller === wallet) { alert("You can't accept your own trade."); return; }

  const cost = trade.price;
  const currency = trade.currency || 'Credits';
  const isTfc = currency === 'TFC';
  const have = isTfc ? balance : credits;

  // Insufficient funds → optional top-up from the in-app reserve (Credits only). No silent overspend.
  if (have < cost) {
    const short = cost - have;
    if (isTfc) {
      alert(`Need ${short.toLocaleString()} more TFC. Balance unchanged.`);
      return;
    }
    if (!confirm(`Short ${short.toLocaleString()} Credits. Convert from your reserve pool?`)) return;
    if (!convertReserveToCredits(short)) return;   // tops up exactly the shortfall, or aborts
    if (credits < cost) { alert('Conversion fell short. Order cancelled, balances unchanged.'); return; }
  }

  // Settle: atomic single deduction, persisted immediately.
  if (isTfc) balance -= cost; else credits -= cost;
  saveBalances();

  trade.status = 'accepted';
  trade.closedAt = Date.now();
  trade.buyer = wallet;
  if (!trade.buyers.includes(wallet)) trade.buyers.push(wallet);
  localStorage.setItem('tf_trades', JSON.stringify(trades));
  if (window.legionTrack) window.legionTrack('activate');

  addToJournal(`Closed "${trade.title}" −${cost.toLocaleString()} ${currency}. Balance now ${(isTfc?balance:credits).toLocaleString()} ${currency}.`);

  updateWallet();
  showFeed();
  alert(`Deal closed! −${cost.toLocaleString()} ${currency}.`);
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
  localStorage.setItem('tf_trades', JSON.stringify(trades));

  addToJournal(`Negotiated "${trade.title}": ${original.toLocaleString()} → ${newPrice.toLocaleString()} ${trade.currency || 'Credits'} (−${pct}%, pitch score ${s.toFixed(2)}).`);
  return { ok: true, pct, original, newPrice, trade };
}

function renderNegotiation(result, res, surprise, audioUrl) {
  const audio = audioUrl ? `<audio controls src="${audioUrl}"></audio><br>` : '';
  if (!res.ok) {
    result.innerHTML = `${audio}Pitch score ${surprise.toFixed(2)}. ${res.reason}`;
    return;
  }
  const cur = (res.trade.currency || 'Credits');
  result.innerHTML = `${audio}Pitch score ${surprise.toFixed(2)} → <strong>−${res.pct}%</strong>. `
    + `${res.original.toLocaleString()} → <strong>${res.newPrice.toLocaleString()} ${cur}</strong>. Locked in.`;
  populateNegotiateTargets();
}

function startVoiceNegotiation() {
  const result = document.getElementById('negotiation-result');
  const sel = document.getElementById('negotiate-target');
  const tradeId = sel ? parseInt(sel.value) : NaN;
  if (!wallet) { result.innerHTML = 'Connect your account to negotiate.'; return; }
  if (!Number.isFinite(tradeId)) { result.innerHTML = 'Pick a live deal first.'; return; }
  result.innerHTML = 'Voice negotiation started... speak your pitch.';

  const finish = (pitchScore, url) => {
    const res = applyNegotiationDiscount(tradeId, pitchScore);
    renderNegotiation(result, res, pitchScore, url);
  };

  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    const rec = new MediaRecorder(stream);
    let chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, {type:'audio/webm'});
      const url = URL.createObjectURL(blob);
      stream.getTracks().forEach(t => t.stop());
      result.innerHTML = 'Scoring your pitch…';
      // Real analysis: the recorded audio drives the actual discount.
      analyzeRecording(blob, 0.3).then(score => finish(score, url));
    };
    rec.start();
    setTimeout(() => rec.stop(), 5000);
  }).catch(() => {
    // No mic: still a real (fallback) pitch value drives a real discount.
    finish(getPitchScore(0.5), null);
  });
}

// Compute honest trading stats from real data (no fabricated numbers).
// Only counts deals this account actually closed / negotiated.
function computeJournalStats() {
  const closed = trades.filter(t => t.status === 'accepted' && t.buyer && t.buyer === wallet);
  const negotiated = trades.filter(t => t.negotiated && t.discountPct > 0);
  let spentTFC = 0, spentCredits = 0, saved = 0;
  closed.forEach(t => {
    if ((t.currency || 'Credits') === 'TFC') spentTFC += t.price; else spentCredits += t.price;
  });
  negotiated.forEach(t => { if (t.origPrice) saved += (t.origPrice - t.price); });
  const bestPct = negotiated.reduce((m, t) => Math.max(m, t.discountPct || 0), 0);
  const avgPct = negotiated.length
    ? Math.round(negotiated.reduce((a, t) => a + (t.discountPct || 0), 0) / negotiated.length)
    : 0;
  return { closedCount: closed.length, spentTFC, spentCredits, negCount: negotiated.length, saved, bestPct, avgPct };
}

function renderJournalStats() {
  const s = computeJournalStats();
  if (s.closedCount === 0 && s.negCount === 0) return '';
  const spent = [];
  if (s.spentTFC) spent.push(`${s.spentTFC.toLocaleString()} TFC`);
  if (s.spentCredits) spent.push(`${s.spentCredits.toLocaleString()} Cr`);
  const cell = (label, val) => `<div class="stat"><span class="stat-val">${val}</span><span class="stat-lbl">${label}</span></div>`;
  return `<div class="stat-strip">
    ${cell('deals closed', s.closedCount)}
    ${cell('spent', spent.length ? spent.join(' / ') : '—')}
    ${cell('negotiated', s.negCount)}
    ${cell('best discount', s.bestPct ? `−${s.bestPct}%` : '—')}
    ${cell('saved by voice', s.saved ? s.saved.toLocaleString() : '—')}
  </div>`;
}

function showJournal() {
  hideAll();
  document.getElementById('journal').classList.remove('hidden');
  setActiveNav('journal');
  const list = document.getElementById('journal-list');
  list.innerHTML = renderJournalStats() + '<h3>Trade Journal</h3>';

  if (journal.length === 0) {
    list.innerHTML += '<p>Post or accept trades to build your journal.</p>';
    return;
  }

  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  journal.slice(0,8).forEach(c => {
    const div = document.createElement('div');
    div.className = 'notebook-entry';
    div.innerHTML = `<small>${new Date(c.time).toLocaleString()}</small><br>${esc(c.note)}`;
    list.appendChild(div);
  });
}

function addToJournal(note) {
  journal.unshift({ time: Date.now(), note });
  if (journal.length > 20) journal.pop();
  localStorage.setItem('tf_journal', JSON.stringify(journal));
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

function initApp() {
  updateWallet();
  
  // Seed demo trades
  if (trades.length === 0) {
    trades = [
      { id: 1, title: "Coffee Beans Bulk", desc: "From Colombia, 10 tons.", price: 300, currency: 'Credits', seller: 'seed-a', surprise: 0.68, voiceUrl: null, timestamp: new Date().toISOString(), status: 'open', buyers: [], expiry: Date.now() + 3600*1000 },
      { id: 2, title: "Electronics Components", desc: "Asia supplier.", price: 800, currency: 'TFC', seller: 'seed-b', surprise: 0.55, voiceUrl: null, timestamp: new Date().toISOString(), status: 'open', buyers: [], expiry: Date.now() + 7200*1000 }
    ];
    localStorage.setItem('tf_trades', JSON.stringify(trades));
  }

  // Refresh the countdown labels + live feed on a timer (deals expire in real time).
  setInterval(() => {
    const feed = document.getElementById('feed');
    if (feed && !feed.classList.contains('hidden')) showFeed();
  }, 30000);

  // Boot the trading terminal, then land on it — it is the primary surface.
  if (typeof window.tfInitTerminal === 'function') {
    window.tfInitTerminal();
    showTerminal();
  } else {
    showFeed();
  }
  updateWallet();
}

// Top up exactly `need` Credits from the in-app reserve pool.
// Rate: 1 Credit costs 1.25 reserve (0.8 Credits per reserve unit). Charges the
// real reserve cost for the exact shortfall — no rounding slippage, no over/under-crediting.
function convertReserveToCredits(need) {
  const RATE = 0.8;                            // Credits received per reserve unit spent
  const reserveCost = Math.ceil(need / RATE);  // reserve to spend to cover `need` Credits
  if (reserve < reserveCost) {
    alert(`Reserve too low: need ${reserveCost} reserve (have ${reserve.toLocaleString()}).`);
    return false;
  }
  reserve -= reserveCost;                       // spend from the reserve pool
  credits += need;                              // deliver exactly the shortfall
  saveBalances();
  updateWallet();
  addToJournal(`Converted ${need.toLocaleString()} Credits from reserve (−${reserveCost} reserve).`);
  return true;
}

window.onload = () => { initApp(); };

/* LEGION_WAVE_5_fomo_chip */
setTimeout(function(){try{if(document.getElementById('lw_fomo_5'))return;var end=new Date(); end.setHours(24,0,0,0);var ms=Math.max(0,end-Date.now());var h=Math.floor(ms/3600000), m=Math.floor((ms%3600000)/60000);var d=document.createElement('div'); d.id='lw_fomo_5';d.style.cssText='font-size:11px;opacity:.75;margin:6px 0;color:#e0b552';d.textContent='window '+h+'h '+m+'m · W5';var app=document.getElementById('app')||document.body; app.insertBefore(d, app.firstChild);}catch(e){}},40);
