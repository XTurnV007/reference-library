const UPSTREAM='https://ugq.ai/v1/images/edits';
const EDIT_PATH='/v1/images/edits';
const ORIGINS=new Set(['https://xturnv007.github.io']);
const MAX_REQUEST=51*1024**2;
const MAX_RESPONSE=73*1024**2;

function cors(origin,id){
 const headers=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin','X-Relay-Request-Id':id});
 if(ORIGINS.has(origin)){
  headers.set('Access-Control-Allow-Origin',origin);
  headers.set('Access-Control-Allow-Methods','GET, HEAD, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers','Authorization, Content-Type, Accept');
  headers.set('Access-Control-Expose-Headers','X-Relay-Request-Id, X-Upstream-Request-Id, X-Relay-Image-Result');
  headers.set('Access-Control-Max-Age','300');
 }
 return headers;
}
function json(status,value,headers){headers.set('Content-Type','application/json; charset=utf-8');return new Response(JSON.stringify(value),{status,headers});}
function failure(status,code,message,headers,extra={}){return json(status,{error:{code,message,request_id:headers.get('X-Relay-Request-Id'),...extra}},headers);}
function limited(stream,limit){
 let size=0;
 return stream.pipeThrough(new TransformStream({transform(chunk,controller){size+=chunk.byteLength;if(size>limit)throw new Error('Stream size limit');controller.enqueue(chunk);}}));
}
async function upstreamMessage(response,token){
 if(!response.body)return '';
 const reader=response.body.getReader(),parts=[];let size=0;
 try{while(size<8192){const {done,value}=await reader.read();if(done)break;parts.push(value.slice(0,8192-size));size+=value.byteLength;}}
 catch(_){return '';}
 finally{try{await reader.cancel();}catch(_){}}
 const bytes=new Uint8Array(Math.min(size,8192));let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
 try{
  const value=JSON.parse(new TextDecoder().decode(bytes));
  const message=value.error?.message||(typeof value.error==='string'?value.error:value.message);
  if(typeof message!=='string')return '';
  return message.split(token).join('[redacted]').replace(/Bearer\s+[^\s"'<>]+/gi,'Bearer [redacted]').replace(/\bsk-[a-z0-9_-]+/gi,'[redacted]').replace(/data:image\/[^\s"'<>]+/gi,'[image omitted]').replace(/[\u0000-\u001f]/g,' ').slice(0,600);
 }catch(_){return '';}
}

function imageURL(value){
 const url=new URL(value),host=url.hostname.toLowerCase().replace(/\.$/,'');
 if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!host.includes('.')||/^[\d.]+$/.test(host)||host.includes(':')||/(?:^|\.)(localhost|local|internal)$/.test(host))throw new Error('Invalid image URL');
 return url;
}
async function resultPrefix(body){
 const reader=body.getReader(),chunks=[];let size=0,done=false;
 while(size<=128*1024){const part=await reader.read();if(part.done){done=true;break;}chunks.push(part.value);size+=part.value.byteLength;}
 let payload;
 if(done){try{const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}payload=JSON.parse(new TextDecoder().decode(bytes));}catch(_){}}
 let index=0;
 const stream=new ReadableStream({async pull(controller){try{if(index<chunks.length){controller.enqueue(chunks[index++]);return;}if(done){controller.close();return;}const part=await reader.read();if(part.done)controller.close();else controller.enqueue(part.value);}catch(error){controller.error(error);}},cancel(reason){return reader.cancel(reason);}});
 return {payload,stream};
}
async function downloadResult(value,signal){
 let url=imageURL(value);const controller=new AbortController(),abort=()=>controller.abort();
 if(signal?.aborted)controller.abort();signal?.addEventListener('abort',abort,{once:true});
 const timeout=setTimeout(abort,600*1000);
 try{
  for(let hop=0;hop<4;hop++){
   // A separate request intentionally has no Authorization or Cookie header.
   const response=await fetch(url.href,{headers:{Accept:'image/png,image/jpeg,image/webp'},credentials:'omit',redirect:'manual',signal:controller.signal});
   if([301,302,303,307,308].includes(response.status)){
    const location=response.headers.get('Location');try{await response.body?.cancel();}catch(_){}
    if(!location)throw new Error();url=imageURL(new URL(location,url).href);continue;
   }
   if(!response.ok||!response.body)throw new Error();
   const length=response.headers.get('Content-Length');if(length&&Number(length)>50*1024**2){try{await response.body.cancel();}catch(_){}throw new Error();}
   return response;
  }
  throw new Error();
 }finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
}

export default {
 async fetch(request){
  const url=new URL(request.url),origin=request.headers.get('Origin')||'',id=crypto.randomUUID(),headers=cors(origin,id);
  if(origin&&!ORIGINS.has(origin))return failure(403,'origin_not_allowed','此网页来源未获允许',headers);
  if(url.search)return failure(400,'query_not_allowed','接口不接受查询参数',headers);
  if(request.method==='OPTIONS'){
   if(!origin||![EDIT_PATH,'/health'].includes(url.pathname))return failure(403,'invalid_preflight','预检来源或路径无效',headers);
   const method=request.headers.get('Access-Control-Request-Method');
   if(method&&!['GET','HEAD','POST'].includes(method.toUpperCase()))return failure(405,'method_not_allowed','请求方法未获允许',headers);
   const requested=(request.headers.get('Access-Control-Request-Headers')||'').split(',').map(h=>h.trim().toLowerCase()).filter(Boolean);
   if(requested.some(h=>!['authorization','content-type','accept'].includes(h)))return failure(403,'headers_not_allowed','请求头未获允许',headers);
   return new Response(null,{status:204,headers});
  }
  if(['GET','HEAD'].includes(request.method)&&url.pathname==='/health'){
   let streamReady=false;
   try{streamReady=!!new Request(UPSTREAM,{method:'POST',body:new Response('transport-self-check').body,duplex:'half'}).body;}catch(_){}
   // Constructing this Request performs no network I/O and uses no API key.
   const value={ok:streamReady,service:'reference-library-image-relay',transport:'cloud',upstream:UPSTREAM,protocol:'ugq-multipart-png-v1',image_field:'image[]',response_format:'b64_json',upstream_timeout_seconds:600,stores_key:false,stores_images:false,retries:0,stream_request_ready:streamReady,stream_duplex:'half'};
   const status=streamReady?200:503;
   return request.method==='HEAD'?new Response(null,{status,headers}):json(status,value,headers);
  }
  if(request.method==='GET'&&url.pathname==='/'){
   headers.set('Content-Type','text/html; charset=utf-8');
   return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>参考图书馆 · 云端转发</title><body style="font:16px system-ui;max-width:680px;margin:12vh auto;padding:24px;line-height:1.8"><h1>图像接口云端转发</h1><p>固定转发至 ugq.ai，使用 PNG 多参考图和 b64_json 响应。密钥由创作平台在每次请求中传入，服务不保存密钥或图片，不自动重试。</p><p><a href="https://xturnv007.github.io/reference-library/#studio">打开创作平台</a> · <a href="/health">查看服务状态</a></p></body></html>',{status:200,headers});
  }
  if(url.pathname!==EDIT_PATH)return failure(404,'not_found','接口不存在',headers);
  if(request.method!=='POST')return failure(405,'method_not_allowed','仅接受 POST 图片编辑请求',headers);
  if(!ORIGINS.has(origin))return failure(403,'origin_required','此接口仅接受指定网页来源的请求',headers);
  const authorization=request.headers.get('Authorization')||'';
  if(!/^Bearer [\x21-\x7e]{1,4096}$/.test(authorization))return failure(401,'key_required','请在设置中填写 API Key',headers);
  const contentType=request.headers.get('Content-Type')||'';
  if(!/^multipart\/form-data;\s*boundary=(?:[A-Za-z0-9_.+=-]{1,200}|"[A-Za-z0-9_.+=-]{1,200}")$/i.test(contentType))return failure(415,'multipart_required','需要 multipart/form-data 图片请求',headers);
  const length=request.headers.get('Content-Length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)<=0||Number(length)>MAX_REQUEST))return failure(413,'request_too_large','图片请求超过大小限制',headers);
  if(!request.body)return failure(400,'body_required','请求体不能为空',headers);
  const controller=new AbortController(),abort=()=>controller.abort();
  request.signal?.addEventListener('abort',abort,{once:true});
  const timeout=setTimeout(abort,600*1000);
  try{
   // Stream multipart bytes untouched. No arbitrary upstream URL, cookie, or log.
   const response=await fetch(UPSTREAM,{method:'POST',headers:{Accept:'application/json',Authorization:authorization,'Content-Type':contentType},body:limited(request.body,MAX_REQUEST),duplex:'half',redirect:'error',signal:controller.signal});
   const upstreamId=response.headers.get('X-Request-Id')||response.headers.get('Request-Id')||response.headers.get('X-Oneapi-Request-Id')||'';
   if(/^[a-z0-9_.:-]{1,160}$/i.test(upstreamId))headers.set('X-Upstream-Request-Id',upstreamId);
   if(!response.ok){
    const detail=await upstreamMessage(response,authorization.slice(7));
    return failure(response.status,'upstream_http_error',`供应商返回 HTTP ${response.status}${detail?'：'+detail:''}。请先核对供应商结果，未自动重试。`,headers);
   }
   if(!response.body)return failure(502,'empty_upstream_response','供应商返回空响应，请先核对结果',headers);
   const result=await resultPrefix(response.body),entry=Array.isArray(result.payload?.data)?result.payload.data[0]:result.payload?.data;
   if(!entry?.b64_json&&typeof entry?.url==='string'&&entry.url){
    await result.stream.cancel();clearTimeout(timeout);
    try{
     const image=await downloadResult(entry.url,request.signal);
     headers.set('Content-Type',image.headers.get('Content-Type')||'application/octet-stream');headers.set('X-Relay-Image-Result','1');
     return new Response(limited(image.body,50*1024**2),{status:200,headers});
    }catch(_){let safeURL;try{safeURL=imageURL(entry.url).href;}catch(_){}return failure(502,'result_download_failed','供应商已返回图片地址，但下载失败。请打开返回的图片地址保存，勿重新生成。',headers,safeURL?{result_url:safeURL}:{});}
   }
   headers.set('Content-Type','application/json; charset=utf-8');
   return new Response(limited(result.stream,MAX_RESPONSE),{status:response.status,headers});
  }catch(error){
   const code=error?.name==='AbortError'?'upstream_timeout':/duplex/i.test(error?.message||'')?'stream_request_config_error':'upstream_transport_error';
   const type=['TypeError','AbortError','RangeError','Error'].includes(error?.name)?error.name:'Error';
   // Metadata only. Never log the exception message, headers, key, or image bytes.
   console.error(JSON.stringify({relay_request_id:id,code,error_type:type}));
   return failure(502,code,'云端转发未完成。请先核对供应商结果，未自动重试。',headers);
  }
  finally{clearTimeout(timeout);request.signal?.removeEventListener('abort',abort);}
 }
};
