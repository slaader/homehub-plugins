// The plugin in a hub (home-hub/testing → hub): core takes the adapter's observation (normalizeRouter, GET /api/router),
// the integration card with its switch and write-only key, and the plugin is inert without its site section.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hub,validateSite} from 'home-hub/testing';
import plugin from '../index.mjs';
import {startFakeUnifi,makeClients,KEY,PIN} from './fake-unifi.mjs';

async function unifiHub(t,{section,routerConfig={adapter:'unifi-api'},fake={}}={}){
 const gateway=await startFakeUnifi(fake);
 const dir=await mkdtemp(path.join(os.tmpdir(),'unifi-hub-'));
 t.after(async()=>{await gateway.close();await rm(dir,{recursive:true,force:true});});
 const site=validateSite({lanCidrs:['10.0.0.0/24'],devices:[{id:'router',name:'Router',role:'router',ip:'10.0.0.1'}],
  ...(routerConfig?{router:routerConfig}:{}),plugins:section===null?{}:{unifi:section??{host:'127.0.0.1',port:gateway.port,fingerprint:PIN}}});
 const h=await hub(t,{plugins:[plugin],site,integrationSecretsFile:path.join(dir,'private','integrations.json'),unifi:{privateDirectory:path.join(dir,'private')}});
 const card=async()=>(await (await fetch(h.origin+'/api/admin/integrations',{headers:h.admin})).json()).integrations.find(i=>i.id==='unifi.api');
 const router=async()=>(await fetch(h.origin+'/api/router',{headers:h.admin})).json();
 return {gateway,h,dir,card,router};
}

test('core takes the observation: /api/router serves the census of the plugin adapter, with its provenance',async t=>{
 const {gateway,h,card,router}=await unifiHub(t,{fake:{clients:makeClients(30)}});
 let c=await card();
 assert.equal(c.status.state,'not-configured','no key yet');assert.equal(c.settings.values.apiKey.set,false);
 // The first read (here the integrations page's router card) started a pull, which found no key.
 {const r=await router();assert.deepEqual([r.state,r.error,r.observedAt],['unavailable','key-missing',null]);}
 // The key goes in through the write-only field; "Test now" pulls.
 assert.equal((await h.post('/api/admin/integrations/settings',{id:'unifi.api',values:{apiKey:KEY}},h.admin)).status,200);
 const tested=await (await h.post('/api/admin/integrations/test',{id:'unifi.api'},h.admin)).json();
 assert.equal(tested.result.state,'ok',JSON.stringify(tested.result));
 const r=await router();
 assert.equal(r.state,'ok');assert.equal(r.status,'ok');assert.deepEqual(r.adapter,{id:'unifi-api',title:'UniFi Network API'});
 assert.equal(r.staleAfterSeconds,180);
 assert.equal(r.clients.length,30);
 assert.deepEqual(r.clients[0],{mac:'02:00:00:00:00:00',id:'020000000000',ip:'10.0.0.2',name:'client-0',connection:'Ethernet',presence:'reachable'});
 assert.deepEqual(r.clients.slice(1,4).map(x=>x.connection),['Wi-Fi · 5 GHz','Wi-Fi · 2.4 GHz','Wi-Fi · 6 GHz']);
 assert.equal(r.clients[4].connection,'Unknown');
 assert.equal(r.model,'UniFi Dream Router 7 (UDR7)');assert.equal(r.firmware,'4.1.13');assert.equal(r.routerMac,'0a:00:00:00:00:01');
 assert.deepEqual(r.health.hardware.map(x=>[x.name,x.state,x.ip]),[['Gateway','ONLINE','10.0.0.1'],['Hallway AP','OFFLINE','10.0.0.250']]);
 assert.equal(r.health.status,'degraded','an access point is offline');assert.equal(r.health.softwareVersion,'9.4.19');assert.equal(r.health.backend,'integration-api');
 assert.deepEqual(r.health.clientCounts,{connected:30,wired:6,wireless:18,other:6,known:30});
 assert.equal(r.provenance.kind,'plugin');assert.equal(r.provenance.kinds[0].id,'unifi-api');assert.equal(r.provenance.kinds[0].count,30);
 c=await card();
 assert.equal(c.status.state,'ok');assert.equal(c.settings.values.apiKey.set,true);
 assert.ok(c.status.configuredBy.some(x=>x.source==='ui'&&x.name==='apiKey'));
 const everything=JSON.stringify([r,c,tested,await (await fetch(h.origin+'/api/home',{headers:h.admin})).json()]);
 assert.ok(!everything.includes(KEY),'the key is in no answer');
 assert.ok(gateway.requests.length>0&&gateway.requests.every(x=>x.method==='GET'));
});

test('a wrong key: the router reads unavailable with an error code; the card says why; no key anywhere',async t=>{
 const {h,card,router}=await unifiHub(t);
 await h.post('/api/admin/integrations/settings',{id:'unifi.api',values:{apiKey:'not-the-key'}},h.admin);
 const tested=await (await h.post('/api/admin/integrations/test',{id:'unifi.api'},h.admin)).json();
 assert.equal(tested.result.state,'error');assert.equal(tested.result.lastError,'unauthorized');
 const r=await router();
 assert.deepEqual([r.state,r.error,r.observedAt,r.clients.length],['unavailable','unauthorized',null,0]);
 assert.ok(!JSON.stringify([r,await card(),tested]).includes('not-the-key'));
});

test('the switch: off, the hub asks the gateway nothing and the router says so',async t=>{
 const {gateway,h,card,router}=await unifiHub(t);
 await h.post('/api/admin/integrations/settings',{id:'unifi.api',values:{apiKey:KEY}},h.admin);
 await h.post('/api/admin/integrations/test',{id:'unifi.api'},h.admin);
 assert.equal((await router()).state,'ok');
 assert.equal((await h.post('/api/admin/integrations/toggle',{id:'unifi.api',enabled:false},h.admin)).status,200);
 const before=gateway.requests.length;
 const r=await router();assert.deepEqual([r.state,r.error],['unavailable','integration-off']);
 assert.equal((await card()).status.state,'disabled');
 assert.equal((await h.post('/api/admin/integrations/test',{id:'unifi.api'},h.admin)).status,409);
 assert.equal(gateway.requests.length,before,'nothing was asked while off');
});

test('inert without plugins.unifi; another router.adapter is named on the card',async t=>{
 const {gateway,card,router}=await unifiHub(t,{section:null,routerConfig:null});
 assert.equal((await router()).state,'not-configured','no adapter is provided');
 assert.equal((await card()).status.state,'not-configured');
 assert.equal(gateway.requests.length,0);
 const other=await unifiHub(t,{routerConfig:{adapter:'unifi'}});
 const c=await other.card();assert.equal(c.status.items[0].id,'adapter');assert.equal(c.status.items[0].state,'not-configured');
 assert.equal((await other.router()).adapter.id,'unifi','the included file adapter is the one in use');
 assert.equal(other.gateway.requests.length,0);
});

test('a wrong plugins.unifi stops the start, by name',async t=>{
 const site=validateSite({plugins:{unifi:{host:'10.0.0.1',apiKey:'x'}}});
 await assert.rejects(hub(t,{plugins:[plugin],site}),/plugins\.unifi\.\(the section\) has unknown field\(s\): apiKey/);
});

// The poller, driven by hand with a stand-in hub (handler.start would start core's own pollers too).
test('the poller pulls at start and on the switch turned on; it does nothing while another adapter is in use',async t=>{
 const gateway=await startFakeUnifi();
 const dir=await mkdtemp(path.join(os.tmpdir(),'unifi-poller-'));
 t.after(async()=>{await gateway.close();await rm(dir,{recursive:true,force:true});});
 const standIn=adapter=>{let listener=null;const site=validateSite({lanCidrs:['10.0.0.0/24'],...(adapter?{router:{adapter}}:{}),plugins:{unifi:{host:'127.0.0.1',port:gateway.port,fingerprint:PIN}}});
  return {site,options:{unifi:{privateDirectory:path.join(dir,'private')}},pluginData:()=>path.join(dir,adapter||'none'),integrationSecret:()=>KEY,integrationEnabled:()=>true,
   onIntegrationChange:fn=>{listener=fn;return ()=>{listener=null;};},fire:change=>listener?.(change),listening:()=>Boolean(listener)};};
 const poller=plugin.pollers[0];
 const h=standIn('unifi-api'),state=plugin.setup(h);
 await poller.start(state,h);
 await state.unifi.refresh();
 assert.equal(state.unifi.status().observation.status,'ok','pulled at start');
 const before=gateway.requests.length;
 await h.fire({id:'unifi.api',enabled:true});await state.unifi.refresh();
 assert.ok(gateway.requests.length>before,'turned on: a pull at once');
 await poller.stop(state,h);assert.equal(h.listening(),false);
 const other=standIn('unifi'),idle=plugin.setup(other),count=gateway.requests.length;
 await poller.start(idle,other);await poller.stop(idle,other);
 assert.equal(gateway.requests.length,count,'router.adapter names another adapter: no pull');
 const none=validateSite({});assert.deepEqual(plugin.setup({site:none,options:{}}),{config:null,unifi:null});
 await poller.start({config:null,unifi:null},{site:none});
});

test('either router switch cancels a pending pull, preserves the last observation and prevents new requests',async t=>{
 const gateway=await startFakeUnifi();
 const dir=await mkdtemp(path.join(os.tmpdir(),'unifi-switches-'));
 t.after(async()=>{await gateway.close();await rm(dir,{recursive:true,force:true});});
 let listener;
 const enabled={'unifi.api':true,'router.adapter':true};
 const h={site:validateSite({lanCidrs:['10.0.0.0/24'],router:{adapter:'unifi-api'},plugins:{unifi:{host:'127.0.0.1',port:gateway.port,fingerprint:PIN,timeoutSeconds:30}}}),
  options:{unifi:{privateDirectory:path.join(dir,'private')}},pluginData:()=>dir,integrationSecret:()=>KEY,
  integrationEnabled:id=>enabled[id]!==false,onIntegrationChange:fn=>{listener=fn;return ()=>{listener=null;};}};
 const state=plugin.setup(h),poller=plugin.pollers[0];t.after(()=>poller.stop(state));
 await poller.start(state,h);await state.unifi.refresh();
 for(const id of Object.keys(enabled)){
  const previous=state.unifi.status().observation,stored=await readFile(path.join(dir,'observation.json'),'utf8');
  let requested;const requestStarted=new Promise(resolve=>{requested=resolve;});
  gateway.set({mode:'hang',onRequest:requested});
  const pending=state.unifi.refresh({force:true});await requestStarted;
  const before=gateway.requests.length;enabled[id]=false;await listener({id,enabled:false});
  assert.deepEqual(await pending,previous,'discard the interrupted pull');
  assert.equal(await readFile(path.join(dir,'observation.json'),'utf8'),stored,'never persist the interrupted pull');
  await state.unifi.refresh({force:true});await state.unifi.adapter.read();
  assert.equal(gateway.requests.length,before,`${id} off: no requests`);
  gateway.set({mode:null,onRequest:null});enabled[id]=true;await listener({id,enabled:true});
  assert.ok(gateway.requests.length>before,`${id} on: refresh resumes`);
  assert.equal(state.unifi.status().observation.status,'ok');
 }
});
