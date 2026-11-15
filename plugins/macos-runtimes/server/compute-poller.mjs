import {normalizeSnapshot} from './compute-data.mjs';
export function createComputePoller({bridges={},store,intervalMs=60000,now=Date.now,log=()=>{},snapshotOnly=[],enabled=()=>true,hosts=[],devices=hosts.filter(h=>h.bridge!==false).map(h=>h.id)}){
 const latest={},snapshotsOnly=new Set(snapshotOnly);let timer=null,running=null;
 async function pollHost(host){
  const request=bridges[host];
  if(!request){latest[host]={...(latest[host]||{}),bridge:'not-configured',checkedAt:new Date(now()).toISOString()};return;}
  try{
   const snapshot=normalizeSnapshot(await request('/compute/snapshot','GET'),now(),hosts);
   latest[host]={snapshot,bridge:'connected',checkedAt:new Date(now()).toISOString()};await store.saveLatest(host,snapshot);
   if(snapshotsOnly.has(host))return;
   let cursor=await store.getCursor(host);
   for(let round=0;round<5;round++){
    const batch=await request('/compute/records','GET',{after:String(cursor)});
    const items=Array.isArray(batch?.items)?batch.items.slice(0,1000):[],next=batch?.cursor;
    if(!Number.isSafeInteger(next)||next<0)break;
    if(next<cursor){cursor=0;await store.setCursor(host,0);continue;}
    if(items.length)await store.ingest(host,items,now());
    if(next!==cursor){cursor=next;await store.setCursor(host,cursor);}
    if(batch.more!==true)break;
   }
  }catch(e){latest[host]={...(latest[host]||{}),bridge:'unavailable',checkedAt:new Date(now()).toISOString()};log(host,e.message);}
 }
 function poll(){if(!enabled())return Promise.resolve();if(!running)running=Promise.all(devices.map(pollHost)).finally(()=>{running=null;});return running;}
 async function start(){
  for(const host of devices){const snapshot=await store.loadLatest(host);if(snapshot)latest[host]={snapshot,bridge:'unknown',checkedAt:null};}
  await poll();timer=setInterval(poll,intervalMs);timer.unref?.();
 }
 return {start,stop:()=>clearInterval(timer),poll,latest:()=>latest,snapshotOnly:()=>[...snapshotsOnly]};
}
