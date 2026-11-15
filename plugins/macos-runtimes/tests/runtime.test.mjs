import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import plugin from '../index.mjs';
import {readComputeConfig,readComputeAgentConfig,computeAgentConfig} from '../server/config.mjs';
import {createComputeController,jobsFrom,parsePs} from '../scripts/compute-controller.mjs';
import {startBridge} from '../scripts/bridge.mjs';
import {bridgeClient} from '../server/transport.mjs';
const devices=[{id:'mac',name:'Example Mac',ip:'10.0.0.20'}];
const raw={sockets:{mac:'/tmp/example.sock'},hosts:{mac:{agent:{omlx:{base:'http://127.0.0.1:8000'},actions:[]}}}};
test('absent section is inert, including extension points',()=>{
 const h={site:{devices:[]},options:{},integrationEnabled:()=>true};const s=plugin.setup(h);
 assert.equal(s.config,null);assert.deepEqual(plugin.provides['home.runtimes'](s,h),{});assert.deepEqual(plugin.provides['runtimes.requests'](s,h),[]);
});
test('configuration rejects unknown fields, invalid values and non-site devices by name',()=>{
 for(const r of [{extra:1},{sockets:{unknown:'/tmp/example.sock'}},{sockets:{mac:'relative'}},{hosts:{mac:{agent:{omlx:{base:'https://example.lan'}}}}}])assert.throws(()=>readComputeConfig(r,{devices}),/plugins.macos-runtimes/);
});
test('agent configuration roundtrips without household defaults',()=>{
 const c=readComputeConfig(raw,{devices});const a=readComputeAgentConfig(computeAgentConfig(c,'mac'));
 assert.equal(a.hostId,'mac');assert.equal(a.profile.omlx.base,'http://127.0.0.1:8000');
});
test('runtime controller reads a fake oMLX runtime without network',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'macos-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const a=readComputeAgentConfig(computeAgentConfig(readComputeConfig(raw,{devices}),'mac'));
 const urls=[];const controller=createComputeController({...a,stateDirectory:dir,facts:async()=>({}),fetcher:async url=>{urls.push(url);return new Response(JSON.stringify({data:[{id:'example-model'}]}));}});
 const snapshot=await controller.snapshot();assert.equal(snapshot.hostId,'mac');assert.equal(snapshot.services[0].id,'omlx');assert.ok(urls.every(u=>u.startsWith('http://127.0.0.1:8000/')));
 await assert.rejects(controller.action({action:'unload-all',requestId:'00000000-0000-0000-0000-000000000001'}),/invalid/);
});
test('Unix bridge bounds routes and supports fake snapshot, records and controls',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'bridge-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const controller={start:async()=>{},stop(){},snapshot:async()=>({hostId:'mac'}),records:after=>({items:[],cursor:after}),action:async()=>({ok:true})};
 const bridge=await startBridge({socket:path.join(dir,'bridge.sock'),controller,controls:{status:async()=>({services:[]}),action:async()=>({ok:true})}});t.after(()=>bridge.stop());
 const request=bridgeClient(path.join(dir,'bridge.sock'));assert.equal((await request('/compute/snapshot')).hostId,'mac');assert.equal((await request('/compute/records','GET',{after:3})).cursor,3);assert.deepEqual(await request('/controls'),{services:[]});await assert.rejects(request('/unknown'));
});
import {createComputeStore} from '../server/compute-data.mjs';
import {createComputePoller} from '../server/compute-poller.mjs';
import {requestsReader} from '../server/compute-models.mjs';
test('poller persists and deduplicates history, integration off contacts nothing',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'history-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const hosts=readComputeConfig(raw,{devices}).hosts,store=createComputeStore(dir,{hosts});let enabled=true,calls=0;
 const at=new Date().toISOString();
 const request=async route=>{calls++;return route==='/compute/snapshot'?{hostId:'mac',collectedAt:at,services:[]}:{items:[{kind:'request',serviceId:'llama-swap',model:'example-model',at,metricId:1}],cursor:1};};
 const poller=createComputePoller({store,hosts,bridges:{mac:request},enabled:()=>enabled});
 await poller.poll();await poller.poll();const records=await requestsReader(store,['mac']).read({from:Date.now()-60000,to:Date.now()+60000});assert.equal(records.length,1);assert.equal(records[0].device,'mac');
 enabled=false;const before=calls;await poller.poll();assert.equal(calls,before);
});
test('bad agent profile and invalid socket ports fail by configuration field',()=>{
 for(const value of [null,{agents:{bridge:{mac:{unknown:true}}}},{sockets:{mac:'/tmp/example.sock'}},{hosts:{mac:{bridge:false,agent:{omlx:{base:'http://127.0.0.1:99999'}}}}}])assert.throws(()=>readComputeConfig(value,{devices}),/plugins.macos-runtimes/);
});
test('GPU job parser does not export prompts or full process arguments',()=>{
 const jobs=jobsFrom(parsePs('123 1 00:20 99 1000 /tmp/example/bin/mflux-generate --model example-model --prompt PRIVATE_TEST_PROMPT'),Date.now());
 assert.ok(!JSON.stringify(jobs).includes('PRIVATE_TEST_PROMPT'));
});
