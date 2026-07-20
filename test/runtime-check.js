// 붕어빵 앱 범용 런타임 크래시 게이트 — vm+DOM+TG목(세션 독립). p2에서 검증됨.
// 앱 조립 후 out/<app>/test/runtime-check.js 로 복사. ENTRY_JS = 앱 진입 스크립트(기본 script.js).
const fs = require('fs'), vm = require('vm');
const ENTRY = process.env.ENTRY_JS || 'script.js';   // 앱 진입 스크립트(ENTRY_JS env로 오버라이드)
function mockEl(){
  const e = { textContent:'', innerHTML:'', value:'', dataset:{}, style:new Proxy({},{get(t,k){if(k==='removeProperty'||k==='setProperty'||k==='getPropertyValue')return ()=>'';return t[k]??'';},set(t,k,v){t[k]=v;return true}}),
    classList:{add(){},remove(){},toggle(){},contains(){return false}}, offsetWidth:100, clientWidth:360, width:360, height:360,
    children:[], firstChild:null, checked:false, options:[], selectedIndex:0,
    addEventListener(){}, removeEventListener(){}, appendChild(){}, removeChild(){}, remove(){}, setAttribute(){}, getAttribute(){return null},
    querySelector(){return mockEl()}, querySelectorAll(){return []}, getContext(){return ctx()}, getBoundingClientRect(){return{width:360,height:360,top:0,left:0}},
    insertBefore(){}, cloneNode(){return mockEl()}, closest(){return null}, focus(){}, click(){}, scrollIntoView(){} };
  e.parentElement = { clientWidth:360, appendChild(){}, style:{}, insertBefore(){} };
  return e;
}
function ctx(){ return new Proxy({ canvas:{width:360,height:360}, measureText(){return{width:10}} }, { get(t,k){ if(k in t)return t[k]; if(k==='createRadialGradient'||k==='createLinearGradient')return ()=>({addColorStop(){}}); return ()=>{}; }, set(){return true} }); }
const els={}, sb={};
sb.console=console; sb.Math=Math; sb.Date=Date; sb.JSON=JSON; sb.Object=Object; sb.Array=Array; sb.String=String; sb.Number=Number; sb.Boolean=Boolean; sb.RegExp=RegExp; sb.isNaN=isNaN; sb.parseInt=parseInt; sb.parseFloat=parseFloat; sb.Set=Set; sb.Map=Map; sb.Symbol=Symbol; sb.Proxy=Proxy; sb.Error=Error; sb.encodeURIComponent=encodeURIComponent; sb.decodeURIComponent=decodeURIComponent;
sb.setTimeout=()=>0; sb.clearTimeout=()=>{}; sb.setInterval=()=>0; sb.clearInterval=()=>{}; sb.requestAnimationFrame=()=>0; sb.cancelAnimationFrame=()=>{};
sb.localStorage={_d:{},getItem(k){return this._d[k]??null},setItem(k,v){this._d[k]=String(v)},removeItem(k){delete this._d[k]}};
sb.Image=function(){return mockEl()};
sb.navigator={language:'en',userAgent:'node',sendBeacon(){return true}};
sb.fetch=()=>Promise.resolve({ok:true,json:()=>Promise.resolve({ok:true}),text:()=>Promise.resolve('')});
sb.document={ getElementById(id){return els[id]||(els[id]=mockEl())}, querySelector(){return mockEl()}, querySelectorAll(){return []}, createElement(){return mockEl()}, addEventListener(){}, body:mockEl(), documentElement:mockEl(), hidden:false, head:mockEl() };
sb.getComputedStyle=()=>new Proxy({},{get(){return ''}});
sb.location={href:'https://x/',search:'',hash:''};
sb.window=sb; sb.globalThis=sb; sb.self=sb;
const mainBtn={show(){return mainBtn},hide(){return mainBtn},setText(){return mainBtn},onClick(){return mainBtn},offClick(){return mainBtn},setParams(){return mainBtn},enable(){return mainBtn},disable(){return mainBtn},showProgress(){return mainBtn},hideProgress(){return mainBtn},isVisible:false};
const backBtn={show(){return backBtn},hide(){return backBtn},onClick(){return backBtn},offClick(){return backBtn}};
sb.window.Telegram={ WebApp:{ ready(){}, expand(){}, enableClosingConfirmation(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, initData:'', initDataUnsafe:{}, MainButton:mainBtn, BackButton:backBtn, openTelegramLink(){}, openLink(){}, openInvoice(){}, showPopup(){}, showAlert(){}, showConfirm(){}, HapticFeedback:{impactOccurred(){return this},notificationOccurred(){return this},selectionChanged(){return this}}, CloudStorage:{getItem(){},setItem(){},getKeys(){}}, colorScheme:'dark', themeParams:{}, onEvent(){}, offEvent(){}, close(){}, version:'7.0', platform:'ios', isExpanded:true } };
sb.addEventListener=()=>{}; sb.removeEventListener=()=>{}; sb.scrollTo=()=>{}; sb.matchMedia=()=>({matches:false,addEventListener(){}}); sb.innerWidth=400; sb.innerHeight=800;
sb.alert=()=>{}; sb.confirm=()=>true; sb.prompt=()=>'';
vm.createContext(sb);
let fail=0;
if(!fs.existsSync(ENTRY)){ console.log('⚪ 진입스크립트 없음('+ENTRY+') — 앱 조립 후 실행'); process.exit(0); }
try{ vm.runInContext(fs.readFileSync(ENTRY,'utf8'),sb,{filename:ENTRY}); console.log('LOAD',ENTRY,'✅'); }
catch(e){ fail++; console.log('LOAD ERROR',ENTRY,'❌',e.message,'\n',(e.stack||'').split('\n').slice(0,3).join('\n')); }
const T = `(function(){ var R=[];
  function tryFn(l,f){ try{ f(); R.push('✅ '+l); }catch(e){ R.push('❌ '+l+' — '+e.message); } }
  tryFn('window.onload(부팅)', function(){ if(typeof window.onload==='function') window.onload(); });
  globalThis.__R=R; })();`;
var testThrew=false;
try{ vm.runInContext(T, sb, {filename:'test'}); }catch(e){ console.log('TEST BLOCK THREW', e.message); testThrew=true; }
console.log('\n════ 런타임 ════');
(sb.__R||[]).forEach(function(l){ console.log('  '+l); });
const bad=(sb.__R||[]).filter(function(l){return l[0]==='❌'}).length;
const emptyR=!(sb.__R||[]).length;
const ok=(fail===0 && bad===0 && !testThrew && !emptyR);
console.log(ok ? '\n🟢 부팅 런타임 클린' : '\n🔴 검증 실패 — 로드에러 '+fail+' · 런타임 '+bad);
process.exit(ok ? 0 : 1);
