// Offline regression tests. Run with Node.js >=20; no provider traffic.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9FkAAAAASUVORK5CYII=';
const pause=()=>new Promise(resolve=>setImmediate(resolve));

async function fixture(response){
 const tables=Object.fromEntries(['jobs','works','assets'].map(k=>[k,new Map()])),calls=[],session=new Map();let serial=0,locked=false;
 const storage={all:async t=>structuredClone([...tables[t].values()]),get:async(t,id)=>structuredClone(tables[t].get(id)),put:async(t,value)=>{tables[t].set(value.id,structuredClone(value));},upload:async(kind,file)=>{const value={id:'asset'+(++serial),kind,blob:file};tables.assets.set(value.id,value);return value;}};
 class File extends Blob{constructor(parts,name,options){super(parts,options);this.name=name;}}
 const context={window:{},navigator:{locks:{request:async(name,options,callback)=>{if(locked)return callback(null);locked=true;try{return await callback({name});}finally{locked=false;}}}},localStorage:{getItem:()=>null,setItem:()=>{}},sessionStorage:{getItem:k=>session.get(k),setItem:(k,v)=>session.set(k,v),removeItem:k=>session.delete(k)},Blob,File,FormData,AbortController,setTimeout,clearTimeout,atob,
 fetch:async(url,options)=>{calls.push({url,options});return response?response(calls.length,url,options):new Response(JSON.stringify({data:{b64_json:PNG}}),{status:200});}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'static/image-provider.js'),'utf8'),context);
 const provider=context.window.ReferenceImageProvider;
 await provider.initialize({storage,reference:async()=>({blob:new Blob([Buffer.from(PNG,'base64')],{type:'image/png'}),note:''}),notify:()=>{},newId:()=>('id'+(++serial)),copy:structuredClone});
 provider.configure('offline-secret',false,'direct');
 const params={person:{source:'upload',id:'person'},cloth:{source:'upload',id:'cloth'},poses:[{source:'upload',id:'pose'}],model:'gpt-image-2',width:1024,height:1536,quality:'high',variants:1,prompt:'白色背景'};
 async function terminal(id){for(let i=0;i<200;i++){const job=await provider.request('/jobs/'+id);if(!['queued','running'].includes(job.status)){await pause();return job;}await pause();}throw new Error('Fixture did not finish');}
 return {provider,storage,tables,calls,session,params,terminal};
}

test('three repeated image fields, one output, object response, no persisted key',async()=>{
 const f=await fixture();const job=await f.provider.request('/generations',{params:f.params,idempotency_key:'one'});
 const result=await f.terminal(job.id);assert.equal(result.status,'done');assert.equal(f.calls.length,1);
 const request=f.calls[0];assert.equal(request.options.body.getAll('image').length,3);assert.equal(request.options.body.get('n'),'1');assert.equal(request.options.body.get('quality'),'high');assert.equal(request.options.headers.Authorization,'Bearer offline-secret');
 assert.equal(f.provider.info().verified,true);assert.equal(f.session.size,0);
 assert.ok(!JSON.stringify([...f.tables.jobs.values(),...f.tables.works.values()]).includes('offline-secret'));
 const duplicate=await f.provider.request('/generations',{params:f.params,idempotency_key:'one'});assert.equal(duplicate.id,job.id);assert.equal(f.calls.length,1);
});

test('array response and every variant is a real separate request',async()=>{
 const f=await fixture(()=>new Response(JSON.stringify({data:[{b64_json:PNG}]}),{status:200}));f.params.variants=2;
 const job=await f.provider.request('/generations',{params:f.params,idempotency_key:'two'});assert.equal((await f.terminal(job.id)).status,'done');assert.equal(f.calls.length,2);
});

test('network uncertainty stops remaining tasks and forbids automatic retry',async()=>{
 const f=await fixture(()=>{throw new TypeError('network');});f.params.variants=2;
 const job=await f.provider.request('/generations',{params:f.params,idempotency_key:'uncertain'});const result=await f.terminal(job.id);
 assert.equal(result.status,'interrupted');assert.equal(result.tasks[0].status,'interrupted');assert.equal(result.tasks[1].status,'cancelled');assert.equal(f.calls.length,1);
 await assert.rejects(f.provider.request('/jobs/'+job.id+'/retry',{idempotency_key:'again'}),/没有可重试/);assert.equal(f.calls.length,1);
});

test('invalid configuration fails before any paid request',async()=>{
 const f=await fixture();f.params.width=1536;f.params.height=2048;
 await assert.rejects(f.provider.request('/generations',{params:f.params,idempotency_key:'bad'}),/尺寸/);assert.equal(f.calls.length,0);
 f.provider.configure('',false,'direct');await assert.rejects(f.provider.request('/generations',{params:f.params,idempotency_key:'no-key'}),/API Key/);assert.equal(f.calls.length,0);
});

test('in-flight batch excludes another batch; cancellation preserves current result',async()=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const f=await fixture(async()=>{await pending;return new Response(JSON.stringify({data:{b64_json:PNG}}),{status:200});});f.params.variants=2;
 const job=await f.provider.request('/generations',{params:f.params,idempotency_key:'active'});
 for(let i=0;i<50&&!f.calls.length;i++)await pause();
 await assert.rejects(f.provider.request('/generations',{params:f.params,idempotency_key:'concurrent'}),/正在生成/);
 await f.provider.request('/jobs/'+job.id+'/cancel',{});release();const result=await f.terminal(job.id);
 assert.equal(result.tasks[0].status,'done');assert.equal(result.tasks[1].status,'cancelled');assert.equal(f.calls.length,1);
});

test('upstream 401 does not leak response contents and halts the batch',async()=>{
 const f=await fixture(()=>new Response('offline-secret echoed by upstream',{status:401}));f.params.variants=2;
 const job=await f.provider.request('/generations',{params:f.params,idempotency_key:'unauthorized'});const result=await f.terminal(job.id);
 assert.equal(result.status,'failed');assert.ok(!result.tasks[0].error.includes('offline-secret'));assert.equal(f.calls.length,1);
});

test('local mode checks the relay without a key before sending any image',async()=>{
 const f=await fixture(()=>{throw new TypeError('relay not started');});f.provider.configure('offline-secret',false,'local');
 await assert.rejects(f.provider.request('/generations',{params:f.params,idempotency_key:'no-relay'}),/尚未提交/);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'http://127.0.0.1:8766/health');assert.equal(f.calls[0].options.headers,undefined);assert.equal(f.tables.jobs.size,0);
});

test('startup marks an unfinished batch interrupted without a provider call',async()=>{
 const f=await fixture();await f.storage.put('jobs',{id:'old',status:'running',tasks:[{status:'running'},{status:'queued'}]});
 await f.provider.initialize({storage:f.storage,reference:async()=>{},notify:()=>{},newId:()=>'',copy:structuredClone});
 const job=await f.provider.request('/jobs/old');assert.equal(job.status,'interrupted');assert.equal(job.tasks[0].status,'interrupted');assert.equal(job.tasks[1].status,'interrupted');assert.equal(f.calls.length,0);
});
