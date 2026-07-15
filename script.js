// p13 TradeForge - Trade app. p6 Voice + p10 Credits + FOMO.
let wallet = null;
let balance = 1250;
let credits = 450;
let trades = JSON.parse(localStorage.getItem('p13_trades') || '[]');
let codex = JSON.parse(localStorage.getItem('p13_codex') || '[]');

function updateWallet() {
  const el = document.getElementById('wallet-info');
  if (el) el.innerHTML = `${wallet || '0xDemo'} • ${balance} $EROS / ${credits} Credits`;
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
  const price = parseInt(document.getElementById('trade-price').value) || 1000;
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
  
  alert(`Trade posted! FOMO: ${Math.floor(Math.random()*15)+5} traders viewing.`);
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
    list.innerHTML = '<p>No trades. Post one with voice!</p>';
    return;
  }
  
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  trades.forEach(trade => {
    const leftSec = trade.expiry ? Math.max(0, Math.floor((trade.expiry - Date.now())/1000)) : 0;
    const expired = leftSec <= 0;
    const mins = Math.floor(leftSec / 60);
    const fomo = expired ? 'expired'
      : mins >= 60 ? `⏱ ${Math.floor(mins/60)}h ${mins%60}m left`
      : `⏱ ${mins}m left`;
    const fomoClass = (!expired && mins < 60) ? 'urgent' : '';
    const desc = trade.desc.length > 80 ? esc(trade.desc.slice(0,80)).trimEnd() + '…' : esc(trade.desc);
    const el = document.createElement('div');
    el.className = 'trade-card' + (expired ? ' expired' : '');
    el.innerHTML = `
      <div class="tc-head">
        <strong class="tc-title">${esc(trade.title)}</strong>
        <span class="tc-time ${fomoClass}">${fomo}</span>
      </div>
      <p class="tc-desc">${desc}</p>
      <div class="tc-meta">
        <span class="tc-price">${trade.price.toLocaleString()} <em>Credits</em></span>
        <span class="surprise">👁 ${trade.surprise.toFixed(2)}${trade.voiceUrl ? ' 🎙' : ''}</span>
      </div>
      <button class="primary" onclick="acceptTrade(${trade.id})"${expired ? ' disabled' : ''}>${expired ? 'Expired' : 'Accept Deal'}</button>
      <button class="ghost" onclick="birthTradeArtifact(${trade.id})">Birth Artifact → p17/p10</button>
    `;
    list.appendChild(el);
  });
}

function acceptTrade(id) {
  const trade = trades.find(t => t.id === id);
  if (!trade || !wallet) {
    alert('Connect wallet.');
    return;
  }
  
  const cost = trade.price;
  if (credits < cost) {
    if (!payWithP10Cross(Math.min(cost, 300), 'p13-trade')) {
      alert('Need more p10 Credits. Bridge from p10.');
      return;
    }
  } else {
    credits -= cost;
  }
  
  trade.status = 'accepted';
  trade.buyers.push(wallet);
  localStorage.setItem('p13_trades', JSON.stringify(trades));
  
  const note = `Accepted ${trade.title} for ${cost}. Voice replay in Codex.`;
  addToCodex(note);
  
  alert(`Deal accepted! Birth artifact? Cross p17.`);
  updateWallet();
  showFeed();
}

function showVoice() {
  hideAll();
  document.getElementById('voice').classList.remove('hidden');
  setActiveNav('voice');
}

function startVoiceNegotiation() {
  const result = document.getElementById('negotiation-result');
  result.innerHTML = 'p6 Voice negotiation started...';

  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    const rec = new MediaRecorder(stream);
    let chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, {type:'audio/webm'});
      const url = URL.createObjectURL(blob);
      
      let surprise = 0.3;
      if (window.getP6LungSurprise) surprise = window.getP6LungSurprise();
      
      result.innerHTML = `<audio controls src="${url}"></audio><br>Negotiation surprise: ${surprise.toFixed(2)}. Deal terms improved!`;
      // Simulate better terms
      stream.getTracks().forEach(t => t.stop());
    };
    rec.start();
    setTimeout(() => rec.stop(), 5000);
  }).catch(() => {
    result.innerHTML = 'Voice fallback. Surprise 0.72 — Better deal!';
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
      { id: 1, title: "Coffee Beans Bulk", desc: "From Colombia, 10 tons.", price: 5000, surprise: 0.68, voiceUrl: null, timestamp: new Date().toISOString(), status: 'open', buyers: [], expiry: Date.now() + 3600*1000 },
      { id: 2, title: "Electronics Components", desc: "Asia supplier.", price: 12000, surprise: 0.55, voiceUrl: null, timestamp: new Date().toISOString(), status: 'open', buyers: [], expiry: Date.now() + 7200*1000 }
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

// Cross nav + p10 pay
function payWithP10Cross(amount, to) {
  let p10b = parseFloat(localStorage.getItem('p10_balance')||'1284.7');
  if (p10b < amount) { alert('p10 shallow: need more Credits.'); return false; }
  localStorage.setItem('p10_balance', (p10b - amount).toFixed(2));
  credits += Math.floor(amount*0.8); // p13 credit receive
  updateWallet();
  addToCodex(`p10 cross pay ${amount} to ${to}`);
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
EOF