(() => {
  'use strict';

  const API = 'http://127.0.0.1:3930/api/events';
  let source = null;
  let currentRound = null;
  let points = [];
  let crashX = null;
  let phase = 'WAITING';
  let lastMultiplier = null;

  const css = `
  .wts-p2-live-card.wts-elite-card{background:linear-gradient(145deg,#090d18,#10172a 55%,#090d16);border-color:rgba(255,23,79,.24);overflow:hidden}
  .wts-elite-flight{position:relative;height:285px;margin:14px 0 8px;border:1px solid rgba(255,255,255,.07);border-radius:18px;overflow:hidden;background:radial-gradient(circle at 78% 18%,rgba(90,72,180,.18),transparent 30%),linear-gradient(180deg,#060914,#0b1020 62%,#080b13);box-shadow:inset 0 0 55px rgba(0,0,0,.35)}
  .wts-elite-flight:before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(92,107,154,.09) 1px,transparent 1px),linear-gradient(90deg,rgba(92,107,154,.09) 1px,transparent 1px);background-size:42px 42px;transform:perspective(380px) rotateX(55deg) translateY(115px) scale(1.35);transform-origin:center bottom;opacity:.7}
  .wts-elite-flight:after{content:"";position:absolute;left:0;right:0;bottom:0;height:34%;background:linear-gradient(180deg,transparent,rgba(17,25,52,.5));border-top:1px solid rgba(255,255,255,.06)}
  .wts-elite-stars{position:absolute;inset:0;background-image:radial-gradient(circle,rgba(255,255,255,.8) 0 1px,transparent 1.5px);background-size:71px 59px;opacity:.34}
  .wts-elite-horizon{position:absolute;left:0;right:0;bottom:26%;height:1px;background:linear-gradient(90deg,transparent,rgba(110,125,190,.5),transparent)}
  .wts-elite-cloud{position:absolute;width:105px;height:28px;border-radius:50%;background:rgba(170,183,215,.06);filter:blur(2px)}
  .wts-elite-cloud.c1{top:28%;left:10%}.wts-elite-cloud.c2{top:17%;right:15%;transform:scale(.7)}
  .wts-elite-head{position:absolute;z-index:6;top:12px;left:14px;right:14px;display:flex;justify-content:space-between;align-items:center;pointer-events:none}
  .wts-elite-state{font-size:10px;font-weight:900;letter-spacing:1.4px;padding:6px 9px;border-radius:999px;background:rgba(0,0,0,.36);border:1px solid rgba(255,255,255,.09);color:#9da7bb}.wts-elite-state.live{color:#00e676;border-color:rgba(0,230,118,.28)}.wts-elite-state.signal{color:#ff174f;border-color:rgba(255,23,79,.42);box-shadow:0 0 18px rgba(255,23,79,.18)}.wts-elite-state.crashed{color:#ff174f}
  .wts-elite-crash{font-weight:950;font-size:18px;letter-spacing:.3px;color:#fff;text-shadow:0 0 18px rgba(255,23,79,.4)}.wts-elite-crash b{color:#ff174f}.wts-elite-crash.empty{opacity:.35}
  .wts-elite-svg{position:absolute;inset:0;width:100%;height:100%;z-index:3}.wts-elite-gridline{fill:none;stroke:rgba(92,107,154,.13);stroke-width:1}.wts-elite-trail{fill:none;stroke:rgba(255,23,79,.15);stroke-width:10;filter:url(#eliteGlow)}.wts-elite-path{fill:none;stroke:#ff174f;stroke-width:3.2;stroke-linecap:round;filter:url(#eliteGlow)}
  .wts-elite-plane{filter:url(#eliteGlow);transform-box:fill-box;transform-origin:center}.wts-elite-plane-body{fill:#f7f9ff}.wts-elite-plane-wing{fill:#d8dceb}.wts-elite-plane-accent{fill:#ff174f}.wts-elite-plane-window{fill:#10172a;stroke:#9aa6c5;stroke-width:1}
  .wts-elite-smoke{fill:#d8dce8;opacity:0}.wts-elite-flight.signal .wts-elite-smoke{opacity:.12;animation:eliteSmoke .8s infinite alternate}.wts-elite-flight.crashed .wts-elite-plane{opacity:.22}.wts-elite-flight.signal{box-shadow:inset 0 0 70px rgba(255,23,79,.14),0 0 28px rgba(255,23,79,.1)}
  .wts-elite-bottom{position:absolute;z-index:7;left:14px;right:14px;bottom:12px;display:flex;align-items:end;justify-content:space-between}.wts-elite-multi{font-size:28px;font-weight:950;color:#fff;text-shadow:0 0 20px rgba(0,230,118,.18)}.wts-elite-multi small{font-size:11px;color:#8e99b0;margin-left:5px;font-weight:800}.wts-elite-warning{font-size:9px;font-weight:950;letter-spacing:1.3px;color:#ff174f;opacity:0}.wts-elite-flight.signal .wts-elite-warning{opacity:1;animation:elitePulse .7s infinite}
  .wts-elite-round{position:absolute;z-index:7;right:14px;bottom:12px;font-size:9px;color:#78839a;text-align:right}.wts-elite-round b{display:block;color:#b9c1d2;font-size:10px;margin-top:2px}
  @keyframes eliteGlow{0%,100%{filter:drop-shadow(0 0 3px rgba(255,23,79,.45))}50%{filter:drop-shadow(0 0 10px rgba(255,23,79,.75))}}@keyframes eliteSmoke{from{transform:translate(-2px,1px) scale(.8)}to{transform:translate(-12px,-3px) scale(1.5);opacity:.03}}@keyframes elitePulse{50%{opacity:.35}}
  .wts-elite-crashbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;margin:0 0 10px;border-radius:12px;background:rgba(255,23,79,.055);border:1px solid rgba(255,23,79,.12)}.wts-elite-crashbar span{font-size:9px;font-weight:900;letter-spacing:1px;color:#8993a7}.wts-elite-crashbar strong{font-size:16px;color:#ff174f}.wts-elite-crashbar.waiting strong{color:#687287}
  .wts-crash-spinner{display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.18);border-top-color:#ff174f;border-radius:50%;animation:wtsCrashSpin .65s linear infinite;vertical-align:-2px}@keyframes wtsCrashSpin{to{transform:rotate(360deg)}}
  .wts-phase-flying .wts-elite-flight{border-color:rgba(0,230,118,.18)}
  `;

  function addStyle(){if(document.getElementById('wts-elite-flight-style'))return;const s=document.createElement('style');s.id='wts-elite-flight-style';s.textContent=css;document.head.appendChild(s)}
  function esc(v){return String(v==null?'':v).replace(/[&<>\\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\\':'&#92;','"':'&quot;'}[c]))}
  function num(v){const n=Number(v);return Number.isFinite(n)?n:null}

  function ensure(){
    const card=document.getElementById('wts-p2-live-card'); if(!card)return null;
    card.classList.add('wts-elite-card');
    let host=document.getElementById('wts-elite-host');
    if(!host){
      const old=document.getElementById('wts-flight');
      host=document.createElement('div');host.id='wts-elite-host';
      if(old) old.replaceWith(host); else card.querySelector('.wts-p2-value')?.insertAdjacentElement('afterend',host);
    }
    if(!host.querySelector('.wts-elite-flight')){
      host.innerHTML=`<div class="wts-elite-crashbar waiting"><span>CRASH X • LIVE TELEMETRY</span><strong id="wts-elite-crash"><span class="wts-crash-spinner"></span></strong></div><div class="wts-elite-flight" id="wts-elite-flight"><div class="wts-elite-stars"></div><div class="wts-elite-cloud c1"></div><div class="wts-elite-cloud c2"></div><div class="wts-elite-horizon"></div><div class="wts-elite-head"><span id="wts-elite-state" class="wts-elite-state">WAITING</span><span id="wts-elite-warning" class="wts-elite-warning">⚠ CRASH SIGNAL CONFIRMED</span></div><svg class="wts-elite-svg" viewBox="0 0 900 285" preserveAspectRatio="none"><defs><filter id="eliteGlow"><feGaussianBlur stdDeviation="2.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><path id="wts-elite-trail" class="wts-elite-trail" d="M20 255 L20 255"/><path id="wts-elite-path" class="wts-elite-path" d="M20 255 L20 255"/><g id="wts-elite-smokes"></g><g id="wts-elite-plane" class="wts-elite-plane" transform="translate(20 255)"><path class="wts-elite-plane-wing" d="M-27 4 L-2 -3 L17 -15 L10 0 L32 7 L5 7 L-3 4 Z"/><path class="wts-elite-plane-body" d="M-30 1 L-6 -3 L20 0 L31 5 L7 7 L-7 4 L-30 3 Z"/><path class="wts-elite-plane-accent" d="M-8 -2 L7 0 L3 3 L-12 2 Z"/><ellipse class="wts-elite-plane-window" cx="10" cy="1" rx="4" ry="2"/></g></svg><div class="wts-elite-bottom"><div class="wts-elite-multi"><span id="wts-elite-multi">—</span><small id="wts-elite-label">WAITING</small></div><div class="wts-elite-round">ROUND<b id="wts-elite-round">—</b></div></div></div>`;
    }
    return host;
  }

  function render(){
    const host=ensure();if(!host)return;
    const flight=host.querySelector('#wts-elite-flight'), stateEl=host.querySelector('#wts-elite-state'), crashEl=host.querySelector('#wts-elite-crash'), bar=host.querySelector('.wts-elite-crashbar');
    const multi=host.querySelector('#wts-elite-multi'), lab=host.querySelector('#wts-elite-label'), roundEl=host.querySelector('#wts-elite-round');
    const path=host.querySelector('#wts-elite-path'), trail=host.querySelector('#wts-elite-trail'), plane=host.querySelector('#wts-elite-plane'), smoke=host.querySelector('#wts-elite-smokes');
    if(roundEl)roundEl.textContent=currentRound==null?'—':String(currentRound);
    if(phase==='FLYING'&&lastMultiplier!=null){
      flight.className='wts-elite-flight live';stateEl.className='wts-elite-state live';stateEl.textContent='● FLYING';lab.textContent='LIVE';multi.textContent=lastMultiplier.toFixed(2)+'x';
    } else if(phase==='CRASH_SIGNAL'){
      flight.className='wts-elite-flight signal';stateEl.className='wts-elite-state signal';stateEl.textContent='⚠ CRASH SIGNAL';lab.textContent='SIGNAL';multi.textContent=(lastMultiplier??0).toFixed(2)+'x';
    } else if(phase==='CRASHED'){
      flight.className='wts-elite-flight crashed';stateEl.className='wts-elite-state crashed';stateEl.textContent='CRASHED';lab.textContent='FLEW AWAY';multi.textContent=(crashX??lastMultiplier??0).toFixed(2)+'x';
    } else {flight.className='wts-elite-flight';stateEl.className='wts-elite-state';stateEl.textContent='WAITING';lab.textContent='WAITING';multi.textContent='—'}
    if(crashX!=null){crashEl.textContent=crashX.toFixed(2)+'x';bar.classList.remove('waiting')}else{crashEl.innerHTML='<span class="wts-crash-spinner"></span>';bar.classList.add('waiting')}
    if(path&&points.length){const d=points.map((p,i)=>`${i?'L':'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');path.setAttribute('d',d);trail.setAttribute('d',d);const p=points[points.length-1];plane.setAttribute('transform',`translate(${p[0].toFixed(1)} ${p[1].toFixed(1)}) rotate(-${Math.min(18,Math.max(4,p[2]))})`);}
    if(smoke&&phase==='CRASH_SIGNAL'){smoke.innerHTML='<circle class="wts-elite-smoke" cx="0" cy="0" r="5"/><circle class="wts-elite-smoke" cx="-10" cy="3" r="4"/>'}else if(smoke)smoke.innerHTML='';
  }

  function ingest(type,d){
    d=d||{}; const rid=d.roundId ?? d.round ?? null; if(rid!=null&&rid!==currentRound){currentRound=rid;points=[];crashX=null;lastMultiplier=null}
    if(type==='LIVE_TICK'){
      const m=num(d.multiplier ?? d.x);if(m==null)return;lastMultiplier=m;phase='FLYING';
      const x=Math.min(850,35+points.length*12);const y=245-Math.min(205,Math.log(Math.max(1,m))*48);points.push([x,y,Math.min(18,4+Math.log(Math.max(1,m))*2)]);if(points.length>70)points.shift();render();
    } else if(type==='CRASH_SIGNAL_LIVE'){
      const cx=num(d.crashX);if(cx!=null)crashX=cx;lastMultiplier=num(d.multiplier)??lastMultiplier;phase='FLYING';render();
    } else if(type==='CHART_CONFIRM_LIVE'){
      const cx=num(d.crashX);if(cx!=null)crashX=cx;phase='CRASH_SIGNAL';render();
    } else if(type==='CRASH_LIVE'){
      const cx=num(d.multiplier ?? d.crashX);if(cx!=null)crashX=cx;phase='CRASHED';render();
    } else if(type==='STATE_LIVE'&&d.newStateId!=null){phase='WAITING';lastMultiplier=null;crashX=null;points=[];render()}
  }

  function connect(){if(source)return;try{source=new EventSource(API);source.onmessage=e=>{try{const ev=JSON.parse(e.data);ingest(ev.type,ev.data||{})}catch{}};source.onerror=()=>{try{source.close()}catch{}source=null;setTimeout(connect,1800)}}catch{setTimeout(connect,2500)}}
  function moveHistory(){const root=document.querySelector('.wts-phase2-shell'),history=root?.querySelector('.wts-p3-history-card'),grid=root?.querySelector('.wts-p2-main-grid');if(root&&history&&grid&&history.nextElementSibling!==grid)root.insertBefore(history,grid);const h=history?.querySelector('.wts-p3-menu-head strong');const s=history?.querySelector('.wts-p3-menu-head small');if(h)h.textContent='History / Last 20 Rounds';if(s)s.textContent='Latest 20 rounds';const box=history?.querySelector('#wts-p3-history');if(box)while(box.children.length>20)box.removeChild(box.lastElementChild)}
  function boot(){addStyle();moveHistory();connect();const mo=new MutationObserver(()=>{moveHistory();ensure();});mo.observe(document.body,{childList:true,subtree:true});setInterval(moveHistory,1000)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
