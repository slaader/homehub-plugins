// The adapter against a fake UniFi gateway on 127.0.0.1 (tests/fake-unifi.mjs): paging, the pin, the key, the
// bounds, and that a failure keeps the last census and never carries the key. No other network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,chmod} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createUnifiAdapter,loadKey,PAGE} from '../server/adapter.mjs';
import {observeFingerprint,getJson} from '../server/client.mjs';
import {readUnifiConfig} from '../server/config.mjs';
import {startFakeUnifi,makeClients,KEY,PIN,OTHER_PIN} from './fake-unifi.mjs';

async function setup(t,{config={},fake={},secret=KEY,site={lanCidrs:['10.0.0.0/23']},...more}={}){
 const gateway=await startFakeUnifi(fake);
 const dir=await mkdtemp(path.join(os.tmpdir(),'unifi-adapter-'));
 t.after(async()=>{await gateway.close();await rm(dir,{recursive:true,force:true});});
 const cfg=readUnifiConfig({host:'127.0.0.1',port:gateway.port,fingerprint:PIN,...config});
 const make=(extra={})=>createUnifiAdapter({config:cfg,site,dataDirectory:path.join(dir,'data'),privateDirectory:path.join(dir,'private'),secret:()=>secret,...more,...extra});
 return {gateway,dir,cfg,make,unifi:make()};
}
const noKey=(value,where)=>assert.ok(!JSON.stringify(value).includes(KEY),`${where} does not carry the key`);
const gets=g=>g.requests.filter(r=>r.path.startsWith('/proxy/network/integration/v1'));

test('a pull: every page of clients, the devices, the version; GET only, the key in its header',async t=>{
 const {gateway,unifi}=await setup(t,{fake:{clients:makeClients(450)}});
 const o=await unifi.refresh();
 assert.equal(o.status,'ok');assert.equal(o.error,null);assert.equal(o.observedAt,o.attemptedAt);
 assert.equal(o.clients.length,450);
 assert.deepEqual(o.clientCounts,{wired:90,wireless:270,other:90});
 assert.deepEqual([...new Set(o.clients.map(c=>c.connection))].sort(),['Ethernet','Unknown','Wi-Fi · 2.4 GHz','Wi-Fi · 5 GHz','Wi-Fi · 6 GHz']);
 assert.equal(o.clients[1].uplink,'Hallway AP');assert.equal(o.clients[0].uplink,'Gateway');
 assert.equal(o.model,'UniFi Dream Router 7 (UDR7)');assert.equal(o.firmware,'4.1.13');assert.equal(o.routerMac,'0a:00:00:00:00:01');
 assert.equal(o.softwareVersion,'9.4.19');assert.equal(o.site,'Default');assert.equal(o.backend,'integration-api');assert.equal(o.source,'UniFi Network API');
 assert.deepEqual(o.hardware.map(h=>[h.name,h.state]),[['Gateway','ONLINE'],['Hallway AP','OFFLINE']]);
 assert.equal(Object.keys(o.knownClients).length,450);
 const clientPages=gets(gateway).filter(r=>r.path.endsWith('/clients')).map(r=>[r.query.offset,r.query.limit]);
 assert.deepEqual(clientPages,[['0',String(PAGE)],['200',String(PAGE)],['400',String(PAGE)]]);
 assert.ok(gateway.requests.every(r=>r.method==='GET'&&r.key===KEY));
 assert.deepEqual([...new Set(gets(gateway).map(r=>r.path.replace(/[0-9a-f-]{36}/,'{site}')))].sort(),
  ['/proxy/network/integration/v1/info','/proxy/network/integration/v1/sites','/proxy/network/integration/v1/sites/{site}/clients','/proxy/network/integration/v1/sites/{site}/devices']);
 noKey(o,'the observation');
});

test('at most 500 clients: three pages, then the cut',async t=>{
 const {gateway,unifi}=await setup(t,{fake:{clients:makeClients(900)},site:{lanCidrs:['10.0.0.0/16']}});
 const o=await unifi.refresh();
 assert.equal(o.status,'ok');assert.equal(o.clients.length,500);
 assert.equal(gets(gateway).filter(r=>r.path.endsWith('/clients')).length,3,'no page beyond the budget');
});

test('a configured UniFi site is found by reference, name or id; an unknown one is no-site',async t=>{
 const {make}=await setup(t,{config:{site:'default'}});
 assert.equal((await make().refresh()).status,'ok');
 const {make:other}=await setup(t,{config:{site:'Elsewhere'}});
 assert.equal((await other().refresh()).error,'no-site');
});

test('a wrong key (401): unavailable, the last census kept with its own observedAt, the key nowhere',async t=>{
 const {gateway,unifi,dir}=await setup(t);
 const good=await unifi.refresh();assert.equal(good.status,'ok');
 gateway.set({key:'another-key'});
 const bad=await unifi.refresh({force:true});
 assert.equal(bad.status,'unavailable');assert.equal(bad.error,'unauthorized');
 assert.equal(bad.observedAt,good.observedAt,'the census is the last good one, marked by its observedAt');
 assert.ok(bad.attemptedAt>=good.attemptedAt);assert.deepEqual(bad.clients,good.clients);
 noKey(bad,'the observation');noKey(unifi.status(),'the status');
 const stored=await readFile(path.join(dir,'data','observation.json'),'utf8');assert.ok(!stored.includes(KEY));assert.equal(JSON.parse(stored).observation.error,'unauthorized');
 // Never pulled before: unavailable with no census.
 const {unifi:fresh}=await setup(t,{secret:'wrong-key'});
 const first=await fresh.refresh();assert.deepEqual([first.status,first.error,first.observedAt,first.clients],['unavailable','unauthorized',null,[]]);
});

test('the pin: a different certificate is refused before the key is sent; without a pin a self-signed one is untrusted',async t=>{
 const {gateway,unifi}=await setup(t,{config:{fingerprint:OTHER_PIN}});
 const o=await unifi.refresh();
 assert.deepEqual([o.status,o.error],['unavailable','certificate-changed']);
 assert.equal(gateway.requests.length,0,'no request (and no key) reached the gateway');
 const {gateway:g2,cfg,unifi:unpinned}=await setup(t,{config:{fingerprint:undefined}});
 assert.equal(cfg.fingerprint,null);
 assert.equal((await unpinned.refresh()).error,'certificate-untrusted');
 assert.equal(g2.requests.length,0);
 assert.equal(await observeFingerprint({host:'127.0.0.1',port:gateway.port}),PIN,'the fingerprint helper sees what the gateway presents');
});

test('bounds: a gateway that does not answer times out; an oversize or malformed answer is refused',async t=>{
 const {gateway,unifi}=await setup(t,{config:{timeoutSeconds:1},fake:{mode:'hang'}});
 const started=Date.now(),o=await unifi.refresh();
 assert.equal(o.error,'timeout');assert.ok(Date.now()-started<4000,'within the deadline');
 for(const [mode,code] of [['huge','response-too-large'],['huge-chunked','response-too-large'],['bad-json','invalid-response'],['status:500','http-500'],['status:403','forbidden'],['status:429','rate-limited']]){
  gateway.set({mode});assert.equal((await unifi.refresh({force:true})).error,code,mode);}
 await assert.rejects(getJson('/x',{host:'127.0.0.1',port:1,fingerprint:PIN,key:KEY,timeoutMs:2000}),e=>e.code==='unreachable');
});

test('read(): never waits, never throws; a pull at most once per interval; off reads nothing',async t=>{
 let clock=Date.parse('2026-11-14T12:00:00Z'),on=true;
 const {gateway,make}=await setup(t,{now:()=>clock,enabled:()=>on});
 const u=make();
 assert.equal(await u.adapter.read(),null,'nothing observed yet');
 await u.refresh();const calls=gets(gateway).length;assert.ok(calls>0,'the read started a pull');
 assert.equal((await u.adapter.read()).status,'ok');
 await u.refresh();assert.equal(gets(gateway).length,calls,'not again within the interval');
 clock+=61000;await u.adapter.read();await u.refresh();assert.ok(gets(gateway).length>calls,'due again after it');
 on=false;const before=gets(gateway).length;
 const off=await u.adapter.read();assert.deepEqual([off.status,off.error],['unavailable','integration-off']);
 clock+=600000;await u.refresh({force:true});assert.equal(gets(gateway).length,before,'off: nothing is asked');
 // A restart starts from the stored observation.
 on=true;const again=make();assert.equal((await again.adapter.read()).status,'ok');await again.refresh();
 // A broken pull (an internal error) is still an observation, not a throw.
 const odd=createUnifiAdapter({config:readUnifiConfig({host:'127.0.0.1',port:gateway.port,fingerprint:PIN}),site:{},secret:()=>{throw new TypeError('x');},privateDirectory:os.tmpdir(),log:()=>{}});
 assert.equal((await odd.refresh()).error,'internal-error');
 assert.equal(await odd.adapter.read().then(o=>o.status),'unavailable');
});

test('the key file: 0600 in the private directory, the page field first; anything else is a code',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'unifi-key-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'unifi','api-key');await import('node:fs/promises').then(f=>f.mkdir(path.dirname(file),{recursive:true}));
 const code=fn=>{try{fn();return null;}catch(e){return e.code;}};
 assert.equal(code(()=>loadKey({secret:null,keyFile:null,privateDirectory:dir})),'key-missing');
 assert.equal(code(()=>loadKey({secret:null,keyFile:'unifi/api-key',privateDirectory:dir})),'key-missing');
 await writeFile(file,KEY+'\n',{mode:0o644});await chmod(file,0o644);
 assert.equal(code(()=>loadKey({secret:null,keyFile:'unifi/api-key',privateDirectory:dir})),'key-permissions');
 await chmod(file,0o600);
 assert.deepEqual(loadKey({secret:null,keyFile:'unifi/api-key',privateDirectory:dir}),{key:KEY,from:'file'});
 assert.deepEqual(loadKey({secret:'  from-the-page  ',keyFile:'unifi/api-key',privateDirectory:dir}),{key:'from-the-page',from:'ui'});
 assert.equal(code(()=>loadKey({secret:'has spaces inside',keyFile:null,privateDirectory:dir})),'key-invalid');
 await writeFile(file,'line\nbreak');assert.equal(code(()=>loadKey({secret:null,keyFile:'unifi/api-key',privateDirectory:dir})),'key-invalid');
 assert.equal(code(()=>loadKey({secret:null,keyFile:'unifi/api-key',privateDirectory:dir,uid:12345678})),'key-permissions','owned by another user');
 // And a pull with the file.
 await writeFile(file,KEY);
 const gateway=await startFakeUnifi();t.after(()=>gateway.close());
 const u=createUnifiAdapter({config:readUnifiConfig({host:'127.0.0.1',port:gateway.port,fingerprint:PIN,keyFile:'unifi/api-key'}),site:{lanCidrs:['10.0.0.0/24']},privateDirectory:dir});
 const o=await u.refresh();assert.equal(o.status,'ok');assert.equal(u.status().keyFrom,'file');
});

test('stop() abandons a pull in flight',async t=>{
 const {unifi}=await setup(t,{config:{timeoutSeconds:30},fake:{mode:'hang'}});
 const pending=unifi.refresh();
 await new Promise(r=>setTimeout(r,200));
 const started=Date.now();await unifi.stop();const o=await pending;
 assert.ok(Date.now()-started<2000);assert.equal(o.status,'unavailable');
});
