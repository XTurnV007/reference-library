'use strict';
// This adapter uses the supplied third-party contract, not OpenAI's public API.
window.ReferenceImageProvider = (() => {
 const UPSTREAM='https://ai.cursorai.art/v1/images/edits';
 const RELAY_ORIGIN='https://reference-library-image-relay.amberlyric256.chatgpt.site';
 const ENDPOINT=RELAY_ORIGIN+'/v1/images/edits';
 const GENERATION_PAUSED=false;
 const PAUSE_REASON='生图提交已暂停：正在核对 HTTP 404 与扣费问题。请勿重试；素材、草稿和已有作品仍可使用。';
 const SESSION_KEY='reference-platform.cursor-key';
 const sizes=[[1024,1536],[1024,1024],[1536,1024],[2048,2048],[2048,1152],[3840,2160],[2160,3840]];
 const models=['gpt-image-2','gpt-image-2-all','gpt-image-1','gpt-image-1-all','flux-kontext-pro','flux-kontext-max'].map(id=>({id,label:id,sizes,max_refs:3,max_tasks:80}));
 const lockName='reference-studio-provider';
 let key='',verified=false,storage,reference,notify=()=>{},newId,copy;
 const time=()=>Date.now()/1000;
 try{key=sessionStorage.getItem(SESSION_KEY)||'';}catch(_){}
 function configure(value,remember){
  const next=value.trim();if(next.length>4096||/[^\x21-\x7e]/.test(next))throw new Error('API Key 格式无效，请仅粘贴密钥，不含 Bearer、空格或换行');
  key=next;verified=false;
  try{if(remember&&key)sessionStorage.setItem(SESSION_KEY,key);else sessionStorage.removeItem(SESSION_KEY);}catch(_){throw new Error('浏览器无法保存会话密钥，请取消会话保存后重试');}
 }
 function info(){return {endpoint:ENDPOINT,transport:'cloud',configured:!!key,verified,paused:GENERATION_PAUSED,models:key?models:[],generation_available:!!key&&!GENERATION_PAUSED,message:GENERATION_PAUSED?PAUSE_REASON:key?'通过云端转发将三张参考图发送至 ai.cursorai.art。每张结果独立返回；请保持此标签页打开。':'请在设置中填写 API Key，启用多图生成功能。'};}
 function changed(id){notify(id);}
 function withLock(callback){if(!navigator.locks)throw new Error('浏览器不支持任务锁，请使用新版 Chrome、Edge 或 Firefox');return navigator.locks.request(lockName,{ifAvailable:true},callback);}
 async function initialize(options){
  ({storage,reference,notify,newId,copy}=options);
  // Never automatically resubmit after refresh: the provider may already have billed.
  if(navigator.locks)await withLock(async lock=>{
   if(!lock)return;
   for(const job of await storage.all('jobs'))if(['queued','running'].includes(job.status)){
    job.status='interrupted';job.updated_at=time();
    for(const task of job.tasks)if(['queued','running'].includes(task.status)){task.status='interrupted';task.error='页面曾关闭或刷新，供应商可能已处理请求。请先核对账单；不会自动重发。';}
    await storage.put('jobs',job);
   }
  });
 }
 async function decode(result){
  const data=Array.isArray(result.data)?result.data[0]:result.data;
  const encoded=data?.b64_json;
  if(typeof encoded!=='string'||!encoded||encoded.length>72*1024**2)throw new Error('接口未返回有效的 b64_json 图片');
  let binary;try{binary=atob(encoded);}catch(_){throw new Error('接口返回的图片编码无效');}
  const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
  const ascii=(a,b)=>String.fromCharCode(...bytes.slice(a,b));
  const type=bytes[0]===137&&ascii(1,4)==='PNG'?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP'?'image/webp':'';
  if(!type||bytes.length>50*1024**2)throw new Error('接口返回的图片格式不受支持或超过 50 MB');
  return new Blob([bytes],{type});
 }
 async function edit(task,params,refs,token){
  const form=new FormData();
  for(let i=0;i<refs.length;i++)form.append('image',refs[i].blob,`reference-${i+1}.${refs[i].blob.type==='image/png'?'png':refs[i].blob.type==='image/webp'?'webp':'jpg'}`);
  form.append('prompt',`请根据三张参考图片生成一张完整的人像摄影作品。图片顺序固定：第一张是人物身份参考，保持其面部特征和身份；第二张仅参考服装款式、颜色与配饰；第三张仅参考身体姿势和拍摄视角，不采用第三张的人物身份或绘画风格。最终画面只有同一位人物，不要拼贴、分屏或显示参考图。${params.prompt?'补充要求：'+params.prompt:''}`);
  form.append('model',params.model);form.append('n','1');form.append('size',params.width+'x'+params.height);
  form.append('quality',params.quality||'auto');form.append('background','auto');form.append('moderation','auto');
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15*60*1000);
  try{
   let response;try{response=await fetch(ENDPOINT,{method:'POST',headers:{Accept:'application/json',Authorization:'Bearer '+token},body:form,signal:controller.signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});}
   catch(_){const error=new Error('云端转发请求中断或超时。供应商可能已处理请求，请先核对账单；未自动重发。');error.uncertain=true;throw error;}
   if(!response.ok){
    let message=response.status===401||response.status===403?'密钥无效或账号无权限':response.status===429?'请求受限或额度不足':response.status===413?'图片体积超出供应商限制':'供应商返回错误';
    let detail='',requestId=response.headers.get('X-Relay-Request-Id')||'',upstreamId=response.headers.get('X-Upstream-Request-Id')||'';
    try{const value=await response.json();if(value.error?.code&&value.error.code!=='upstream_http_error')message='云端转发未完成';if(typeof value.error?.message==='string')detail=value.error.message.split(token).join('[已隐藏]').replace(/Bearer\s+[^\s"'<>]+/gi,'Bearer [已隐藏]').slice(0,700);}catch(_){}
    requestId=/^[a-z0-9_.:-]{1,160}$/i.test(requestId)?requestId:'';upstreamId=/^[a-z0-9_.:-]{1,160}$/i.test(upstreamId)?upstreamId:'';
    const error=new Error(`${message}（HTTP ${response.status}）。${detail?detail+' ':''}${requestId?'转发请求编号：'+requestId+'。 ':''}${upstreamId?'供应商请求编号：'+upstreamId+'。 ':''}HTTP 错误不能证明未计费，请先核对供应商记录；此项禁止直接重试。`);error.uncertain=true;throw error;
   }
   // Reading/decoding can fail after the request has been accepted; never auto-retry.
   try{const result=await response.json(),blob=await decode(result);verified=true;return blob;}
   catch(_){const error=new Error('请求已返回，但未能读取有效图片。请先在供应商后台核对结果；未自动重发。');error.uncertain=true;throw error;}
  }finally{clearTimeout(timeout);}
 }
 async function save(job){job.updated_at=time();await storage.put('jobs',copy(job));changed(job.id);}
 async function execute(job,token){
  try{
   job.status='running';await save(job);
   for(const task of job.tasks){
    if(GENERATION_PAUSED){job.cancel_requested=true;}
    const saved=await storage.get('jobs',job.id);if(saved.cancel_requested)job.cancel_requested=true;
    if(job.cancel_requested){task.status='cancelled';await save(job);continue;}
    task.status='running';await save(job);
    let accepted=false;
    try{
     const refs=await Promise.all([reference(task.spec.person),reference(task.spec.cloth),reference(task.spec.pose)]);
     if(refs.reduce((n,r)=>n+r.blob.size,0)>50*1024**2)throw new Error('三张参考图合计超过 50 MB，请更换图片');
     task.reference_notes=refs.map(r=>r.note).filter(Boolean);await save(job);
     const blob=await edit(task,job.params,refs,token);accepted=true;
     const file=new File([blob],`generation-${job.id.slice(0,8)}-${task.position+1}.${blob.type==='image/png'?'png':blob.type==='image/webp'?'webp':'jpg'}`,{type:blob.type});
     const asset=await storage.upload('work',file);
     const work=await storage.get('works',job.work_id);work.results.push({asset_id:asset.id,position:task.position});await storage.put('works',work);
     task.asset_id=asset.id;task.status='done';
    }catch(error){
     task.status=error.uncertain||accepted?'interrupted':'failed';
     task.error=accepted?'图片已生成，但本地保存失败。请核对供应商结果，避免重复付费。':error.message;
     // Halt on any provider error, ambiguous outcome or local persistence failure.
     job.cancel_requested=true;
    }
    // Preserve cancellations submitted in another tab while the provider was running.
    const latest=await storage.get('jobs',job.id);job.cancel_requested=job.cancel_requested||latest.cancel_requested;
    await save(job);
   }
   const states=job.tasks.map(t=>t.status);
   job.status=states.includes('interrupted')?'interrupted':states.every(s=>s==='done')?'done':states.includes('failed')?(states.includes('done')?'partial':'failed'):'cancelled';await save(job);
  }catch(_){
   job.status='interrupted';for(const task of job.tasks)if(['queued','running'].includes(task.status)){task.status='interrupted';task.error='本地任务记录保存中断，请先核对供应商结果。';}
   try{await save(job);}catch(_){changed(job.id);}
  }
 }
 function validate(params){
  if(!key)throw new Error('请先在设置中填写 API Key');
  if(!models.some(m=>m.id===params.model))throw new Error('请选择受支持的模型');
  if(!sizes.some(([w,h])=>w===params.width&&h===params.height))throw new Error('请选择接口支持的图片尺寸');
  if(!['auto','low','medium','high'].includes(params.quality||'auto'))throw new Error('画质设置无效');
  if(!params.person||!params.cloth||!Array.isArray(params.poses)||!params.poses.length||params.poses.length>20||![1,2,4].includes(params.variants))throw new Error('请先选择人像、服装和 1–20 个姿势');
  if(typeof params.prompt!=='string'||params.prompt.length>6000)throw new Error('补充描述最多 6000 字');
 }
 async function create(body,retryTasks){
  if(GENERATION_PAUSED)throw new Error(PAUSE_REASON);
  validate(body.params);const token=key;
  // Hold a browser-wide lock for the entire paid batch, but return the job at once.
  return new Promise((resolve,reject)=>{
   let started=false;
   Promise.resolve().then(()=>withLock(async lock=>{
    if(!lock)throw new Error('另一个标签页或批次正在生成，请等待完成');
    const previous=(await storage.all('jobs')).find(j=>j.request_key===body.idempotency_key);if(previous){resolve(previous);return;}
    // This endpoint is local to the cloud relay and never calls the image model.
    const healthController=new AbortController(),healthTimeout=setTimeout(()=>healthController.abort(),10000);
    try{
     const response=await fetch(RELAY_ORIGIN+'/health',{credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:healthController.signal,cache:'no-store'});
     const health=await response.json();if(!response.ok||health.ok!==true||health.service!=='reference-library-image-relay'||health.upstream!==UPSTREAM)throw new Error();
    }catch(_){throw new Error('云端转发不可用或无访问权限，尚未提交生图请求。请稍后重试。');}
    finally{clearTimeout(healthTimeout);}
    const params=copy(body.params),tasks=retryTasks?retryTasks.map(t=>({...copy(t),id:newId(),status:'queued',error:'',asset_id:null})):params.poses.flatMap(pose=>Array.from({length:params.variants},(_,variation)=>({id:newId(),spec:{person:params.person,cloth:params.cloth,pose,variation},status:'queued'})));
    tasks.forEach((t,i)=>{t.position=i;});
    const job={id:newId(),work_id:newId(),request_key:body.idempotency_key,params,tasks,status:'queued',created_at:time(),cancel_requested:false};
    // Resolve reference accessibility before any paid request; missing assets fail early.
    await Promise.all([params.person,params.cloth,...params.poses].map(ref=>reference(ref)));
    await storage.put('works',{id:job.work_id,title:body.title||'AI 创作',source:'generated',params,favorite:false,created_at:time(),results:[]});
    await save(job);started=true;resolve(copy(job));await execute(job,token);
   })).catch(error=>{if(!started)reject(error);});
  });
 }
 async function request(path,body){
  if(path==='/jobs')return {jobs:(await storage.all('jobs')).sort((a,b)=>b.created_at-a.created_at)};
  if(path==='/generations')return create(body);
  const match=path.match(/^\/jobs\/([a-z0-9]+)(?:\/(cancel|retry))?$/);if(!match)throw new Error('任务接口不存在');
  const job=await storage.get('jobs',match[1]);if(!job)throw new Error('任务不存在');
  if(match[2]==='cancel'){job.cancel_requested=true;await save(job);return {message:'已停止后续任务；已提交给供应商的当前图片仍可能完成并计费。'};}
  if(match[2]==='retry'){
   if(GENERATION_PAUSED)throw new Error(PAUSE_REASON);
   if(['queued','running'].includes(job.status))throw new Error('请等待当前批次结束');
   const tasks=job.tasks.filter(t=>t.status==='failed');if(!tasks.length)throw new Error('没有可重试的失败项；中断项请先核对供应商结果');
   return create({params:job.params,idempotency_key:body.idempotency_key,title:'重试作品'},tasks);
  }
  return job;
 }
 return {configure,info,initialize,request};
})();
