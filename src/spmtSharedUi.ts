export function spmtSharedUiHead(appId: string): string {
  const safeApp = JSON.stringify(appId).slice(1, -1);
  return `<style id="spmt-shared-shell-style">
:root{--spmt-bg:#080b14;--spmt-surface:#171321;--spmt-surface-rgb:23,19,33;--spmt-text:#f8fafc;--spmt-accent:#ff8a3d;--spmt-accent-rgb:255,138,61;--spmt-radius:18px;--spmt-glass:.65;--spmt-blur:22px;--spmt-border:.15;--spmt-stars:.7;--spmt-nebula:.8;--spmt-glow:.8;--spmt-density:1;--spmt-motion:1}
html[data-spmt-theme]{background:var(--spmt-bg);color:var(--spmt-text)}
body.spmt-host-shell{background:var(--spmt-bg)!important;color:var(--spmt-text)!important;position:relative;isolation:isolate}
body.spmt-host-shell:before,body.spmt-host-shell:after{content:"";position:fixed;inset:0;pointer-events:none;z-index:-2}
body.spmt-host-shell:before{opacity:var(--spmt-stars);background-image:radial-gradient(circle at 9% 22%,#fff 0 1px,transparent 1.45px),radial-gradient(circle at 48% 18%,#fff 0 1px,transparent 1.45px),radial-gradient(circle at 78% 44%,#fff 0 1px,transparent 1.45px),radial-gradient(circle at 31% 77%,#fff 0 1px,transparent 1.45px),radial-gradient(circle at 93% 13%,#fff 0 1px,transparent 1.45px),radial-gradient(circle at 64% 88%,#fff 0 1px,transparent 1.45px);background-size:170px 170px,230px 230px,290px 290px,210px 210px,260px 260px,320px 320px}
body.spmt-host-shell:after{z-index:-1;background:radial-gradient(circle at 10% 0%,rgba(var(--spmt-accent-rgb),calc(.25 * var(--spmt-nebula))),transparent 36rem),radial-gradient(circle at 92% 86%,rgba(var(--spmt-accent-rgb),calc(.12 * var(--spmt-nebula))),transparent 34rem),linear-gradient(180deg,var(--spmt-bg),#03050a 92%)}
body.spmt-host-shell :is(.panel,.card,.hero,.status,.topbar,.toolbar,.workspace-card,.surface,.box){border-color:rgba(255,255,255,var(--spmt-border))!important;border-radius:var(--spmt-radius)!important;backdrop-filter:blur(var(--spmt-blur))!important;-webkit-backdrop-filter:blur(var(--spmt-blur))!important}
body.spmt-host-shell :is(.panel,.card,.hero,.status,.workspace-card,.surface,.box){background:rgba(var(--spmt-surface-rgb),var(--spmt-glass))!important}
body.spmt-host-shell :is(.button.primary,button:not(.secondary):not(.ghost),.primary){background:linear-gradient(135deg,var(--spmt-accent),rgba(var(--spmt-accent-rgb),.62))!important}
body.spmt-host-shell .eyebrow{color:var(--spmt-accent)!important}
body.spmt-host-shell .shell{padding-top:calc(24px * var(--spmt-density))!important}
body.spmt-host-shell.spmt-no-motion *,body.spmt-host-shell.spmt-no-motion *:before,body.spmt-host-shell.spmt-no-motion *:after{scroll-behavior:auto!important;transition:none!important;animation:none!important}
.spmt-workspace-launcher{position:fixed;right:18px;bottom:18px;z-index:10030;display:flex;align-items:center;gap:9px;border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:10px 14px;background:rgba(3,5,10,.82);color:#fff;font:800 13px/1 Inter,ui-sans-serif,system-ui,sans-serif;box-shadow:0 18px 48px rgba(0,0,0,.42),0 0 calc(28px * var(--spmt-glow)) rgba(var(--spmt-accent-rgb),.18);backdrop-filter:blur(18px);cursor:pointer}
.spmt-workspace-launcher svg,.spmt-workspace-tabs svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.spmt-workspace-host{position:fixed;inset:auto 18px 72px auto;z-index:10020;width:min(980px,calc(100vw - 36px));height:min(78vh,760px);display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden;border:1px solid rgba(255,255,255,.14);border-radius:calc(var(--spmt-radius) + 4px);background:rgba(3,5,10,.94);box-shadow:0 28px 90px rgba(0,0,0,.62);backdrop-filter:blur(24px)}
.spmt-workspace-host[hidden]{display:none!important}.spmt-workspace-bar{display:flex;align-items:center;gap:8px;padding:9px;border-bottom:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.025)}.spmt-workspace-tabs{display:flex;gap:7px;flex-wrap:wrap}.spmt-workspace-tabs button,.spmt-workspace-close{display:inline-flex;align-items:center;gap:7px;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:8px 10px;background:rgba(255,255,255,.035);color:#d4d4d8;font:750 12px Inter,ui-sans-serif,system-ui,sans-serif;cursor:pointer}.spmt-workspace-tabs button.active{border-color:rgba(var(--spmt-accent-rgb),.62);background:rgba(var(--spmt-accent-rgb),.14);color:#fff}.spmt-workspace-close{margin-left:auto}.spmt-workspace-frame{width:100%;height:100%;border:0;background:transparent}
@media(max-width:720px){.spmt-workspace-host{inset:10px 10px 66px 10px;width:auto;height:auto}.spmt-workspace-launcher{right:12px;bottom:12px}.spmt-workspace-tabs button span{display:none}}
@media(prefers-reduced-motion:reduce){body.spmt-host-shell *,body.spmt-host-shell *:before,body.spmt-host-shell *:after{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
</style><meta name="spmt-host-app" content="${safeApp}">`;
}

export function spmtSharedUiScript(appId: string, profileEndpoint = "/athena/api/settings"): string {
  const encodedApp = JSON.stringify(appId);
  const encodedProfileEndpoint = JSON.stringify(profileEndpoint);
  return `<script id="spmt-shared-shell-script">
(()=>{
  const APP=${encodedApp};
  const PROFILE_ENDPOINT=${encodedProfileEndpoint};
  const SPMT='https://spmt.live';
  const palettes={
    'solar-flare':{bg:'#080b14',surface:'#171321',text:'#f8fafc',accent:'#ff8a3d'},
    'nebula-purple':{bg:'#090712',surface:'#1d1530',text:'#f8f4ff',accent:'#a855f7'},
    'oceanic-blue':{bg:'#06111a',surface:'#0c2535',text:'#effaff',accent:'#22d3ee'},
    'aurora-green':{bg:'#07110d',surface:'#10291e',text:'#f0fdf4',accent:'#34d399'}
  };
  const root=document.documentElement;
  document.body.classList.add('spmt-host-shell');
  function rgb(hex){const v=String(hex||'').replace('#','');if(!/^[0-9a-f]{6}$/i.test(v))return'255,138,61';return parseInt(v.slice(0,2),16)+','+parseInt(v.slice(2,4),16)+','+parseInt(v.slice(4,6),16)}
  function radius(v){return({sm:'8px',md:'14px',lg:'20px',full:'28px'})[v]||'14px'}
  function profileFrom(data){return data?.shared?.profile||data?.workspace?.profile||data?.profile||null}
  function apply(profile){
    const a=profile&&profile.appearance;if(!a)return;
    const mapping=String((profile.appThemeMappings||{})[APP]||'follow-workspace');
    const themeId=mapping==='follow-workspace'?a.themeId:mapping;
    const p=palettes[themeId]||palettes['solar-flare'];
    const accent=a.accentColor||p.accent;
    root.dataset.spmtTheme=themeId;
    root.style.setProperty('--spmt-bg',p.bg);root.style.setProperty('--spmt-surface',p.surface);root.style.setProperty('--spmt-surface-rgb',rgb(p.surface));root.style.setProperty('--spmt-text',p.text);root.style.setProperty('--spmt-accent',accent);root.style.setProperty('--spmt-accent-rgb',rgb(accent));
    root.style.setProperty('--spmt-radius',radius(a.cornerRadius));root.style.setProperty('--spmt-glass',String((a.glassOpacity??65)/100));root.style.setProperty('--spmt-blur',String(a.blurStrength??22)+'px');root.style.setProperty('--spmt-border',String(Math.max(.06,(a.borderStrength??60)/400)));root.style.setProperty('--spmt-stars',String((a.starDensity??70)/100));root.style.setProperty('--spmt-nebula',String((a.nebulaIntensity??80)/100));root.style.setProperty('--spmt-glow',String((a.glowIntensity??80)/100));root.style.setProperty('--spmt-density',a.density==='compact'?'.86':a.density==='spacious'?'1.15':'1');
    document.body.classList.toggle('spmt-no-motion',a.animation?.enabled===false||a.accessibility?.reduceMotion===true);
  }
  async function refresh(){try{const r=await fetch(PROFILE_ENDPOINT,{credentials:'include',cache:'no-store',headers:{accept:'application/json'}});if(!r.ok)return;const data=await r.json();const profile=profileFrom(data);if(profile)apply(profile)}catch{}}
  function icon(kind){return kind==='settings'?'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.6a7 7 0 0 0-.7-1.7l1-1.8-2.1-2.1-1.8 1a7 7 0 0 0-1.7-.7L11 2H8l-.6 2a7 7 0 0 0-1.7.7l-1.8-1L1.8 5.8l1 1.8a7 7 0 0 0-.7 1.7L0 10v3l2 .6a7 7 0 0 0 .7 1.7l-1 1.8 2.1 2.1 1.8-1a7 7 0 0 0 1.7.7L8 21h3l.6-2a7 7 0 0 0 1.7-.7l1.8 1 2.1-2.1-1-1.8a7 7 0 0 0 .7-1.7z"/></svg>':kind==='overlay'?'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 8h8v8H8z"/></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v4H4zM4 11h7v8H4zM13 11h7v8h-7z"/></svg>'}
  function mount(){if(document.getElementById('spmt-workspace-launcher'))return;const host=document.createElement('section');host.id='spmt-workspace-host';host.className='spmt-workspace-host';host.hidden=true;host.innerHTML='<div class="spmt-workspace-bar"><div class="spmt-workspace-tabs"><button class="active" data-surface="worktray">'+icon('worktray')+'<span>Workspace</span></button><button data-surface="settings">'+icon('settings')+'<span>Settings</span></button><button data-surface="overlays">'+icon('overlay')+'<span>Overlay Bay</span></button></div><button class="spmt-workspace-close" type="button">Close</button></div><iframe class="spmt-workspace-frame" title="SPMT Workspace" allow="autoplay; microphone; camera; fullscreen; clipboard-write"></iframe>';
    const launcher=document.createElement('button');launcher.id='spmt-workspace-launcher';launcher.className='spmt-workspace-launcher';launcher.type='button';launcher.innerHTML=icon('worktray')+'<span>Workspace</span>';document.body.append(host,launcher);
    const frame=host.querySelector('iframe');const buttons=[...host.querySelectorAll('[data-surface]')];
    function openSurface(surface){const mode=surface==='worktray'?'dock':'full';frame.src=SPMT+'/embed/'+surface+'?mode='+mode+'&app='+encodeURIComponent(APP);buttons.forEach(b=>b.classList.toggle('active',b.dataset.surface===surface));host.hidden=false}
    launcher.addEventListener('click',()=>{if(host.hidden)openSurface('worktray');else host.hidden=true});host.querySelector('.spmt-workspace-close').addEventListener('click',()=>host.hidden=true);buttons.forEach(b=>b.addEventListener('click',()=>openSurface(b.dataset.surface)));
  }
  window.addEventListener('message',e=>{if(e.origin!==SPMT||e.data?.type!=='spmt.surface.updated')return;refresh()});
  refresh();mount();
})();
</script>`;
}
