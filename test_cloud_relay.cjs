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
 const context={URL,Headers,Response,TransformStream,TextDecoder,Uint8Array,AbortController,crypto:webcrypto,setTimeout,clearTimeout,fetch:async(url,options)=>{calls.push({url,options});return respond?respond(url,options):new Response('{"data":{"b64_json":"fixture"}}',{headers:{'Content-Type':'application/json'}});}};
 const source=readFileSync(path.join(__dirname,'cloud_relay_worker.js'),'utf8').replace('export default {','globalThis.worker = {');
 vm.runInNewContext(source,context);
 return {worker:context.worker,calls};
}
function request(method,route='/v1/images/edits',headers={},body){return new Request('https://relay.invalid'+route,{method,headers:{Origin:ORIGIN,...headers},...(body?{body}:{})});}

test('preflight explicitly allows Authorization and health has no upstream call',async()=>{
 const f=fixture();const response=await f.worker.fetch(request('OPTIONS',undefined,{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}));
 assert.equal(response.status,204);assert.ok(response.headers.get('Access-Control-Allow-Headers').includes('Authorization'));assert.equal(response.headers.get('Access-Control-Allow-Origin'),ORIGIN);
 const health=await f.worker.fetch(request('GET','/health'));assert.equal((await health.json()).ok,true);assert.equal(f.calls.length,0);
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
 assert.equal(response.status,200);assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'https://ai.cursorai.art/v1/images/edits');
 assert.equal(await new Response(f.calls[0].options.body).text(),body);assert.equal(f.calls[0].options.headers.Cookie,undefined);
 assert.equal((await response.json()).data.b64_json,'fixture');
});

test('upstream error keeps a request ID, masks credentials and never retries',async()=>{
 const f=fixture(()=>new Response(JSON.stringify({error:{message:'route failed offline-secret Bearer upstream-secret'}}),{status:404,headers:{'X-Request-Id':'upstream-123'}}));
 const response=await f.worker.fetch(request('POST',undefined,{Authorization:'Bearer offline-secret','Content-Type':'multipart/form-data; boundary=fixture'},'body'));
 assert.equal(response.status,404);const value=await response.json();assert.ok(value.error.request_id);assert.equal(response.headers.get('X-Upstream-Request-Id'),'upstream-123');
 assert.ok(!value.error.message.includes('offline-secret'));assert.ok(!value.error.message.includes('upstream-secret'));assert.equal(f.calls.length,1);
});
