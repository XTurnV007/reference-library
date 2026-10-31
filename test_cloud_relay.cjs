// Offline tests only: the Worker runs in a VM with fetch replaced by a fixture.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const ORIGIN='https://xturnv007.github.io';

function fixture(respond){
 const calls=[];
 const context={URL,Request,Headers,Response,ReadableStream,TransformStream,TextDecoder,Uint8Array,AbortController,crypto:webcrypto,setTimeout,clearTimeout,console:{error:()=>{}},fetch:async(url,options)=>{new Request(url,options);calls.push({url,options});return respond?respond(url,options):new Response('{"data":{"b64_json":"fixture"}}',{headers:{'Content-Type':'application/json'}});}};
 const source=readFileSync(path.join(__dirname,'cloud_relay_worker.js'),'utf8').replace('export default {','globalThis.worker = {');
 vm.runInNewContext(source,context);
 return {worker:context.worker,calls};
}
function request(method,route='/v1/images/edits',headers={},body){return new Request('https://relay.invalid'+route,{method,headers:{Origin:ORIGIN,...headers},...(body?{body}:{})});}

test('preflight explicitly allows Authorization and health has no upstream call',async()=>{
 const f=fixture();const response=await f.worker.fetch(request('OPTIONS',undefined,{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}));
 assert.equal(response.status,204);assert.ok(response.headers.get('Access-Control-Allow-Headers').includes('Authorization'));assert.equal(response.headers.get('Access-Control-Allow-Origin'),ORIGIN);
 const health=await f.worker.fetch(request('GET','/health'));const value=await health.json();assert.equal(value.ok,true);assert.equal(value.stream_request_ready,true);assert.equal(f.calls.length,0);
});

test('wrong origin, missing key, oversized body and arbitrary query cannot reach provider',async()=>{
 const f=fixture();assert.equal((await f.worker.fetch(request('POST',undefined,{Origin:'https://other.invalid'},'body'))).status,403);
 assert.equal((await f.worker.fetch(request('POST',undefined,{},'body'))).status,401);
 assert.equal((await f.worker.fetch(request('POST',undefined,{Authorization:'Bearer offline-secret','Content-Type':'multipart/form-data; boundary=fixture','Content-Length':String(52*1024**2)},'body'))).status,413);
 assert.equal((await f.worker.fetch(request('POST','/v1/images/edits?url=https://other.invalid',{},'body'))).status,400);assert.equal(f.calls.length,0);
});

test('streams multipart bytes unchanged to the sole upstream and streams JSON back',async()=>{
 const f=fixture();const body='--fixture\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nfixture\r\n--fixture--\r\n';
 const response=await f.worker.fetch(request('POST',undefined,{Authorization:'Bearer offline-secret','Content-Type':'multipart/form-data; boundary=fixture',Cookie:'not-forwarded'},body));
 assert.equal(response.status,200);assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'https://ugq.ai/v1/images/edits');assert.equal(f.calls[0].options.duplex,'half');
 assert.equal(await new Response(f.calls[0].options.body).text(),body);assert.equal(f.calls[0].options.headers.Cookie,undefined);
 assert.equal((await response.json()).data.b64_json,'fixture');
});

test('upstream error keeps a request ID, masks credentials and never retries',async()=>{
 const f=fixture(()=>new Response(JSON.stringify({error:{message:'route failed offline-secret Bearer upstream-secret'}}),{status:404,headers:{'X-Request-Id':'upstream-123'}}));
 const response=await f.worker.fetch(request('POST',undefined,{Authorization:'Bearer offline-secret','Content-Type':'multipart/form-data; boundary=fixture'},'body'));
 assert.equal(response.status,404);const value=await response.json();assert.ok(value.error.request_id);assert.equal(response.headers.get('X-Upstream-Request-Id'),'upstream-123');
 assert.ok(!value.error.message.includes('offline-secret'));assert.ok(!value.error.message.includes('upstream-secret'));assert.equal(f.calls.length,1);
});

test('URL results are downloaded without Authorization, including after a redirect',async()=>{
 const f=fixture((url,options)=>{
  if(url==='https://ugq.ai/v1/images/edits')return new Response(JSON.stringify({data:[{url:'https://images.example.test/result'}]}));
  assert.equal(options.headers.Authorization,undefined);assert.equal(options.credentials,'omit');
  return url.endsWith('/result')?new Response(null,{status:302,headers:{Location:'https://cdn.example.test/final.png'}}):new Response('image-fixture',{headers:{'Content-Type':'image/png'}});
 });
 const response=await f.worker.fetch(request('POST',undefined,{Authorization:'Bearer offline-secret','Content-Type':'multipart/form-data; boundary=fixture'},'body'));
 assert.equal(response.status,200);assert.equal(response.headers.get('X-Relay-Image-Result'),'1');assert.equal(await response.text(),'image-fixture');assert.equal(f.calls.length,3);
});

test('unreadable URL results return a recovery link and never regenerate',async()=>{
 const f=fixture(url=>url==='https://ugq.ai/v1/images/edits'?new Response(JSON.stringify({data:[{url:'https://images.example.test/result.png'}]})):new Response('missing',{status:404}));
 const response=await f.worker.fetch(request('POST',undefined,{Authorization:'Bearer offline-secret','Content-Type':'multipart/form-data; boundary=fixture'},'body'));
 assert.equal(response.status,502);const value=await response.json();assert.equal(value.error.result_url,'https://images.example.test/result.png');assert.equal(f.calls.filter(c=>c.url==='https://ugq.ai/v1/images/edits').length,1);
});

test('private or insecure image URLs never receive a download request',async()=>{
 const f=fixture(()=>new Response(JSON.stringify({data:[{url:'http://127.0.0.1/private'}]})));
 const response=await f.worker.fetch(request('POST',undefined,{Authorization:'Bearer offline-secret','Content-Type':'multipart/form-data; boundary=fixture'},'body'));
 assert.equal(response.status,502);assert.equal(f.calls.length,1);assert.equal((await response.json()).error.result_url,undefined);
});

test('large base64 JSON is passed through intact using bounded prefix inspection',async()=>{
 const expected=JSON.stringify({data:[{b64_json:'A'.repeat(200000)}]});const f=fixture(()=>new Response(expected));
 const response=await f.worker.fetch(request('POST',undefined,{Authorization:'Bearer offline-secret','Content-Type':'multipart/form-data; boundary=fixture'},'body'));
 assert.equal(await response.text(),expected);assert.equal(f.calls.length,1);
});
