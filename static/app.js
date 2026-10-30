'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sourceNames = {pose:'姿势参考', costume:'服装参考'};
const categoryNames = {'ランジェリー':'内衣', 'パーティ':'派对', '水着':'泳装', 'セクシー':'性感'};
const statusNames = {done:'完成', partial:'部分失败', running:'正在采集', failed:'失败', interrupted:'已中断', pending:'等待下载'};
const state = {view:'all', tag:'', page:1, items:[], selected:new Set(), current:null, pages:0};
let listRequest = 0, detailRequest = 0, toastTimer, searchTimer, catalogueVersion = '';
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 3500); }
async function api(path, data) {
  if (window.StaticLibrary) return window.StaticLibrary.request(path, data);
  const response = await fetch(path, data === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
function guard(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(e => toast(e.message)); }
function query() {
  const q = new URLSearchParams({page:state.page});
  q.set('sort',$('#gallerySort').value);
  if (state.view === 'pose' || state.view === 'costume') q.set('source', state.view);
  if (state.view === 'favorites') q.set('favorite', '1');
  if (state.view === 'trash') q.set('trash', '1');
  if (state.tag) q.set('tag', state.tag);
  for (const key of ['category','system','angle','state']) if ($('#'+key).value) q.set(key, $('#'+key).value);
  if ($('#search').value.trim()) q.set('q', $('#search').value.trim());
  return q;
}
function resetSelection() { state.selected.clear(); $('#selectPage').checked = false; $('#selectPage').indeterminate = false; updateBatch(); }
function updateBatch() {
  $('#batch').hidden = !state.selected.size; $('#selectedCount').textContent = `已选择 ${state.selected.size} 张`;
  for (const card of document.querySelectorAll('.card')) {
    const selected = state.selected.has(card.dataset.id); card.classList.toggle('selected', selected); card.querySelector('input').checked = selected;
  }
  const count = state.items.filter(i => state.selected.has(i.id)).length;
  $('#selectPage').checked = state.items.length > 0 && count === state.items.length;
  $('#selectPage').indeterminate = count > 0 && count < state.items.length;
}
async function loadItems() {
  const request = ++listRequest;
  let result;
  try{result=await api('/api/items?' + query());}
  catch(e){
    if($('#gallerySort').value==='default')throw e;
    $('#gallerySort').value='default';toast('热门排序暂不可用，已恢复默认排序');
    result=await api('/api/items?'+query());
  }
  if (request !== listRequest) return;
  state.items = result.items; state.pages = result.pages; resetSelection();
  $('#resultCount').textContent = `${result.total.toLocaleString()} 张图片${state.tag ? ' · 标签：' + state.tag : ''}`;
  $('#pageInfo').textContent = `${result.total ? state.page : 0} / ${result.pages} 页`;
  $('#prev').disabled = state.page <= 1; $('#next').disabled = state.page >= result.pages;
  if (!result.items.length) {
    $('#grid').innerHTML = `<div class="empty"><div class="eyebrow">A PLACE FOR YOUR NEXT IDEA</div><h2>${result.total ? '这一页暂无图片' : '这里还没有图片'}</h2><p>首次使用请点击右上角「采集图片」。<br>如果已经采集，请调整筛选条件或等待下载完成。</p></div>`; return;
  }
  $('#grid').innerHTML = result.items.map(i => `<article class="card" data-id="${esc(i.id)}"><label class="card-select"><input type="checkbox" aria-label="选择 ${esc(i.title)}"></label><button class="favorite-btn ${i.favorite?'on':''}" data-favorite aria-label="${i.favorite?'取消收藏':'收藏'}">${i.favorite?'★':'☆'}</button><button class="picture" data-open aria-label="查看 ${esc(i.title)}">${i.preview?`<img src="${esc(i.preview)}" loading="lazy" alt="${esc(i.title)}">`:'<span>等待下载</span>'}</button><div class="card-info"><div class="source">${sourceNames[i.source]}${i.angle?' / '+esc(i.angle):''}</div><h3>${esc(i.title)}</h3><p>${esc(categoryNames[i.category] || i.category)} · ${esc(i.remote_id)}</p>${i.tags.length?`<div class="card-tags">${i.tags.map(t=>'#'+esc(t)).join('　')}</div>`:''}</div></article>`).join('');
  $('#grid').querySelectorAll('img').forEach(img => img.addEventListener('error', () => { img.replaceWith(Object.assign(document.createElement('span'), {textContent:'本地文件缺失，请补采'})); }));
}
function options(id, rows, label) {
  const select = $('#'+id), value = select.value;
  select.innerHTML = `<option value="">${label}</option>` + rows.map(r=>`<option value="${esc(r.value)}">${esc(categoryNames[r.value]||r.value)} (${r.count})</option>`).join('');
  if (rows.some(r=>r.value===value)) select.value=value;
}
async function loadStats() {
  const s = await api('/api/stats');
  $('#total').textContent = s.total.toLocaleString(); $('#navTotal').textContent=s.total.toLocaleString();
  $('#downloaded').textContent=s.downloaded.toLocaleString(); $('#favorites').textContent=s.favorites.toLocaleString();
  $('#storage').textContent=s.bytes >= 1024**3 ? (s.bytes/1024**3).toFixed(2)+' GB' : (s.bytes/1024**2).toFixed(1)+' MB';
  options('category',s.category,'全部分类'); options('system',s.system,'全部体系'); options('angle',s.angle,'全部视角');
  $('#tagList').innerHTML = s.tags.length ? s.tags.map(t=>`<button class="${state.tag===t.value?'active':''}" data-tag="${esc(t.value)}">${esc(t.value)} <small>${t.count}</small></button>`).join('') : '<span class="muted">暂无标签</span>';
  $('#runs').innerHTML = s.runs.length ? s.runs.map(r=>`<div class="run"><div class="run-top"><b>${sourceNames[r.source]||esc(r.source)}</b><span>${statusNames[r.status]||esc(r.status)}</span></div><progress value="${r.completed}" max="${r.total||1}"></progress><p>${r.completed} / ${r.total} 个文件版本 · 失败 ${r.failed}<br>${esc(r.message)}<br>${esc(r.started_at)} UTC</p></div>`).join('') : '<p class="muted">还没有采集记录</p>';
}
async function refresh() {
  await loadStats();
  if(['ranking','trends'].includes(state.view))await window.GalleryAnalytics?.show(state.view);
  else await loadItems();
}
async function edit(ids, changes) { await api('/api/edit', {ids, changes}); }
async function openDetail(id) {
  const request = ++detailRequest;
  const item = await api('/api/item/' + encodeURIComponent(id));
  if (request !== detailRequest) return;
  state.current=item;
  if (!$('#detail').open) $('#detail').showModal();
  $('#detailTitle').textContent=item.title; $('#detailId').textContent=item.remote_id;
  $('#detailSource').textContent=sourceNames[item.source];
  $('#detailMeta').textContent=[categoryNames[item.category]||item.category,item.system,item.angle].filter(Boolean).join(' / ');
  $('#detailKeywords').textContent=item.keywords;
  $('#detailTags').value=item.tags.join(', '); $('#detailNote').value=item.note;
  $('#detailFavorite').textContent=item.favorite?'★ 已收藏':'☆ 收藏';
  $('#detailTrash').textContent=item.trashed?'从回收站恢复':'移入回收站';
  const image=$('#detailImage'), src=item.full||item.original||item.preview;
  image.hidden=!src; $('#imageMissing').hidden=!!src; $('#imageMissing').textContent='原图尚未下载';
  if (src) { image.src=src; image.alt=item.title; } else image.removeAttribute('src');
  $('#download').classList.toggle('disabled',!item.original);
  if (item.original) $('#download').href=item.original+'?download=1'; else $('#download').removeAttribute('href');
  $('#siblings').innerHTML=item.siblings.length>1?item.siblings.map(s=>`<button data-sibling="${esc(s.id)}" class="${s.id===id?'active':''}">${esc(s.angle||s.title)}</button>`).join(''):'';
  $('#assetStatus').textContent=item.assets.map(a=>`${{original:'原图',preview:'预览',thumb:'缩略图'}[a.variant]}：${statusNames[a.status]||a.status}${a.error?' · '+a.error:''}`).join('\n');
  window.GalleryAnalytics?.detail(item);
}
function detailDirty() { return state.current && ($('#detailTags').value !== state.current.tags.join(', ') || $('#detailNote').value !== state.current.note); }
function mayLeave() { return !detailDirty() || window.confirm('标签或备注尚未保存，是否放弃本次修改？'); }
window.confirmDiscardDetail=mayLeave;
function closeDetail() { if (mayLeave()) { ++detailRequest; $('#detail').close(); } }
async function stepDetail(delta) {
  if (!mayLeave()) return;
  const index=state.items.findIndex(i=>i.id===state.current?.id), target=state.items[index+delta];
  if (index>=0 && target) await openDetail(target.id);
}
$('#detailImage').onerror=()=>{ $('#detailImage').hidden=true; $('#imageMissing').hidden=false; $('#imageMissing').textContent='本地图片缺失，请重新采集补齐'; };
$('#grid').addEventListener('click', guard(async e=>{
  const card=e.target.closest('.card'); if (!card) return;
  const id=card.dataset.id;
  if (e.target.closest('[data-favorite]')) {
    const item=state.items.find(i=>i.id===id); await edit([id],{favorite:!item.favorite}); await refresh();
  } else if (e.target.closest('[data-open]')) await openDetail(id);
}));
$('#grid').addEventListener('change',e=>{ const card=e.target.closest('.card'); if (!card) return; e.target.checked?state.selected.add(card.dataset.id):state.selected.delete(card.dataset.id); updateBatch(); });
$('#selectPage').onchange=e=>{state.selected=new Set(e.target.checked?state.items.map(i=>i.id):[]);updateBatch();};
$('#clearSelection').onclick=resetSelection;
document.querySelector('nav').onclick=guard(async e=>{
  const button=e.target.closest('[data-view]'); if (!button) return;
  state.view=button.dataset.view; state.tag=''; state.page=1;
  await window.GalleryAnalytics?.show('');
  document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b===button));
  $('#viewTitle').textContent={all:'全部图片',pose:'姿势参考',costume:'服装参考',favorites:'我的收藏',trash:'回收站'}[state.view];
  for (const id of ['category','system','angle','state','search']) $('#'+id).value='';
  await refresh();
});
$('#discoveryNav').onclick=guard(async e=>{
  const button=e.target.closest('[data-discovery]');if(!button)return;
  state.view=button.dataset.discovery;resetSelection();
  document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b===button));
  $('#viewTitle').textContent=state.view==='ranking'?'热门排行':'趋势发现';
  await window.GalleryAnalytics?.show(state.view);
});
window.addEventListener('gallery-filter',guard(async e=>{
  const {field,value}=e.detail;
  const view=field==='source'?value:'all';
  state.view=view;state.tag='';state.page=1;resetSelection();
  document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  $('#viewTitle').textContent={all:'全部图片',pose:'姿势参考',costume:'服装参考'}[view];
  for(const id of ['category','system','angle','state','search'])$('#'+id).value='';
  await window.GalleryAnalytics?.show('');await loadStats();
  if(field!=='source')$('#'+field).value=value;
  await loadItems();
}));
$('#gallerySort').onchange=guard(async()=>{state.page=1;await loadItems();});
$('#tagList').onclick=guard(async e=>{
  const b=e.target.closest('[data-tag]');if(!b)return;
  if(['ranking','trends'].includes(state.view)){
    state.view='all';$('#viewTitle').textContent='全部图片';await window.GalleryAnalytics?.show('');
    document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view==='all'));
  }
  state.tag=state.tag===b.dataset.tag?'':b.dataset.tag;state.page=1;await refresh();
});
for(const id of ['category','system','angle','state']) $('#'+id).onchange=guard(async()=>{state.page=1;await loadItems();});
$('#search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(guard(async()=>{state.page=1;await loadItems();}),220);};
$('#reset').onclick=guard(async()=>{for(const id of ['category','system','angle','state','search'])$('#'+id).value='';$('#gallerySort').value='default';state.tag='';state.page=1;await refresh();});
$('#refresh').onclick=guard(refresh);
$('#prev').onclick=guard(async()=>{if(state.page>1){state.page--;await loadItems();window.scrollTo({top:0,behavior:'smooth'});}});
$('#next').onclick=guard(async()=>{if(state.page<state.pages){state.page++;await loadItems();window.scrollTo({top:0,behavior:'smooth'});}});
$('#closeDetail').onclick=closeDetail;
$('#detail').addEventListener('cancel',e=>{e.preventDefault();closeDetail();});
$('#detailPrev').onclick=guard(()=>stepDetail(-1));$('#detailNext').onclick=guard(()=>stepDetail(1));
document.addEventListener('keydown',guard(async e=>{if(!$('#detail').open || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;if(e.key==='ArrowLeft'){e.preventDefault();await stepDetail(-1);}if(e.key==='ArrowRight'){e.preventDefault();await stepDetail(1);}}));
$('#siblings').onclick=guard(async e=>{const b=e.target.closest('[data-sibling]');if(b&&mayLeave())await openDetail(b.dataset.sibling);});
$('#saveDetail').onclick=guard(async()=>{ const id=state.current.id;await edit([id],{tags:$('#detailTags').value.split(/[,，]/),note:$('#detailNote').value});await openDetail(id);await refresh();toast('标签与备注已保存'); });
$('#detailFavorite').onclick=guard(async()=>{const item=state.current;await edit([item.id],{favorite:!item.favorite});item.favorite=!item.favorite;$('#detailFavorite').textContent=item.favorite?'★ 已收藏':'☆ 收藏';await refresh();});
$('#detailTrash').onclick=guard(async()=>{if(!mayLeave())return;await edit([state.current.id],{trashed:!state.current.trashed});$('#detail').close();await refresh();toast('已更新回收站状态，图片文件保留在本地');});
$('#batch').onclick=guard(async e=>{
  const b=e.target.closest('[data-batch]');if(!b||!state.selected.size)return;
  if(b.dataset.batch==='tags'){$('#batchTags').value='';$('#tagDialog').showModal();return;}
  const actions={favorite:{favorite:true},unfavorite:{favorite:false},trash:{trashed:true},restore:{trashed:false}};
  await edit([...state.selected],actions[b.dataset.batch]);await refresh();toast('已保存所选图片');
});
$('#tagDialog').addEventListener('close',guard(async()=>{if($('#tagDialog').returnValue==='save'){await edit([...state.selected],{tags:$('#batchTags').value.split(/[,，]/)});await refresh();toast('已设置标签');}}));
$('#openSync').onclick=guard(async()=>{$('#sync').showModal();await loadStats();});$('#closeSync').onclick=()=>$('#sync').close();
$('#sync').addEventListener('click',guard(async e=>{const b=e.target.closest('[data-sync]');if(!b)return;const result=await api('/api/crawl',{source:b.dataset.sync});$('#syncMessage').textContent=result.message;await loadStats();}));
$('#export').onclick=guard(async()=>{const data=await api('/api/export?'+query());const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='reference-library-index.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已导出当前筛选结果的完整索引');});
window.GalleryAnalytics?.init(api,openDetail);
guard(refresh)();
let polling = false;
setInterval(async()=>{
  if(document.hidden || polling)return;
  polling=true;
  try {
    await loadStats();
    const version=$('#total').textContent+'|'+$('#downloaded').textContent;
    if(version!==catalogueVersion && !state.selected.size && !$('#detail').open && !['ranking','trends'].includes(state.view)){
      catalogueVersion=version;await loadItems();
    }
  }catch(e){ /* Keep the current gallery visible during brief server interruptions. */ }
  finally{polling=false;}
},4000);
