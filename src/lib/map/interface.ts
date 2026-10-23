/** Interface only: city geometry and navigation remain in the map engine. */
export function createMapInterface(root:HTMLElement):()=>void {
  const find=<T extends HTMLElement=HTMLElement>(id:string)=>root.querySelector<T>('#'+id)!;
  const header=document.createElement('header');header.id='app-header';
  header.innerHTML=`<div class="app-brand"><span class="brand-mark" aria-hidden="true">ح</span><div><strong>أطلس حلب</strong><span>المدينة القديمة · استكشاف ثلاثي الأبعاد</span></div></div><div class="header-search"><span aria-hidden="true">⌕</span></div><div class="header-actions"><span class="view-badge">عرض ثلاثي الأبعاد <b>3D</b></span><button id="fullscreen-toggle" type="button" aria-label="ملء الشاشة" title="ملء الشاشة">⛶</button></div>`;
  root.append(header);
  const search=find<HTMLInputElement>('search');search.placeholder='ابحث عن معلم، شارع أو مكان…';
  const searchArea=header.querySelector('.header-search')!;searchArea.append(search,find('results'));
  find('hud').querySelector('h1')!.textContent='إعدادات المشهد';
  const kicker=document.createElement('span');kicker.className='panel-kicker';kicker.textContent='استكشف حلب القديمة';find('hud').prepend(kicker);
  const guide=document.createElement('details');guide.id='navigation-guide';guide.innerHTML='<summary>دليل التنقّل</summary>';guide.append(find('hud').querySelector('.muted')!);find('hud').append(guide);
  const footer=document.createElement('footer');footer.id='app-footer';
  const area=document.createElement('span');area.textContent='حلب، سوريا';area.className='footer-location';
  footer.append(area,find('status'),find('credit'));root.append(footer);
  const utility=find<HTMLDetailsElement>('utility-panel');utility.open=false;
  find<HTMLDetailsElement>('legend').open=false;
  const fullscreen=find<HTMLButtonElement>('fullscreen-toggle');
  const updateFullscreen=()=>{const active=!!document.fullscreenElement;fullscreen.textContent=active?'⊡':'⛶';fullscreen.title=active?'الخروج من ملء الشاشة':'ملء الشاشة';fullscreen.setAttribute('aria-label',fullscreen.title);fullscreen.setAttribute('aria-pressed',String(active));};
  fullscreen.hidden=!document.fullscreenEnabled;
  fullscreen.onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await root.requestFullscreen();}catch{fullscreen.title='ملء الشاشة غير متاح في هذا المتصفح';}};
  document.addEventListener('fullscreenchange',updateFullscreen);
  const mobile=matchMedia('(max-width: 760px)');
  const close=find<HTMLButtonElement>('hud-close'),open=find<HTMLButtonElement>('hud-open');
  const collapse=()=>{if(mobile.matches){find('hud').hidden=true;open.style.display='block';open.setAttribute('aria-expanded','false');}};
  collapse();
  const toggleUtilities=()=>{if(mobile.matches&&utility.open)collapse();};utility.addEventListener('toggle',toggleUtilities);
  const onOpen=()=>{if(mobile.matches)utility.open=false;};open.addEventListener('click',onOpen);
  close.title='طي إعدادات المشهد';
  return ()=>{document.removeEventListener('fullscreenchange',updateFullscreen);utility.removeEventListener('toggle',toggleUtilities);open.removeEventListener('click',onOpen);header.remove();footer.remove();};
}
