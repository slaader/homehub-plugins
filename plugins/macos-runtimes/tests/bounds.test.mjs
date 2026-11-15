import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {bridgeClient} from '../server/transport.mjs';
import {createComputeStore} from '../server/compute-data.mjs';
import {createComputeController,watchAccessLog,readBody} from '../scripts/compute-controller.mjs';
async function directory(t){const dir=await mkdtemp(path.join(os.tmpdir(),'bounds-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('bridge transport bounds total time even while the peer trickles data',async t=>{
 const dir=await directory(t),socket=path.join(dir,'bridge.sock');
 let closed;const stopped=new Promise(r=>closed=r);
 const server=http.createServer((req,res)=>{res.writeHead(200);res.write('{');const timer=setInterval(()=>res.write(' '),5);res.on('close',()=>{clearInterval(timer);closed();});});
 await new Promise(r=>server.listen(socket,r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 await assert.rejects(bridgeClient(socket,{timeoutMs:60})('/compute/snapshot'),/timeout/);await stopped;
});
test('bridge transport refuses oversized, malformed, aborted and failed responses',async t=>{
 const dir=await directory(t),socket=path.join(dir,'bridge.sock');let mode='oversize';
 const server=http.createServer((req,res)=>{
  if(mode==='oversize')return res.end('x'.repeat(2097153));
  if(mode==='aborted'){res.writeHead(200,{'Content-Length':'1000'});res.write('{');return setImmediate(()=>res.destroy());}
  res.writeHead(mode==='failed'?500:200);res.end('invalid');
 });
 await new Promise(r=>server.listen(socket,r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 for(mode of ['oversize','malformed','aborted','failed'])await assert.rejects(bridgeClient(socket,{timeoutMs:1000})('/compute/snapshot'));
});
test('history streams large or corrupt lines and stops at the caller row budget',async t=>{
 const dir=await directory(t),hostDir=path.join(dir,'compute','mac');await mkdir(hostDir,{recursive:true});
 const row=n=>JSON.stringify({kind:'request',at:'2026-11-15T12:00:00Z',model:'example-model',metricId:n})+'\n';
 await writeFile(path.join(hostDir,'history-2026-11.jsonl'),'x'.repeat(100000)+'\n{broken}\n'+row(1)+row(2)+row(3));
 const store=createComputeStore(dir,{hosts:[{id:'mac'}]});
 const rows=await store.readRecords('mac',Date.parse('2026-11-01'),Date.parse('2026-12-01'),{limit:2});
 assert.deepEqual(rows.map(r=>r.metricId),[1,2]);
});
test('per-model controller caches stay bounded when runtime model IDs turn over',async t=>{
 const dir=await directory(t),at=new Date().toISOString();let metric=0;
 const controller=createComputeController({hostId:'mac',stateDirectory:dir,profile:{actions:[],llamaSwap:{base:'http://127.0.0.1:8000',configPath:'/tmp/example.yaml'}},facts:async()=>({}),readConfig:async()=>'',fetcher:async url=>new Response(JSON.stringify(url.endsWith('/api/metrics')?Array.from({length:2100},()=>({id:++metric,timestamp:at,model:`example-${metric}`})):url.endsWith('/v1/models')?{data:[]}:{running:[]}))});
 await controller.build();assert.equal(controller.state.lastRequest.size,2000);assert.equal(controller.state.lastActivity.size,2000);assert.ok(controller.state.queue.length<=5000);
});
test('an unsuccessful access-log response is destroyed before reconnecting',async t=>{
 const server=http.createServer((req,res)=>{res.writeHead(503);res.write('unavailable');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 let ended;const closed=new Promise(r=>ended=r);server.on('connection',s=>s.once('close',ended));
 const stop=watchAccessLog({base:`http://127.0.0.1:${server.address().port}`,onLine:()=>assert.fail('error body must not be logged'),delay:10000});t.after(stop);
 await Promise.race([closed,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('error response socket leaked')),1000);timer.unref();})]);stop();
});
test('runtime HTTP reads reject redirects, oversize bodies and runtime errors',async()=>{
 const options=[];
 await assert.rejects(readBody('http://127.0.0.1:8000/test',{max:4,fetcher:async(url,init)=>{options.push(init);return new Response('12345');}}),/too-large/);
 await assert.rejects(readBody('http://127.0.0.1:8000/test',{fetcher:async()=>new Response('PRIVATE_TEST_VALUE',{status:500})}),/^Error: http-500$/);
 assert.equal(options[0].redirect,'error');assert.ok(options[0].signal instanceof AbortSignal);
});
