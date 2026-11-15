import {freshness,requestorFor} from './compute-data.mjs';

const GiB=1073741824;
const gb=bytes=>bytes==null?null:Math.round(bytes/GiB*10)/10;
const GENERIC=new Set(['image','images','audio','video','music','model','models','chat','mlx','gguf','serve','server']);
const words=id=>String(id).toLowerCase().split('/').pop().split(/[^a-z0-9]+/).filter(w=>w.length>=3&&!GENERIC.has(w));
export function matchTarget(alias,candidates){
 const need=words(alias);if(!need.length)return null;
 const hits=candidates.filter(c=>{const hay=String(c).toLowerCase().split('/').pop();return need.every(w=>hay.includes(w));});
 return hits.length===1?hits[0]:null;
}
const viaFor=(model,host)=>{
 if(/omlx/i.test(model.engineType))return 'omlx';
 if(/llama\.cpp/i.test(model.engineType))return 'llama.cpp';
 for(const id of ['mlx-serve','omlx']){const s=host.find(x=>x.id===id);if(s&&matchTarget(model.id,s.models.map(m=>m.id)))return id;}
 return null;
};
export function enrichRuntimes(out,latest,now=Date.now()){
 for(const [host,entry] of Object.entries(out||{})){
  const services=latest?.[host]?.snapshot?.services||[],fresh=freshness(latest?.[host]?.snapshot?.collectedAt,now)==='fresh';
  for(const runtime of entry.runtimes){
   const s=services.find(x=>x.id===runtime.id);if(!s)continue;
   runtime.role=s.id==='llama-swap'?'gateway':'engine';
   if(s.pool?.capacityGb!=null)runtime.memory={usedGb:fresh?s.pool.allocatedGb??0:null,capacityGb:s.pool.capacityGb,basis:'budget'};
   else if(s.memory.maxBytes!=null||s.memory.usedBytes!=null)runtime.memory={usedGb:fresh?gb(s.memory.usedBytes):null,capacityGb:gb(s.memory.maxBytes),basis:'resident'};
   for(const m of runtime.models){
    const src=s.models.find(x=>x.id===m.id);if(!src)continue;
    Object.assign(m,{name:src.name||src.id,capabilities:src.capabilities,engine:src.engineType||null,lastRequestAt:src.lastRequestAt,ttlSeconds:src.ttlSeconds});
    if(runtime.role==='gateway'){
     const via=viaFor(src,services);if(!via)continue;m.via=via;
     const engine=services.find(x=>x.id===via),target=engine&&matchTarget(src.id,engine.models.map(x=>x.id));if(target)m.target=target;
    }
   }
  }
 }
 return out;
}
export function requestsReader(store,hosts=[]){
 return {id:'macos-runtimes-history',async read({from,to,limit=200000}={}){
  const out=[];
  for(const host of hosts){
   for(const r of await store.readRecords(host,from,to)){
    if(r.kind!=='request')continue;
    out.push({device:host,runtime:r.serviceId||'llama-swap',model:r.model,at:r.at,metricId:r.metricId,path:r.path,inputTokens:r.inputTokens,outputTokens:r.outputTokens,promptTps:r.promptTps,
     generationTps:r.generationTps,durationMs:r.durationMs,client:(c=>c==='Unattributed'?'':c)(r.requestor||requestorFor(r.uaFamily))});
    if(out.length>=limit)return out;
   }
  }
  return out;
 }};
}
