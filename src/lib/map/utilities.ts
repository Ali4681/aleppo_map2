import * as THREE from 'three';
import type { FeatureCollection, MapMeta } from './types';
import { generateNetworks, networkGeoJson, NETWORKS, NETWORK_KINDS } from './simulation';
import type { NetworkEdge, NetworkNode, NetworkKind } from './simulation';
import { createUtilityModels } from './utility-models';

interface Options {
  root: HTMLElement; scene: THREE.Scene; roads: FeatureCollection; meta: MapMeta; buildings?: FeatureCollection;
  solidObjects?: () => THREE.Object3D[]; focus?: (x:number,y:number,level:number)=>void; onChange?:()=>void;
  elevation: (x: number, y: number) => number;
  setCutaway: (enabled: boolean) => void;
}

export function addUtilitySimulation({ root, scene, roads, meta, elevation, setCutaway, buildings, solidObjects, focus, onChange }: Options) {
  const data = generateNetworks(roads, meta, elevation, buildings);
  const models = createUtilityModels(data);
  const {group,layers}=models;scene.add(group);
  const style = document.createElement('style');
  style.textContent = `
    #info{z-index:6}
    #utility-panel{position:fixed;left:16px;top:16px;z-index:4;width:295px;max-width:calc(100vw - 32px);max-height:75vh;overflow:auto;background:#172b3aee;border:1px solid #ffffff30;border-radius:12px;color:#fff;padding:13px;font:13px Tahoma;box-shadow:0 6px 24px #0003}
    #utility-panel summary{cursor:pointer;font-weight:bold}#utility-panel .utility-warning{color:#ffe09b;background:#82602335;border:1px solid #b68b45;padding:8px;border-radius:6px;line-height:1.6;font-size:12px}
    #utility-panel label{display:flex;align-items:center;gap:7px;margin:10px 0;cursor:pointer}#utility-panel input{width:auto;accent-color:#45d4ff}#utility-panel button{border:1px solid #ffffff40;background:#ffffff13;color:white;border-radius:6px;padding:7px;cursor:pointer;font:12px Tahoma;margin:3px}#utility-panel button:disabled{opacity:.5;cursor:default}
    #utility-panel table{width:100%;font-size:11px;border-collapse:collapse}#utility-panel td{padding:5px;border-bottom:1px solid #ffffff20;overflow-wrap:anywhere}#utility-panel h3{font-size:13px;margin-top:12px}.utility-color{width:22px;height:4px;display:inline-block;flex:none}
    #utility-badge{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2;border:1px solid #bd9351;background:#453419ed;color:#ffe5aa;padding:7px 12px;border-radius:7px;font:12px Tahoma;pointer-events:none}
    @media(max-width:760px){#utility-panel{top:auto;bottom:85px;left:10px;width:260px;max-height:45vh}#utility-badge{top:4px;max-width:95vw;text-align:center}}
  `;
  root.append(style);
  const panel = document.createElement('details'); panel.id = 'utility-panel'; panel.dir = 'rtl'; panel.open = true;
  const title = document.createElement('summary'); title.textContent = 'شبكات تجريبية — بيانات وهمية'; panel.append(title);
  const warning = document.createElement('p'); warning.className = 'utility-warning'; warning.textContent = 'المسارات والمواصفات مولّدة للتجربة فقط، ولا تمثّل شبكات حلب الحقيقية. هذه ليست محاكاة هندسية للتدفق أو الأحمال.'; panel.append(warning);
  const counts = document.createElement('p'); counts.style.fontSize = '11px';
  counts.textContent = `${data.edges.length.toLocaleString('ar')} مقطع · ${data.nodes.length.toLocaleString('ar')} عقدة وهمية`; panel.append(counts);
  const badge = document.createElement('div'); badge.id = 'utility-badge'; badge.textContent = 'محاكاة شبكات وهمية — لا تمثّل الواقع'; root.append(panel, badge);
  let visible = true, selectEnabled = true, cutaway = false, xray = false;
  const applyView=()=>{models.setXray(xray||cutaway);setCutaway(visible&&cutaway);onChange?.();};
  const layerInputs = new Map<NetworkKind, HTMLInputElement>();
  const master = document.createElement('button'); master.id = 'utilities-toggle'; master.textContent = 'إخفاء كل الشبكات'; master.setAttribute('aria-pressed', 'true'); panel.append(master);
  const preview = document.createElement('button'); preview.id='utilities-preview';preview.textContent='معاينة المرافق عن قرب';
  preview.onclick=()=>{const center=meta.citadel||[meta.W*meta.S/2,meta.H*meta.S/2];const node=data.nodes.filter(n=>n.kind==='electricity').sort((a,b)=>Math.hypot(a.point[0]-center[0],a.point[1]-center[1])-Math.hypot(b.point[0]-center[0],b.point[1]-center[1]))[0];if(node)focus?.(node.point[0],node.point[1],0);};panel.append(preview);
  const selection = document.createElement('section'); selection.id = 'utility-selection'; selection.setAttribute('aria-live', 'polite');
  const selectionHalo = new THREE.Mesh(new THREE.SphereGeometry(1.8, 12, 8), new THREE.MeshBasicMaterial({ color: '#ffffff', wireframe: true, depthTest: false, depthWrite: false }));
  selectionHalo.renderOrder = 30; selectionHalo.visible = false; group.add(selectionHalo);
  function clearSelection() { selection.replaceChildren(); selectionHalo.visible = false; }
  function updateVisibility() {
    group.visible = visible;
    badge.hidden = !visible;
    for (const kind of NETWORK_KINDS) layers.get(kind)!.visible = layerInputs.get(kind)!.checked;
    clearSelection();onChange?.();
  }
  for (const kind of NETWORK_KINDS) {
    const label = document.createElement('label'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true;
    checkbox.dataset.network = kind; layerInputs.set(kind, checkbox); checkbox.onchange = updateVisibility;
    const swatch = document.createElement('span'); swatch.className = 'utility-color'; swatch.style.background = NETWORKS[kind].color;
    label.append(checkbox, swatch, document.createTextNode(`${NETWORKS[kind].name} · ${NETWORKS[kind].overhead ? 'هوائي' : 'مدفون'}`)); panel.append(label);
    const legend = root.querySelector('#legend-items');
    if (legend) { const item = document.createElement('span'); item.className = 'legend-item'; item.append(swatch.cloneNode(true), document.createTextNode(`${NETWORKS[kind].name} — وهمية`)); legend.append(item); }
  }
  function checkbox(text: string, checked: boolean, onChange: (value: boolean) => void) {
    const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked;
    input.onchange = () => onChange(input.checked); label.append(input, document.createTextNode(text)); panel.append(label); return input;
  }
  checkbox('تحديد الشبكات بالنقر', true, value => { selectEnabled = value; if (!value) clearSelection(); });
  checkbox('ألوان توضيحية للشبكات', false, value => models.setTint(value));
  checkbox('رؤية الشبكات عبر الأرض والمباني', false, value => { xray = value; applyView(); });
  const cutawayInput = checkbox('إخفاء الأرض والمباني لفحص الشبكات', false, value => { cutaway = value; applyView(); });
  master.onclick = () => {
    visible = !visible; master.textContent = visible ? 'إخفاء كل الشبكات' : 'إظهار كل الشبكات'; master.setAttribute('aria-pressed', String(visible));
    applyView(); updateVisibility();
  };
  const exportButton = document.createElement('button'); exportButton.id = 'utilities-export'; exportButton.textContent = 'تنزيل البيانات الوهمية GeoJSON';
  exportButton.disabled = !data.edges.length;
  exportButton.onclick = () => {
    const blob = new Blob([JSON.stringify(networkGeoJson(data, meta))], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'aleppo-SIMULATED-utilities.geojson'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  panel.append(exportButton);
  const hint = document.createElement('p'); hint.style.cssText = 'font-size:11px;color:#bfd0dc;line-height:1.6';
  hint.textContent = 'كهرباء واتصالات هوائية على أعمدة، وصرف ومياه مدفونان بأقطار مختلفة. تظهر أغطية التفتيش والصمامات على الطريق. فعّل فحص تحت الأرض لرؤية الأنابيب. الأبعاد تقريبية وليست مخطط تنفيذ.'; panel.append(hint, selection);
  if (!data.edges.length) warning.textContent += ' لا توجد مسارات شوارع مناسبة ضمن حدود الخريطة.';
  function showItem(item: NetworkEdge | NetworkNode) {
    panel.open = true; selection.replaceChildren();
    const nodeNames={pole:'عمود',transformer:'عمود مع محول',manhole:'غرفة تفتيش',valve:'صمام مياه',junction:'وصلة أنابيب'};
    const heading = document.createElement('h3'); heading.textContent = `${NETWORKS[item.kind].name} — ${'from' in item ? 'خط وهمي' : nodeNames[item.nodeType] + ' وهمي'}`;
    const note = document.createElement('p'); note.className = 'utility-warning'; note.textContent = 'جميع القيم والمواقع التالية وهمية للتجربة فقط.';
    const table = document.createElement('table');
    const rows: Record<string, string | number> = { 'المعرّف التجريبي': item.id, [NETWORKS[item.kind].overhead ? 'ارتفاع التثبيت الافتراضي (م)' : 'العمق الافتراضي (م)']: NETWORKS[item.kind].overhead ? item.height : +item.depth.toFixed(2) };
    if ('from' in item) Object.assign(rows, { 'طول المقطع (م)': item.length, 'الشارع المرجعي': item.road, 'الحالة الافتراضية': item.status === 'maintenance' ? 'صيانة افتراضية' : 'طبيعي افتراضي', ...item.attributes });
    else rows['عدد المقاطع المتصلة'] = item.connections;
    for (const [key, value] of Object.entries(rows)) { const row = table.insertRow(); row.insertCell().textContent = key; row.insertCell().textContent = String(value); }
    const close = document.createElement('button'); close.textContent = 'إغلاق التحديد'; close.onclick = clearSelection;
    selection.append(heading, note, table, close);
    const point = 'from' in item ? [(item.from[0] + item.to[0]) / 2, (item.from[1] + item.to[1]) / 2] : item.point;
    const level='from' in item?(item.fromHeight+item.toHeight)/2:NETWORKS[item.kind].overhead?item.height:-item.depth;
    selectionHalo.position.set(point[0],level,-point[1]); selectionHalo.visible = true;
    const go=document.createElement('button');go.textContent='الاقتراب من العنصر';go.onclick=()=>focus?.(point[0],point[1],Math.max(0,level));selection.append(go);
  }
  return {
    data,
    get cutaway() { return visible && cutaway; },
    handlePick(ray: THREE.Raycaster): boolean {
      if (!visible || !selectEnabled) return false;
      const blocker=!xray&&!cutaway?ray.intersectObjects(solidObjects?.()||[],true)[0]:undefined;
      const item=models.pick(ray,blocker?.distance??Infinity);
      if (!item) return false;
      showItem(item); return true;
    },
    dispose() {
      setCutaway(false); cutawayInput.checked = false; group.removeFromParent();
      models.dispose();
      selectionHalo.geometry.dispose(); (selectionHalo.material as THREE.Material).dispose(); panel.remove(); badge.remove(); style.remove();
    },
  };
}
