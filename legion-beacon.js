/* Legion 경량 측정 beacon (2026-07-20 Morpheus 수정) — 개인정보 최소(익명 uuid만).
   ⚠️ 이전 버그: type='view'(워커 ALLOWED 없음)+ts 누락 → 전량 폐기됐음. 수정: 허용 이벤트+ts+채널귀속.
   window.LEGION_APP / LEGION_ANALYTICS_URL 규약 유지. window.legionTrack(type) API 유지(앱 호출용). */
(function(){
  try{
    var URL = window.LEGION_ANALYTICS_URL || 'https://legion-analytics.hoyashi95.workers.dev';
    var APP = String(window.LEGION_APP || document.title || location.pathname).slice(0,40);
    var K='legion_anon';
    var anon = localStorage.getItem(K);
    if(!anon){ anon = (Date.now().toString(36)+Math.random().toString(36).slice(2,8)); localStorage.setItem(K,anon); }
    function channel(){
      try{
        var ck='legion_src', v=localStorage.getItem(ck); if(v) return v;   // 첫 터치 고정
        var tg=window.Telegram&&window.Telegram.WebApp;
        var raw=(tg&&tg.initDataUnsafe&&tg.initDataUnsafe.start_param)||'';
        if(!raw){ var m=(location.search||'').match(/[?&]startapp=([^&]+)/); raw=m?decodeURIComponent(m[1]):''; }
        var ch='direct';
        if(raw.indexOf('c-')===0){ var rest=raw.slice(2), ri=rest.indexOf('-r-'); ch=(ri>=0?rest.slice(0,ri):rest).toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,16)||'direct'; }
        localStorage.setItem(ck,ch); return ch;
      }catch(e){ return 'direct'; }
    }
    window.legionTrack = function(type, extra){
      try{
        // ✅ ts 필수(워커 !ts 거부 방지) + 허용 이벤트명 사용
        var body = JSON.stringify(Object.assign({ app:APP, type:(type||'app_open').slice(0,32), anonId:anon, ts:Date.now(), channel:channel() }, extra||{}));
        if(navigator.sendBeacon){ navigator.sendBeacon(URL+'/ev', body); }
        else{ fetch(URL+'/ev',{method:'POST',headers:{'content-type':'application/json'},body:body,keepalive:true}).catch(function(){}); }
      }catch(e){}
    };
    // 자동 부팅 계측: install(1회)+session_start+app_open (전부 워커 ALLOWED에 존재)
    function boot(){
      try{
        var ik=APP+'_installed', first=!localStorage.getItem(ik);
        if(first){ localStorage.setItem(ik,'1'); window.legionTrack('install',{}); }
        window.legionTrack('session_start',{first:first});
        window.legionTrack('app_open',{});
      }catch(e){}
    }
    if(document.readyState!=='loading') boot();
    else document.addEventListener('DOMContentLoaded', boot);
  }catch(e){}
})();
