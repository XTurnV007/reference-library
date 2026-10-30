'use strict';
(() => {
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=name=>`<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const uuid=()=>{const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');};
const clone=value=>JSON.parse(JSON.stringify(value));
const now=()=>Date.now()/1000;
const isBrowser=document.body.dataset.runtime==='browser';
const kinds={person:'我的人像',cloth:'服装',pose:'姿势',work:'作品'};
const categories={'ランジェリー':'内衣','パーティ':'派对','水着':'泳装','セクシー':'性感'};
const statuses={queued:'排队中',running:'生成中',done:'已完成',failed:'失败',partial:'部分失败',cancelled:'已停止',interrupted:'服务曾中断'};
const defaults=()=>({person:null,cloth:null,poses:[],model:'',width:1024,height:1536,quality:'auto',variants:1,prompt:''});
let state={page:'studio',draftId:uuid(),title:'未命名创作',params:defaults(),kind:'cloth',assetLimit:60,pickerKind:'cloth',pickerLimit:60,activeJob:null};
let catalogue=[],uploads=[],works=[],drafts=[],jobs=[],models=[],status={},libraryFavorites=new Set();
let toastTimer,saveTimer,searchTimer,saveChain=Promise.resolve(),eventAbort=null,viewerRef=null,uploadKind='person';
let catalogueReady=false,requestSerial=0,renderSerial=0,dirtyVersion=0,savedVersion=0,importing=false,submitting=false;
const provider=window.ReferenceImageProvider;
const imageCache=new Map();
const referenceCache=new Map();
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4000);}
const guard=fn=>(...args)=>Promise.resolve().then(()=>fn(...args)).catch(e=>toast(e.message||'操作失败'));
function empty(title,text=''){return `<div class="empty-state">${icon('folder')}<h3>${esc(title)}</h3>${text?`<p>${esc(text)}</p>`:''}</div>`;}
function formatDate(value){return new Date(value*1000).toLocaleString('zh-CN',{hour12:false});}

// Static hosting stores private material locally. No uploaded bytes go to GitHub.
const browserDB=(()=>{
 let pending;
 function db(){if(!pending)pending=new Promise((resolve,reject)=>{const request=indexedDB.open('reference-creative-platform-v1',2);request.onupgradeneeded=()=>{for(const name of ['assets','drafts','works','jobs'])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name,{keyPath:'id'});};request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};request.onerror=()=>reject(new Error('浏览器存储不可用，请退出隐私模式或使用本地管理服务'));request.onblocked=()=>reject(new Error('请关闭此网站的旧标签页，再重试'));});return pending;}
 async function run(name,mode,action){const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction(name,mode);let result;tx.onerror=()=>reject(new Error('个人数据保存失败，可能是浏览器空间不足'));tx.onabort=()=>reject(new Error('个人数据保存中断'));tx.oncomplete=()=>resolve(result);const req=action(tx.objectStore(name));if(req)req.onsuccess=()=>{result=req.result;};});}
 const all=name=>run(name,'readonly',store=>store.getAll());
 const get=(name,id)=>run(name,'readonly',store=>store.get(id));
 const put=(name,value)=>run(name,'readwrite',store=>store.put(value));
 function publicAsset(asset){const {blob,...rest}=asset;return rest;}
 async function request(path,body){
  const [route,query='']=path.split('?');const q=new URLSearchParams(query);
  if(route==='/status')return {storage:'browser',private:true,max_upload_bytes:12*1024**2,...provider.info()};
  if(route==='/assets')return {assets:(await all('assets')).filter(a=>!a.trashed&&(!q.get('kind')||a.kind===q.get('kind'))).sort((a,b)=>b.created_at-a.created_at).map(publicAsset)};
  if(route==='/drafts'&&!body)return {drafts:(await all('drafts')).sort((a,b)=>b.updated_at-a.updated_at)};
  if(route==='/drafts'){
   const id=body.id||uuid(),old=await get('drafts',id),value={id,title:body.title,params:clone(body.params),created_at:old?.created_at||now(),updated_at:now()};await put('drafts',value);return value;
  }
  if(route==='/works'&&!body)return {works:(await all('works')).sort((a,b)=>b.created_at-a.created_at)};
  if(route==='/works/import'){
   if(!Array.isArray(body.asset_ids)||!body.asset_ids.length||body.asset_ids.length>20)throw new Error('每次导入 1–20 张作品');
   for(const id of body.asset_ids){const asset=await get('assets',id);if(!asset||asset.kind!=='work'||asset.trashed)throw new Error('作品图片已不存在');}
   const work={id:uuid(),title:body.title||'导入作品',source:'imported',params:clone(body.params||defaults()),favorite:false,created_at:now(),results:body.asset_ids.map((asset_id,position)=>({asset_id,position}))};await put('works',work);return {id:work.id};
  }
  if(route==='/assets/edit'||route==='/works/edit'){
   const table=route.startsWith('/assets')?'assets':'works',value=await get(table,body.id);if(!value)throw new Error('记录不存在');
   for(const field of table==='assets'?['favorite','trashed']:['favorite'])if(typeof body[field]==='boolean')value[field]=body[field];await put(table,value);return {ok:true};
  }
  if(route==='/jobs'||route.startsWith('/jobs/')||route==='/generations')return provider.request(route,body);
  throw new Error('此功能需要连接生成服务');
 }
 async function upload(kind,file){
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const existing=(await all('assets')).find(a=>a.kind===kind&&a.sha256===hash&&!a.trashed);if(existing)return publicAsset(existing);
  const value={id:uuid(),kind,name:file.name,mime:file.type,blob:file,sha256:hash,size:file.size,favorite:false,trashed:false,created_at:now()};await put('assets',value);return publicAsset(value);
 }
 async function blob(id){const asset=await get('assets',id);if(!asset)throw new Error('图片不存在');return asset.blob;}
 return {request,upload,blob,all,get,put};
})();

async function generationReference(ref){
 const cacheKey=ref.source+':'+ref.id;
 if(!referenceCache.has(cacheKey)){
  const pending=(async()=>{
   if(ref.source==='upload'){const blob=await browserDB.blob(ref.id);return {blob,note:''};}
   const item=resolve(ref);if(!item)throw new Error('参考素材已不存在，请重新选择');
   if(!item.original)throw new Error('此素材没有可读取的原图，已停止提交。请手动上传原图。');
   const original=new URL(item.original,location.href);
   if(original.hostname==='github.com'&&original.pathname.includes('/releases/download/'))throw new Error('此图库原图位于 GitHub Releases，无法供浏览器跨域读取。已停止提交，不会使用预览图代替；请手动上传原图。');
   try{
    const response=await fetch(original.href,{credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error();
    const blob=await response.blob();
    if(!['image/png','image/jpeg','image/webp'].includes(blob.type)||!blob.size||blob.size>50*1024**2)throw new Error();
    return {blob,note:''};
   }catch(_){throw new Error('无法读取图库原图，已停止提交，不会使用预览图代替。请手动上传原图。');}
  })();referenceCache.set(cacheKey,pending);pending.catch(()=>referenceCache.delete(cacheKey));
 }
 return referenceCache.get(cacheKey);
}

async function api(path,body){
 if(isBrowser)return browserDB.request(path,body);
 const response=await fetch('/api/studio'+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
 const result=await response.json();if(!response.ok)throw new Error(result.error||'服务请求失败');return result;
}
function assetRef(asset){return {source:'upload',id:asset.id};}
function libraryRef(item){return {source:'library',id:item.id};}
function resolve(ref){
 if(!ref)return null;
 if(ref.source==='upload'){const asset=uploads.find(a=>a.id===ref.id);return asset?{...asset,ref,private:true,title:asset.name}:null;}
 const item=catalogue.find(i=>i.id===ref.id);return item?{...item,kind:item.source==='pose'?'pose':'cloth',ref,private:false,title:item.title}:null;
}
async function imageURL(ref,full=false){
 if(ref.source==='library'){
  const item=catalogue.find(i=>i.id===ref.id);if(!item)throw new Error('图库素材不存在');
  const url=full?(item.original||item.full||item.preview):item.preview;
  if(!url)throw new Error('图片尚未下载');return url;
 }
 if(!imageCache.has(ref.id)){
  const pending=(async()=>{let blob;if(isBrowser)blob=await browserDB.blob(ref.id);else{const response=await fetch('/api/studio/files/'+encodeURIComponent(ref.id));if(!response.ok)throw new Error('私有图片不可用');blob=await response.blob();}return URL.createObjectURL(blob);})();
  imageCache.set(ref.id,pending);pending.catch(()=>imageCache.delete(ref.id));
 }
 return imageCache.get(ref.id);
}
async function hydrate(container){
 await Promise.all([...container.querySelectorAll('img[data-ref-source]')].map(async image=>{
  try{image.src=await imageURL({source:image.dataset.refSource,id:image.dataset.refId});image.onerror=()=>{image.alt='图片不可用';image.classList.add('image-missing');};}
  catch(_){image.alt='图片不可用';image.classList.add('image-missing');}
 }));
}
function imageTag(ref,title,cls=''){return `<img class="${cls}" data-ref-source="${esc(ref.source)}" data-ref-id="${esc(ref.id)}" alt="${esc(title)}" loading="lazy">`;}
function validateFile(file){if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>12*1024**2||!file.size)throw new Error('请选择 12 MB 以内的 PNG、JPG 或 WebP 图片');}
async function uploadFile(kind,file){validateFile(file);const h=new Uint8Array(await file.slice(0,12).arrayBuffer()),ascii=(start,end)=>String.fromCharCode(...h.slice(start,end));const valid=(h[0]===137&&ascii(1,4)==='PNG')||(h[0]===255&&h[1]===216&&h[2]===255)||(ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP');if(!valid)throw new Error('文件内容不是支持的 PNG、JPG 或 WebP 图片');if(isBrowser)return browserDB.upload(kind,file);const q=new URLSearchParams({kind,name:file.name.slice(0,180)});const response=await fetch('/api/studio/uploads?'+q,{method:'POST',headers:{'Content-Type':file.type},body:file});const result=await response.json();if(!response.ok)throw new Error(result.error||'上传失败');return result;}
async function refreshPrivate(){const result=await Promise.all([api('/assets'),api('/works'),api('/drafts'),api('/jobs')]);uploads=result[0].assets;works=result[1].works;drafts=result[2].drafts;jobs=result[3].jobs;$('#taskDot').hidden=!jobs.some(j=>['queued','running'].includes(j.status));}
async function loadCatalogue(){
 try{const response=await fetch(isBrowser?'./catalog.json?v=20261031-cors':'/api/export',{cache:'no-store'});if(!response.ok)throw new Error('素材清单加载失败');catalogue=(await response.json()).items;catalogueReady=true;}
 catch(e){catalogue=[];catalogueReady=false;toast('公开图库暂不可用，你仍可上传自己的参考图。');}
}
async function setLibraryFavorite(id,value){
 if(isBrowser){
  let annotations={};try{annotations=JSON.parse(localStorage.getItem('reference-library.annotations.v1')||'{}');}catch(_){}
  if(!annotations||typeof annotations!=='object'||Array.isArray(annotations))annotations={};
  annotations[id]={...(annotations[id]||{}),favorite:value};
  localStorage.setItem('reference-library.annotations.v1',JSON.stringify(annotations));
 }else{
  const response=await fetch('/api/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[id],changes:{favorite:value}})});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'收藏保存失败');
 }
 if(value)libraryFavorites.add(id);else libraryFavorites.delete(id);
 try{localStorage.setItem('reference-platform.library-favorites',JSON.stringify([...libraryFavorites]));}catch(_){}
}
function snapshot(){return {id:state.draftId,title:$('#draftTitle').value.trim()||'未命名创作',params:clone(state.params)};}
function markDirty(){dirtyVersion++;$('#draftStatus').textContent='尚未保存';clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveDraft().catch(e=>{$('#draftStatus').textContent='保存失败：'+e.message;}),700);}
function saveDraft(){
 clearTimeout(saveTimer);const current=snapshot(),version=dirtyVersion;
 saveChain=saveChain.catch(()=>{}).then(async()=>{
  const result=await api('/drafts',current);
  if(state.draftId===result.id){savedVersion=Math.max(savedVersion,version);$('#draftStatus').textContent=dirtyVersion===version?'已保存 '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'有新修改，等待保存';}
  drafts=(await api('/drafts')).drafts;return result;
 });return saveChain;
}
function updateSettings(){
 $('#draftTitle').value=state.title;$('#prompt').value=state.params.prompt;$('#variants').value=String(state.params.variants);
 $('#quality').value=state.params.quality||'auto';$('#quality').disabled=!isBrowser;
 const current=state.params.model;
 $('#model').innerHTML=models.length?models.map(m=>`<option value="${esc(m.id)}">${esc(m.label||m.id)}</option>`).join(''):'<option value="">尚未接入模型</option>';
 $('#model').disabled=!models.length;
 state.params.model=models.some(m=>m.id===current)?current:(models[0]?.id||'');$('#model').value=state.params.model;
 sizeOptions();renderPlan();
}
function sizeOptions(){
 const capability=models.find(m=>m.id===state.params.model);
 const sizes=capability?.sizes||[[768,1024],[1536,2048],[1024,1024]];
 const value=state.params.width+'x'+state.params.height;
 $('#size').innerHTML=sizes.map(([w,h])=>`<option value="${w}x${h}">${w}×${h}</option>`).join('');
 if(sizes.some(([w,h])=>w+'x'+h===value))$('#size').value=value;
 else{[state.params.width,state.params.height]=sizes[0];$('#size').value=sizes[0].join('x');}
}
function renderPlan(){
 const count=state.params.poses.length*state.params.variants;
 $('#plan').textContent=`${state.params.poses.length} 个姿势 · 共 ${count} 张`;
 const gcd=(a,b)=>b?gcd(b,a%b):a,div=gcd(state.params.width,state.params.height);
 $('#aspect').textContent=(state.params.width/div)+':'+(state.params.height/div);
 $('#poseCount').textContent=state.params.poses.length;
 const paused=isBrowser&&status.paused;
 const ready=!paused&&models.length&&resolve(state.params.person)&&resolve(state.params.cloth)&&state.params.poses.length&&state.params.poses.every(resolve)&&!submitting&&!jobs.some(j=>['queued','running'].includes(j.status));
 $('#generate').disabled=!ready;
 $('#generate').textContent=paused?'生图已暂停':submitting?'准备参考图…':!models.length?'请先配置模型':`生成 ${count} 张`;
 $('#modelNotice').textContent=paused?status.message:models.length?(isBrowser?'每张单独请求并计费，结果逐张返回。请保持此标签页打开；原图无法读取时会停止提交。':'每张图片单独返回；提交后可切换页面，任务会继续执行。'):status.message||'请在设置中配置模型。';
}
function referenceCard(ref,kind,index){const item=resolve(ref),title=item?.title||'引用已失效';return `<div class="reference-card"><button class="reference-image" data-view-ref="${esc(ref.id)}" data-ref-source="${esc(ref.source)}" aria-label="查看 ${esc(title)}">${item?imageTag(ref,title):'<span>素材已移除</span>'}</button><button class="remove-reference" data-remove-kind="${kind}" data-index="${index}" aria-label="移除 ${esc(title)}">${icon('close')}</button><span class="reference-caption">${esc(item?.angle?item.angle+' · '+title:title)}</span></div>`;}
async function renderReferences(){
 const serial=++renderSerial,person=resolve(state.params.person);
 $('#personReference').innerHTML=person?imageTag(person.ref,person.title,'person-image')+`<div class="person-caption">${esc(person.title)}<small>仅用于当前角色参考</small><button class="text-button" data-remove-kind="person">移除</button></div>`:'<button class="reference-placeholder" data-upload="person">上传人像参考图</button>';
 $('#clothReference').innerHTML=state.params.cloth?referenceCard(state.params.cloth,'cloth',0):'<button class="reference-placeholder" data-picker="cloth">选择或上传一套服装</button>';
 $('#poseReferences').innerHTML=state.params.poses.length?state.params.poses.map((ref,i)=>referenceCard(ref,'pose',i)).join(''):'<button class="reference-placeholder" data-picker="pose">选择姿势与视角，可多选</button>';
 renderPlan();await Promise.all(['#personReference','#clothReference','#poseReferences'].map(s=>hydrate($(s))));if(serial!==renderSerial)return;
}
function choose(ref,kind,toggle=false){
 if(kind==='person')state.params.person=ref;
 if(kind==='cloth')state.params.cloth=ref;
 if(kind==='pose'){
  const existing=state.params.poses.findIndex(r=>r.id===ref.id&&r.source===ref.source);
  if(existing>=0){if(toggle)state.params.poses.splice(existing,1);}
  else{if(state.params.poses.length>=20)throw new Error('最多选择 20 个姿势视角');state.params.poses.push(ref);}
 }
 markDirty();renderReferences().catch(e=>toast(e.message));
}
function showPage(page){
 state.page=page;
 for(const name of ['studio','works','assets','settings'])$('#'+name+'Page').hidden=name!==page;
 $('#pageName').textContent={studio:'工作台',works:'我的作品',assets:'素材库',settings:'设置'}[page];$('#toggleConfig').hidden=page!=='studio';
 document.querySelectorAll('.rail-button[data-page]').forEach(b=>{if(b.dataset.page===page)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
 if(page==='works')renderWorks();if(page==='assets'){updateCategories(false);renderMaterials(false);}if(page==='settings')renderSettings();
 history.replaceState(null,'','#'+page);
}
async function newDraft(){if(dirtyVersion>savedVersion)await saveDraft();state.draftId=uuid();state.title='未命名创作';state.params={...clone(state.params),prompt:''};dirtyVersion=0;savedVersion=0;state.activeJob=null;eventAbort?.abort();$('#draftStatus').textContent='新草稿';updateSettings();await renderReferences();renderResults(null);showPage('studio');document.body.classList.remove('config-hidden');$('#toggleConfig').setAttribute('aria-expanded','true');}
function materialRows(kind){
 const publicItems=kind==='person'?[]:catalogue.filter(i=>i.source===(kind==='cloth'?'costume':'pose')).map(i=>({...i,kind,title:i.title,ref:libraryRef(i),private:false,favorite:libraryFavorites.has(i.id)}));
 return [...uploads.filter(a=>a.kind===kind).map(a=>({...a,title:a.name,ref:assetRef(a),private:true})),...publicItems];
}
function isSelected(ref,kind){return (kind==='pose'?state.params.poses:[state.params[kind]]).some(r=>r&&r.id===ref.id&&r.source===ref.source);}
function updateCategories(picker){
 const kind=picker?state.pickerKind:state.kind,select=$(picker?'#pickerCategory':'#assetCategory'),old=select.value;
 const values=[...new Set(materialRows(kind).map(r=>r.category).filter(Boolean))].sort();select.innerHTML='<option value="">全部分类</option>'+values.map(c=>`<option value="${esc(c)}">${esc(categories[c]||c)}</option>`).join('');if(values.includes(old))select.value=old;
}
function filteredMaterials(picker){
 const kind=picker?state.pickerKind:state.kind,q=$(picker?'#pickerSearch':'#assetSearch').value.toLowerCase().trim().split(/\s+/).filter(Boolean),category=$(picker?'#pickerCategory':'#assetCategory').value;
 const mine=$(picker?'#pickerMine':'#myUploads').checked,favorite=!picker&&$('#favoriteAssets').checked;
 return materialRows(kind).filter(item=>(!mine||item.private)&&(!favorite||item.favorite)&&(!category||item.category===category)&&q.every(word=>[item.title,item.remote_id,item.category,item.angle,item.system,item.keywords].join(' ').toLowerCase().includes(word)));
}
async function renderMaterials(picker){
 const kind=picker?state.pickerKind:state.kind,container=$(picker?'#pickerGrid':'#assetsGrid'),limit=picker?state.pickerLimit:state.assetLimit;
 const rows=filteredMaterials(picker);container.innerHTML=rows.slice(0,limit).map(item=>{
  const selected=isSelected(item.ref,kind);
  return `<article class="material ${selected?'chosen':''}"><button class="material-image" data-view-ref="${esc(item.id)}" data-ref-source="${item.ref.source}" aria-label="查看 ${esc(item.title)}">${imageTag(item.ref,item.title)}</button><p class="material-name">${esc(item.title)}</p><p class="material-description">${esc(item.private?'我的上传':[categories[item.category]||item.category,item.angle,item.remote_id].filter(Boolean).join(' · '))}</p><div class="material-actions"><button class="quiet" data-use-ref="${esc(item.id)}" data-ref-source="${item.ref.source}" data-kind="${kind}" data-toggle="${picker&&kind==='pose'}">${picker?(selected?'已选择':'选择'):'用于创作'}</button><div class="action-row"><button class="icon-button favorite ${item.favorite?'on':''}" data-favorite-ref="${esc(item.id)}" data-ref-source="${item.ref.source}" aria-label="${item.favorite?'取消收藏':'收藏'}">${icon('star')}</button>${item.private?`<button class="icon-button" data-trash-asset="${esc(item.id)}" aria-label="移除素材">${icon('close')}</button>`:''}</div></div></article>`;
 }).join('')||empty('暂无素材',catalogueReady?'可以上传图片，或调整筛选条件。':'公开图库未加载，可先上传自己的参考图。');
 if(picker){$('#pickerStatus').textContent=`${rows.length} 个素材 · 已选 ${kind==='pose'?state.params.poses.length:state.params[kind]?1:0} 个`;$('#morePicker').hidden=rows.length<=limit;}
 else{$('#assetCount').textContent=`${rows.length} 个素材`+(!isBrowser?' · 私人上传保存到服务器工作区':' · 私人上传仅在当前浏览器');$('#moreAssets').hidden=rows.length<=limit;}
 await hydrate(container);
}
async function openPicker(kind){state.pickerKind=kind;state.pickerLimit=60;$('#pickerTitle').textContent='选择'+kinds[kind];$('#pickerSearch').value='';$('#pickerMine').checked=kind==='person';updateCategories(true);$('#picker').showModal();await renderMaterials(true);}
async function viewImage(ref,kind){viewerRef={ref,kind};const item=resolve(ref);$('#viewerTitle').textContent=item?.title||'作品图片';$('#viewerUse').hidden=!kind||kind==='work';$('#viewerImage').removeAttribute('src');$('#viewerImage').alt=item?.title||'作品图片';$('#viewer').showModal();$('#viewerImage').src=await imageURL(ref,true);}
async function download(ref){const url=await imageURL(ref,true),a=document.createElement('a'),item=resolve(ref),extension=item?.mime==='image/webp'?'.webp':item?.mime==='image/jpeg'?'.jpg':'.png';a.href=url;a.download=(item?.title||'reference-image').replace(/\.(png|jpe?g|webp)$/i,'')+extension;if(ref.source==='library'){a.target='_blank';a.rel='noreferrer';}document.body.append(a);a.click();a.remove();}
function resultMarkup(ref,label,note=''){return `<article><button class="result-stage" data-view-ref="${esc(ref.id)}" data-ref-source="${ref.source}" aria-label="查看 ${esc(label)}">${imageTag(ref,label)}</button><div class="result-meta"><span>${esc(label)}</span><button class="icon-button" data-download-ref="${esc(ref.id)}" data-ref-source="${ref.source}" aria-label="下载图片">${icon('download')}</button></div>${note?`<p class="hint">${esc(note)}</p>`:''}</article>`;}
async function renderWorks(){
 const list=works.filter(w=>!$('#favoriteWorks').checked||w.favorite);
 $('#worksList').innerHTML=list.map(work=>`<section class="work-batch"><div class="work-header"><div><h2>${esc(work.title)}</h2><p>${work.source==='imported'?'用户导入':'模型生成'} · ${formatDate(work.created_at)} · ${work.results.length} 张</p></div><div class="action-row"><button class="quiet" data-reuse-work="${esc(work.id)}">复用参数</button><button class="icon-button favorite ${work.favorite?'on':''}" data-favorite-work="${esc(work.id)}" aria-label="收藏此批作品">${icon('star')}</button></div></div><div class="work-images">${work.results.map((r,i)=>resultMarkup({source:'upload',id:r.asset_id},'作品 '+(i+1))).join('')||'<p class="hint">此批次尚未产生成功图片。</p>'}</div></section>`).join('')||empty('还没有作品','接入模型后保存生成结果，也可以先导入已有作品。');
 await hydrate($('#worksList'));
}
function renderSettings(){
 const connection=isBrowser?provider.info():null;
 $('#modelSettingsStatus').textContent=isBrowser?(connection.paused?'提交已暂停':connection.verified?'已成功生成':connection.configured?'已填写 · 待验证':'待填写密钥'):(models.length?'已连接':'未接入');
 $('#modelSettingsMessage').textContent=isBrowser?(connection.paused?connection.message:'云端转发至 ai.cursorai.art · 多图编辑。人像、服装、当前姿势按此顺序上传。密钥不会写入 GitHub；只有点击生成才会提交图片。'):models.length?`当前 ${models.length} 个模型可用。`:'请打开 GitHub 在线版配置本次图像接口；当前本地管理服务未接入模型。';
 $('#providerSettings').hidden=!isBrowser;
 $('#dataLocation').textContent=isBrowser?'私人图片、草稿与作品保存在当前浏览器。清除站点数据会移除这些内容；请保留自己的原始图片。':'私人图片、草稿、作品与任务记录保存在服务器数据目录的 studio/ 子目录中。';
}
async function openDrafts(){drafts=(await api('/drafts')).drafts;$('#draftList').innerHTML=drafts.map(d=>`<div class="draft-row"><div><strong>${esc(d.title)}</strong><small>${formatDate(d.updated_at)} · ${d.params.poses.length} 个姿势</small></div><button class="quiet" data-open-draft="${esc(d.id)}">打开</button></div>`).join('')||'<p class="hint">还没有保存的草稿。</p>';$('#draftsDialog').showModal();}
async function loadDraft(draft){if(dirtyVersion>savedVersion)await saveDraft();state.draftId=draft.id;state.title=draft.title;state.params=clone(draft.params);state.activeJob=null;eventAbort?.abort();dirtyVersion=0;savedVersion=0;updateSettings();await renderReferences();renderResults(null);showPage('studio');$('#draftStatus').textContent='已恢复草稿';}
async function reuse(work){if(dirtyVersion>savedVersion)await saveDraft();state.draftId=uuid();state.title=(work.title+' · 新创作').slice(0,100);state.params=clone(work.params);state.activeJob=null;eventAbort?.abort();updateSettings();await renderReferences();renderResults(null);showPage('studio');markDirty();toast('已复用参数，原作品保持不变');}
async function renderResults(job){
 if(!job){$('#jobStatus').textContent='';$('#batchSummary').textContent='';$('#jobActions').hidden=true;$('#results').innerHTML=empty('图片会出现在这里',models.length?'左侧选好参考图片后开始生成。':'模型尚未接入，可先上传素材、保存草稿或导入作品。');return;}
 $('#jobStatus').textContent=`${statuses[job.status]||job.status} · ${job.tasks.filter(t=>t.status==='done').length}/${job.tasks.length} 张`;
 $('#batchSummary').textContent=`${job.params.model} · ${job.params.width}×${job.params.height} · ${formatDate(job.created_at)}`;
 $('#jobActions').hidden=!['queued','running','failed','partial'].includes(job.status);$('#cancelJob').hidden=!['queued','running'].includes(job.status);$('#retryJob').hidden=(isBrowser&&status.paused)||!job.tasks.some(t=>t.status==='failed');
 $('#results').innerHTML=job.tasks.map(task=>{
  const pose=resolve(task.spec.pose),label=(pose?.angle||pose?.title||'姿势')+' · '+(task.spec.variation+1);
  const note=(task.reference_notes||[]).join(' ');
  return task.status==='done'?resultMarkup({source:'upload',id:task.asset_id},label,note):`<article><div class="result-stage"><div class="result-message ${task.status==='failed'?'error':''}">${esc(statuses[task.status]||task.status)}${task.error?'<br>'+esc(task.error):''}</div></div><div class="result-meta"><span>${esc(label)}</span></div>${note?`<p class="hint">${esc(note)}</p>`:''}</article>`;
 }).join('');await hydrate($('#results'));
}
async function syncJob(id){const job=await api('/jobs/'+encodeURIComponent(id));if(state.activeJob!==id)return;await refreshPrivate();await renderResults(job);renderPlan();if(state.page==='works')await renderWorks();if(state.page==='settings')renderSettings();}
async function watchJob(id){
 eventAbort?.abort();const controller=new AbortController();eventAbort=controller;state.activeJob=id;let after=0;
 while(!controller.signal.aborted&&state.activeJob===id){
  try{
   await syncJob(id);const job=await api('/jobs/'+encodeURIComponent(id));if(!['queued','running'].includes(job.status))return;
   if(isBrowser){await new Promise(resolve=>setTimeout(resolve,1000));continue;}
   const response=await fetch('/api/studio/events?'+new URLSearchParams({id,after}),{signal:controller.signal});if(!response.ok)throw new Error('事件连接中断');
   const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
   while(!controller.signal.aborted){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true}).replace(/\r\n/g,'\n');let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){const record=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);for(const line of record.split('\n'))if(line.startsWith('id:'))after=Math.max(after,Number(line.slice(3))||0);if(record.includes('data:'))await syncJob(id);}}
  }catch(e){if(controller.signal.aborted)return;$('#jobStatus').textContent='连接中断，正在恢复任务状态…';}
  await new Promise(resolve=>setTimeout(resolve,1800));
 }
}
async function generate(){
 if(isBrowser&&status.paused){toast(status.message);return;}
 if(submitting)return;
 if(!models.length){toast('模型尚未接入，未创建任务');return;}
 if(state.params.poses.length*state.params.variants>20){if(!confirm('本次将创建较多任务，请确认模型的真实费用规则。是否继续？'))return;}
 submitting=true;renderPlan();$('#configError').textContent='';
 try{await saveDraft();const job=await api('/generations',{title:state.title,params:clone(state.params),idempotency_key:uuid()});state.activeJob=job.id;await refreshPrivate();watchJob(job.id).catch(e=>toast(e.message));}
 catch(e){$('#configError').textContent=e.message;}finally{submitting=false;renderPlan();}
}
async function boot(){
 if(isBrowser)await provider.initialize({storage:browserDB,reference:generationReference,newId:uuid,copy:clone,notify:id=>{if(state.activeJob===id)syncJob(id).catch(e=>toast(e.message));else refreshPrivate().then(()=>{renderPlan();if(state.page==='works')return renderWorks();}).catch(()=>{});}});
 try{const saved=localStorage.getItem('reference-platform.theme')||'system';$('#theme').value=saved;document.documentElement.dataset.theme=saved;libraryFavorites=new Set(JSON.parse(localStorage.getItem('reference-platform.library-favorites')||'[]'));}catch(_){}
 const loaded=await Promise.all([api('/status'),loadCatalogue()]);status=loaded[0];models=status.models||[];
 if(!isBrowser)libraryFavorites=new Set(catalogue.filter(i=>i.favorite).map(i=>i.id));
 else{try{const legacy=localStorage.getItem('reference-library.annotations.v1');if(legacy){const annotations=JSON.parse(legacy);libraryFavorites=new Set(Object.keys(annotations).filter(id=>annotations[id]?.favorite));}}catch(_){}}
 await refreshPrivate();$('#storageLabel').textContent=isBrowser?'浏览器私有存储':'本地工作区';
 if(drafts.length){state.draftId=drafts[0].id;state.title=drafts[0].title;state.params=clone(drafts[0].params);$('#draftStatus').textContent='已恢复最近草稿';}
 updateSettings();await renderReferences();await renderResults(null);renderSettings();
 const page=location.hash.slice(1);showPage(['studio','works','assets','settings'].includes(page)?page:'studio');
 const active=jobs.find(j=>['queued','running'].includes(j.status))||jobs[0];if(active)watchJob(active.id).catch(e=>toast(e.message));
}

document.addEventListener('click',guard(async e=>{
 const page=e.target.closest('[data-page]'),close=e.target.closest('[data-close]'),upload=e.target.closest('[data-upload]'),picker=e.target.closest('[data-picker]'),remove=e.target.closest('[data-remove-kind]'),use=e.target.closest('[data-use-ref]'),view=e.target.closest('[data-view-ref]'),favorite=e.target.closest('[data-favorite-ref]'),trash=e.target.closest('[data-trash-asset]'),workFavorite=e.target.closest('[data-favorite-work]'),reuseButton=e.target.closest('[data-reuse-work]'),openDraft=e.target.closest('[data-open-draft]'),downloadButton=e.target.closest('[data-download-ref]');
 if(page)showPage(page.dataset.page);if(close)$('#'+close.dataset.close).close();
 if(upload){uploadKind=upload.dataset.upload;$('#uploadInput').multiple=uploadKind==='pose';$('#uploadInput').value='';$('#uploadInput').click();}
 if(picker)await openPicker(picker.dataset.picker);
 if(remove){const kind=remove.dataset.removeKind;if(kind==='pose')state.params.poses.splice(Number(remove.dataset.index),1);else state.params[kind]=null;markDirty();await renderReferences();}
 if(use){const ref={source:use.dataset.refSource,id:use.dataset.useRef};choose(ref,use.dataset.kind,use.dataset.toggle==='true');if($('#picker').open){await renderMaterials(true);if(use.dataset.kind!=='pose')$('#picker').close();}else showPage('studio');}
 if(view){const ref={source:view.dataset.refSource,id:view.dataset.viewRef};const item=resolve(ref);await viewImage(ref,item?.kind);}
 if(favorite){const ref={source:favorite.dataset.refSource,id:favorite.dataset.favoriteRef};if(ref.source==='library'){await setLibraryFavorite(ref.id,!libraryFavorites.has(ref.id));}else{const asset=uploads.find(a=>a.id===ref.id);await api('/assets/edit',{id:ref.id,favorite:!asset.favorite});await refreshPrivate();}if($('#picker').open)await renderMaterials(true);if(state.page==='assets')await renderMaterials(false);}
 if(trash){if(!confirm('从素材库移除此上传？已有作品文件会保留。'))return;await api('/assets/edit',{id:trash.dataset.trashAsset,trashed:true});await refreshPrivate();await renderReferences();if($('#picker').open)await renderMaterials(true);if(state.page==='assets')await renderMaterials(false);}
 if(workFavorite){const work=works.find(w=>w.id===workFavorite.dataset.favoriteWork);await api('/works/edit',{id:work.id,favorite:!work.favorite});await refreshPrivate();await renderWorks();}
 if(reuseButton)await reuse(works.find(w=>w.id===reuseButton.dataset.reuseWork));
 if(openDraft){const draft=drafts.find(d=>d.id===openDraft.dataset.openDraft);await loadDraft(draft);$('#draftsDialog').close();}
 if(downloadButton)await download({source:downloadButton.dataset.refSource,id:downloadButton.dataset.downloadRef});
}));
$('#newDraft').onclick=guard(newDraft);$('#saveDraft').onclick=guard(async()=>{await saveDraft();toast('草稿已保存');});$('#openDrafts').onclick=guard(openDrafts);
$('#toggleConfig').onclick=()=>{const hidden=document.body.classList.toggle('config-hidden');$('#toggleConfig').setAttribute('aria-expanded',String(!hidden));};
$('#draftTitle').oninput=()=>{state.title=$('#draftTitle').value;markDirty();};$('#prompt').oninput=()=>{state.params.prompt=$('#prompt').value;markDirty();};
$('#variants').onchange=()=>{state.params.variants=Number($('#variants').value);renderPlan();markDirty();};$('#size').onchange=()=>{[state.params.width,state.params.height]=$('#size').value.split('x').map(Number);renderPlan();markDirty();};$('#model').onchange=()=>{state.params.model=$('#model').value;sizeOptions();renderPlan();markDirty();};
$('#quality').onchange=()=>{state.params.quality=$('#quality').value;markDirty();};
$('#generate').onclick=guard(generate);$('#cancelJob').onclick=guard(async()=>{if(state.activeJob){const r=await api('/jobs/'+state.activeJob+'/cancel',{});toast(r.message);await syncJob(state.activeJob);}});$('#retryJob').onclick=guard(async()=>{if(isBrowser&&status.paused){toast(status.message);return;}if(!state.activeJob)return;if(!confirm('重新提交失败项可能产生新的费用。是否重试？'))return;const job=await api('/jobs/'+state.activeJob+'/retry',{idempotency_key:uuid()});watchJob(job.id).catch(e=>toast(e.message));});
$('#assetTabs').onclick=guard(async e=>{const button=e.target.closest('[data-kind]');if(!button)return;state.kind=button.dataset.kind;state.assetLimit=60;$('#assetCategory').value='';document.querySelectorAll('#assetTabs button').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));updateCategories(false);await renderMaterials(false);});
for(const id of ['assetCategory','favoriteAssets','myUploads'])$('#'+id).onchange=guard(async()=>{state.assetLimit=60;await renderMaterials(false);});$('#assetSearch').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(guard(async()=>{state.assetLimit=60;await renderMaterials(false);}),180);};
for(const id of ['pickerCategory','pickerMine'])$('#'+id).onchange=guard(async()=>{state.pickerLimit=60;await renderMaterials(true);});$('#pickerSearch').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(guard(async()=>{state.pickerLimit=60;await renderMaterials(true);}),180);};
$('#moreAssets').onclick=guard(async()=>{state.assetLimit+=60;await renderMaterials(false);});$('#morePicker').onclick=guard(async()=>{state.pickerLimit+=60;await renderMaterials(true);});$('#favoriteWorks').onchange=guard(renderWorks);
$('#uploadMaterial').onclick=()=>{uploadKind=state.kind;$('#uploadInput').multiple=uploadKind==='pose';$('#uploadInput').value='';$('#uploadInput').click();};
async function importReferences(files,kind){if(!files.length)return;if(kind==='pose'&&state.params.poses.length+files.length>20)throw new Error('最多选择 20 个姿势视角');for(const file of files)validateFile(file);let count=0;for(const file of files){const asset=await uploadFile(kind,file);uploads=[asset,...uploads.filter(a=>a.id!==asset.id)];choose(assetRef(asset),kind);count++;$('#draftStatus').textContent=`已载入 ${count}/${files.length} 张参考图`;}await refreshPrivate();await renderReferences();if(state.page==='assets')await renderMaterials(false);toast('参考图已保存');}
$('#uploadInput').onchange=guard(async e=>{await importReferences([...e.target.files],uploadKind);e.target.value='';});
$('#importWorks').onclick=()=>{$('#workInput').value='';$('#workInput').click();};$('#workInput').onchange=guard(async e=>{
 if(importing)return;const files=[...e.target.files];if(!files.length)return;if(files.length>20)throw new Error('每次最多导入 20 张作品');files.forEach(validateFile);importing=true;$('#importWorks').disabled=true;
 try{const asset_ids=[];for(const file of files){asset_ids.push((await uploadFile('work',file)).id);toast(`正在导入 ${asset_ids.length}/${files.length}`);}await api('/works/import',{title:(files[0].name+(files.length>1?' 等 '+files.length+' 张':'')).slice(0,100),asset_ids,params:clone(state.params)});await refreshPrivate();await renderWorks();toast('作品已导入');}finally{importing=false;$('#importWorks').disabled=false;e.target.value='';}
});
$('#theme').onchange=()=>{document.documentElement.dataset.theme=$('#theme').value;try{localStorage.setItem('reference-platform.theme',$('#theme').value);}catch(_){toast('外观设置只在本次访问生效');}};
$('#saveApiKey').onclick=guard(async()=>{provider.configure($('#apiKey').value,$('#rememberApiKey').checked);$('#apiKey').value='';status=await api('/status');models=status.models||[];updateSettings();renderSettings();markDirty();toast(models.length?'密钥已配置，首次成功生成后验证连接':'密钥已清除');});
$('#clearApiKey').onclick=guard(async()=>{provider.configure('',false);$('#apiKey').value='';$('#rememberApiKey').checked=false;status=await api('/status');models=status.models||[];updateSettings();renderSettings();toast('已清除密钥；已提交的批次会继续使用提交时的密钥直到结束');});
$('#exportDrafts').onclick=guard(async()=>{const data=await api('/drafts'),blob=new Blob([JSON.stringify({version:1,...data},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='reference-studio-drafts.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已导出参数，不包含图片文件');});
$('#viewerDownload').onclick=guard(()=>viewerRef&&download(viewerRef.ref));$('#viewerUse').onclick=guard(async()=>{if(viewerRef){choose(viewerRef.ref,viewerRef.kind);$('#viewer').close();if($('#picker').open)$('#picker').close();showPage('studio');}});
document.addEventListener('paste',guard(async e=>{if(state.page!=='studio'||['INPUT','TEXTAREA'].includes(e.target.tagName))return;const files=[...(e.clipboardData?.files||[])].filter(f=>f.type.startsWith('image/'));if(files.length)await importReferences(files.slice(0,1),'person');}));
$('#configPanel').addEventListener('dragover',e=>{e.preventDefault();});$('#configPanel').addEventListener('drop',e=>{e.preventDefault();const section=e.target.closest('.reference-section'),kind=section?.querySelector('[data-upload]')?.dataset.upload||'person';const files=[...e.dataTransfer.files];guard(()=>importReferences(kind==='pose'?files:files.slice(0,1),kind))();});
window.addEventListener('beforeunload',e=>{if(dirtyVersion>savedVersion||(isBrowser&&jobs.some(j=>['queued','running'].includes(j.status)))){e.preventDefault();e.returnValue='';}});window.addEventListener('pagehide',()=>{eventAbort?.abort();for(const value of imageCache.values())value.then(url=>URL.revokeObjectURL(url)).catch(()=>{});});
setInterval(()=>{if(!document.hidden)refreshPrivate().then(()=>{renderPlan();if(state.page==='works')return renderWorks();}).catch(()=>{});},5000);
boot().catch(e=>{$('#configError').textContent=e.message;$('#results').innerHTML=empty('个人工作区暂不可用',e.message);toast(e.message);});
})();
