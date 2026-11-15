import {readFile,writeFile,rename,mkdir,readdir,appendFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {createReadStream} from 'node:fs';
async function* historyLines(file){
 let buffer='',discard=false;
 for await(const chunk of createReadStream(file,{encoding:'utf8',highWaterMark:16384})){
  const parts=chunk.split('\n');
  for(let i=0;i<parts.length;i++){
   if(buffer.length+parts[i].length>8192){buffer='';discard=true;}
   if(!discard)buffer+=parts[i];
   if(i<parts.length-1){if(!discard)yield buffer;buffer='';discard=false;}
  }
 }
 if(buffer&&!discard)yield buffer;
}
export function freshness(timestamp,now=Date.now()){const age=now-Date.parse(timestamp);return !Number.isFinite(age)||age< -60000?'unknown':age>180000?'stale':'fresh';}
import {controlAction,controlState} from './control-data.mjs';
import {hostDefinition} from './config.mjs';
export const text=(v,n=160)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,n):'';
const number=(v,max=Number.MAX_SAFE_INTEGER)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max?v:null;
const integer=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const bool=v=>typeof v==='boolean'?v:null;
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const list=(v,n=50)=>Array.isArray(v)?v.slice(0,n):[];
const object=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
const oneOf=(v,allowed,fallback)=>allowed.includes(v)?v:fallback;
const DEVICE=/^[a-z][a-z0-9_-]{1,31}$/;
const bridged=(hosts,id)=>hosts.some(h=>h.id===id&&h.bridge!==false);
export const serviceIds=['llama-swap','omlx','mlx-serve','mflux'];
const activity=v=>{const r=object(v),active=integer(r.active),queued=integer(r.queued);return active===null&&queued===null?null:{active:active??0,queued:queued??0};};
const modelKinds=['llm','embedding','image','video','music','audio','other'];
const pidList=v=>list(v,16).filter(p=>Number.isSafeInteger(p)&&p>0);
export const modelStates=['loaded','loading','unloaded','unknown'];
export const requestPaths=['chat','completion','messages','embeddings','responses','rerank','audio','images','other'];
export const ranges={'24h':{ms:86400000,bucket:'hour'},'7d':{ms:7*86400000,bucket:'day'},'30d':{ms:30*86400000,bucket:'day'},'90d':{ms:90*86400000,bucket:'day'}};
export const computeActions=['unload-all','unload-model','warm','unload-audio'];
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const requestorRules=[[/^claude-cli$/i,'Claude Code'],[/^codex/i,'Codex'],[/^deno$/i,'OB1'],[/^(node|undici)$/i,'Node client'],[/^(python-httpx|httpx|aiohttp|python-requests|openai-python|OpenAI)$/i,'Python client'],[/^curl$/i,'curl'],[/^(mozilla|com\.apple\.webkit\.networking)$/i,'Browser'],[/^home-hub/i,'Home Hub']];
export function uaFamilyOf(userAgent){const raw=text(userAgent,200).trim();return raw?raw.split(/[\s/(;]/)[0].slice(0,40):'';}
export function requestorFor(uaFamily){const family=text(uaFamily,40).trim();if(!family)return 'Unattributed';for(const [re,name] of requestorRules)if(re.test(family))return name;return family;}
export function classifyPath(p){const s=text(p,200).split('?')[0];if(/\/chat\/completions$/.test(s))return 'chat';if(/\/messages(\/count_tokens)?$/.test(s))return 'messages';if(/\/embeddings$/.test(s))return 'embeddings';if(/\/responses$/.test(s))return 'responses';if(/rerank/.test(s))return 'rerank';if(/\/audio\//.test(s))return 'audio';if(/\/images\//.test(s))return 'images';if(/\/completions?$|\/infill$/.test(s))return 'completion';return 'other';}
export function normalizeModel(m){const r=object(m);return {id:text(r.id,120),name:text(r.name)||text(r.id,120),description:text(r.description,300),aliases:list(r.aliases,20).map(a=>text(a,80)).filter(Boolean),state:oneOf(r.state,modelStates,'unknown'),engineType:text(r.engineType,40),contextLength:integer(r.contextLength),sizeBytes:integer(r.sizeBytes),residentBytes:integer(r.residentBytes),capacityGb:number(r.capacityGb,100000),ttlSeconds:integer(r.ttlSeconds),ttlRemainingSeconds:integer(r.ttlRemainingSeconds),lastRequestAt:time(r.lastRequestAt),capabilities:list(r.capabilities,10).map(c=>text(c,30)).filter(Boolean),
 kind:oneOf(r.kind,modelKinds,null),pids:pidList(r.pids),...(activity(r)?{active:activity(r).active,queued:activity(r).queued,since:activity(r).active?time(r.since):null}:{})};}
export function normalizeService(s){
 const r=object(s),memory=object(r.memory),stats=object(r.stats),pool=r.pool?object(r.pool):null;
 return {id:oneOf(r.id,serviceIds,''),name:text(r.name,60),description:text(r.description,300),engine:text(r.engine,120),url:/^http:\/\/127\.0\.0\.1:\d{2,5}(\/[A-Za-z0-9._/-]*)?$/.test(r.url)?r.url:null,version:text(r.version,60),status:oneOf(r.status,['reachable','unreachable'],'unreachable'),observedAt:time(r.observedAt),
  mode:r.mode==='cli'?'cli':'server',activity:activity(r.activity),pids:pidList(r.pids),
  memory:{usedBytes:integer(memory.usedBytes),maxBytes:integer(memory.maxBytes),pressure:oneOf(memory.pressure,['ok','warn','critical'],null)},
  stats:{requests:integer(stats.requests),inputTokens:integer(stats.inputTokens),outputTokens:integer(stats.outputTokens),uptimeSeconds:integer(stats.uptimeSeconds),avgGenerationTps:number(stats.avgGenerationTps,1e6),avgPrefillTps:number(stats.avgPrefillTps,1e6)},
  pool:pool?{capacityGb:number(pool.capacityGb,100000),allocatedGb:number(pool.allocatedGb,100000)}:null,models:list(r.models,100).map(normalizeModel).filter(m=>m.id)};
}
const agentOf=v=>{const r=object(v),id=t=>typeof t==='string'&&/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(t)?t:null;const a={plugin:id(r.plugin),agent:id(r.agent),version:id(r.version),core:id(r.core),commit:typeof r.commit==='string'&&/^[a-f0-9]{7,40}$/.test(r.commit)?r.commit:null};return a.plugin&&a.version?a:null;};
export function normalizeSnapshot(raw,now=Date.now(),hosts=[]){
 const r=object(raw),host=hosts.find(h=>h.id===r.hostId&&h.bridge!==false);if(!host)throw new Error('unavailable');
 const hw=object(r.hardware),os=object(r.os),mem=object(r.memory),power=object(r.power);
 return {hostId:host.id,collectedAt:time(r.collectedAt)||new Date(now).toISOString(),hardware:{cpu:text(hw.cpu,80)||host.hardware.cpu,memoryBytes:integer(hw.memoryBytes)??host.hardware.memoryBytes,gpu:text(hw.gpu,80)||host.hardware.gpu},os:{name:text(os.name,40),version:text(os.version,40)},uptimeSeconds:integer(r.uptimeSeconds),
  memory:{usedBytes:integer(mem.usedBytes),freeBytes:integer(mem.freeBytes),totalBytes:integer(mem.totalBytes)},power:{sleepDisabled:bool(power.sleepDisabled),awakeSince:time(power.awakeSince)},actions:list(r.actions,8).filter(a=>computeActions.includes(a)&&(!host.actions||host.actions.includes(a))),services:list(r.services,10).map(normalizeService).filter(s=>s.id&&(!host.runtimes||host.runtimes.includes(s.id))),...(agentOf(r.agent)?{agent:agentOf(r.agent)}:{})};
}
export function normalizeRecord(raw){
 const r=object(raw),at=time(r.at);if(!at||r.kind==='event')return null;
 return {kind:'request',serviceId:oneOf(r.serviceId,serviceIds,'llama-swap'),metricId:integer(r.metricId),at,model:text(r.model,120)||'unknown',path:oneOf(r.path,requestPaths,'other'),status:integer(r.status),inputTokens:integer(r.inputTokens),outputTokens:integer(r.outputTokens),cacheTokens:integer(r.cacheTokens),promptTps:number(r.promptTps,1e7),generationTps:number(r.generationTps,1e7),durationMs:integer(r.durationMs),uaFamily:text(r.uaFamily,40),requestor:requestorFor(r.uaFamily)};
}
export function normalizeEvent(raw){const r=object(raw),at=time(r.at);if(!at||r.kind!=='event')return null;const state=oneOf(r.state,['loaded','unloaded','loading'],null),model=text(r.model,120);return state&&model?{kind:'event',serviceId:oneOf(r.serviceId,serviceIds,'llama-swap'),at,model,state}:null;}
export const recordKey=r=>r.kind==='event'?`e:${r.serviceId}:${r.at}:${r.model}:${r.state}`:`r:${r.serviceId}:${r.at}:${r.metricId}`;
export function createComputeStore(stateDirectory,{retentionDays=400,hosts=[]}={}){
 const dir=host=>{if(!bridged(hosts,host))throw new Error('invalid');return path.join(stateDirectory,'compute',host);};
 const seen=new Map();
 async function readJson(file,fallback){try{return JSON.parse(await readFile(file,'utf8'));}catch{return fallback;}}
 async function writeJson(file,value){await mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=`${file}.${process.pid}.tmp`;await writeFile(tmp,JSON.stringify(value),{mode:0o600});await rename(tmp,file);}
 async function readRecords(host,from,to,{limit=200000}={}){
  const out=[];let files;try{files=(await readdir(dir(host))).filter(f=>/^history-\d{4}-\d{2}\.jsonl$/.test(f)).sort();}catch{return out;}
  for(const f of files){
   const start=Date.parse(f.slice(8,15)+'-01T00:00:00Z');if(start>to||start<from-32*86400000)continue;
   let n=0;for await(const line of historyLines(path.join(dir(host),f))){if(++n>300000)break;if(!line)continue;let r;try{r=JSON.parse(line);}catch{continue;}const at=Date.parse(r?.at);if(at>=from&&at<=to){out.push({...r,hostId:host});if(out.length>=limit)return out;}}
  }
  return out;
 }
 async function recentKeys(host,now){if(!seen.has(host))seen.set(host,new Set((await readRecords(host,now-7*86400000,now+86400000)).map(recordKey)));return seen.get(host);}
 async function prune(host,now){let files=[];try{files=await readdir(dir(host));}catch{return;}for(const f of files){const m=/^history-(\d{4}-\d{2})\.jsonl$/.exec(f);if(m&&Date.parse(m[1]+'-01T00:00:00Z')<now-retentionDays*86400000)await unlink(path.join(dir(host),f));}}
 async function ingest(host,items,now=Date.now()){
  await mkdir(dir(host),{recursive:true,mode:0o700});const keys=await recentKeys(host,now),byMonth=new Map();let added=0;
  for(const raw of list(items,1000)){
   const r=raw?.kind==='event'?normalizeEvent(raw):normalizeRecord(raw);if(!r||Date.parse(r.at)>now+300000)continue;
   const key=recordKey(r);if(keys.has(key))continue;keys.add(key);added++;const month=r.at.slice(0,7);byMonth.set(month,(byMonth.get(month)||'')+JSON.stringify(r)+'\n');
  }
  for(const [month,chunk] of byMonth)await appendFile(path.join(dir(host),`history-${month}.jsonl`),chunk,{mode:0o600});
  if(keys.size>200000)seen.delete(host);await prune(host,now);return added;
 }
 return {ingest,readRecords,
  getCursor:async host=>{const v=(await readJson(path.join(dir(host),'cursor.json'),{})).cursor;return Number.isSafeInteger(v)&&v>=0?v:0;},
  setCursor:(host,cursor)=>writeJson(path.join(dir(host),'cursor.json'),{cursor}),
  saveLatest:(host,snapshot)=>writeJson(path.join(dir(host),'latest.json'),snapshot),
  loadLatest:async host=>{const raw=await readJson(path.join(dir(host),'latest.json'),null);try{return raw?normalizeSnapshot(raw,Date.now(),hosts):null;}catch{return null;}}};
}
const zones=new Map();
const zoneFormat=timeZone=>{const key=timeZone||'';if(!zones.has(key))zones.set(key,new Intl.DateTimeFormat('en-GB',{...(timeZone?{timeZone}:{}),year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}));return zones.get(key);};
export function bucketKey(ms,bucket,timeZone=null){const p=Object.fromEntries(zoneFormat(timeZone).formatToParts(ms).map(x=>[x.type,x.value]));return bucket==='hour'?`${p.year}-${p.month}-${p.day}T${p.hour}:00`:`${p.year}-${p.month}-${p.day}`;}
const median=values=>{if(!values.length)return null;const s=[...values].sort((a,b)=>a-b);const mid=Math.floor(s.length/2);return s.length%2?s[mid]:(s[mid-1]+s[mid])/2;};
const rankedLabels=(counts,limit)=>[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,limit).map(([label])=>label);
export function buildHistory(items,{range='30d',now=Date.now(),loaded=[],timeZone=null}={}){
 const spec=ranges[range];if(!spec)throw new Error('invalid');
 const from=now-spec.ms,step=spec.bucket==='hour'?3600000:86400000,buckets=[];
 for(let t=from;t<=now;t+=step){const key=bucketKey(t,spec.bucket,timeZone);if(buckets[buckets.length-1]!==key)buckets.push(key);}
 const last=bucketKey(now,spec.bucket,timeZone);if(buckets[buckets.length-1]!==last)buckets.push(last);
 const requests=items.filter(r=>r.kind==='request'&&Date.parse(r.at)>=from&&Date.parse(r.at)<=now);
 const requestorCounts=new Map(),modelCounts=new Map();
 for(const r of requests){requestorCounts.set(r.requestor,(requestorCounts.get(r.requestor)||0)+1);modelCounts.set(r.model,(modelCounts.get(r.model)||0)+1);}
 const requestors=rankedLabels(requestorCounts,11),models=rankedLabels(modelCounts,11);
 const requestorOf=r=>requestors.includes(r.requestor)?r.requestor:'Other',modelOf=r=>models.includes(r.model)?r.model:'Other';
 if(requestorCounts.size>requestors.length)requestors.push('Other');if(modelCounts.size>models.length)models.push('Other');
 const byRequestor=new Map(),byModel=new Map(),tps=new Map(),hours=Array(24).fill(0),topRequestors=new Map(),topModels=new Map();
 const add=(map,key,fn)=>{const v=map.get(key)||fn();map.set(key,v);return v;};
 for(const r of requests){
  const at=Date.parse(r.at),bucket=bucketKey(at,spec.bucket,timeZone),requestor=requestorOf(r),model=modelOf(r);
  add(byRequestor,`${bucket}\u0000${requestor}`,()=>({bucket,requestor,count:0})).count++;
  const tokens=add(byModel,`${bucket}\u0000${model}`,()=>({bucket,model,count:0,input:0,output:0}));tokens.count++;tokens.input+=r.inputTokens||0;tokens.output+=r.outputTokens||0;
  if(r.generationTps>0&&(r.outputTokens||0)>=8)add(tps,`${bucket}\u0000${model}`,()=>({bucket,model,values:[]})).values.push(r.generationTps);
  hours[Number(zoneFormat(timeZone).formatToParts(at).find(x=>x.type==='hour').value)%24]++;
  const tr=add(topRequestors,r.requestor,()=>({label:r.requestor,count:0,inputTokens:0,outputTokens:0}));tr.count++;tr.inputTokens+=r.inputTokens||0;tr.outputTokens+=r.outputTokens||0;
  const tm=add(topModels,r.model,()=>({label:r.model,count:0,outputTokens:0,tps:[],durations:[]}));tm.count++;tm.outputTokens+=r.outputTokens||0;if(r.generationTps>0&&(r.outputTokens||0)>=8)tm.tps.push(r.generationTps);if(r.durationMs!=null)tm.durations.push(r.durationMs);
 }
 const total=requests.length,attributed=requests.filter(r=>r.requestor!=='Unattributed').length;
 const residency=[];const events=items.filter(r=>r.kind==='event'&&Date.parse(r.at)<=now).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 const open=new Map();const spanKey=e=>`${e.hostId||''}\u0000${e.model}`;
 for(const e of events){const key=spanKey(e);if(e.state==='loaded'){if(!open.has(key))open.set(key,Date.parse(e.at));}else if(e.state==='unloaded'&&open.has(key)){const start=open.get(key);open.delete(key);if(Date.parse(e.at)>=from)residency.push({hostId:e.hostId||null,model:e.model,from:new Date(Math.max(start,from)).toISOString(),to:e.at});}}
 for(const [key,start] of open){const [hostId,model]=key.split('\u0000');if(loaded.some(l=>l.model===model&&(!hostId||l.hostId===hostId)))residency.push({hostId:hostId||null,model,from:new Date(Math.max(start,from)).toISOString(),to:new Date(now).toISOString()});}
 return {range,bucket:spec.bucket,timeZone:zoneFormat(timeZone).resolvedOptions().timeZone,from:new Date(from).toISOString(),to:new Date(now).toISOString(),buckets,requestors,models,
  requestsByRequestor:[...byRequestor.values()],tokensByModel:[...byModel.values()].map(({values,...row})=>row),tpsByModel:[...tps.values()].map(r=>({bucket:r.bucket,model:r.model,median:median(r.values),count:r.values.length})),
  topRequestors:[...topRequestors.values()].sort((a,b)=>b.count-a.count).slice(0,20).map(r=>({...r,share:total?r.count/total:0})),
  topModels:[...topModels.values()].sort((a,b)=>b.count-a.count).slice(0,20).map(r=>({label:r.label,count:r.count,outputTokens:r.outputTokens,medianTps:median(r.tps),medianDurationMs:median(r.durations)})),
  busiestHours:hours.map((count,hour)=>({hour,count})),residency:residency.slice(0,500),totals:{requests:total,attributed,inputTokens:requests.reduce((n,r)=>n+(r.inputTokens||0),0),outputTokens:requests.reduce((n,r)=>n+(r.outputTokens||0),0)}};
}
export function computeAction(input,hosts=null){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['host','action','model','requestId'].includes(k)))throw new Error('invalid');
 if(!(hosts?bridged(hosts,input.host):typeof input.host==='string'&&DEVICE.test(input.host))||!computeActions.includes(input.action)||typeof input.requestId!=='string'||!uuid.test(input.requestId))throw new Error('invalid');
 const allowed=hosts?.find(h=>h.id===input.host)?.actions;if(allowed&&!allowed.includes(input.action))throw new Error('invalid');
 const needsModel=['unload-model','warm'].includes(input.action);
 if(needsModel?(typeof input.model!=='string'||(!/^[A-Za-z0-9._:-]{1,120}$/.test(input.model)||['.','..'].includes(input.model))):input.model!==undefined)throw new Error('invalid');
 return needsModel?{host:input.host,action:input.action,model:input.model,requestId:input.requestId}:{host:input.host,action:input.action,requestId:input.requestId};
}
export function historyQuery(input,devices=[]){const host=input?.host??'all',range=input?.range??'30d';if(!['all',...devices].includes(host)||!ranges[range]||Object.keys(object(input)).some(k=>!['host','range'].includes(k)))throw new Error('invalid');return {host,range};}
export const hostControlDefinitions=(host,controls={})=>controls[host]||[];
export function hostControlAction(input,controls={},devices=Object.keys(controls)){if(!input||typeof input!=='object'||!devices.includes(input.host))throw new Error('invalid');const {host,...rest}=input;return {host,...controlAction(rest,hostControlDefinitions(host,controls))};}
export const hostControlState=(raw,host,controls={})=>controlState(raw,hostControlDefinitions(host,controls));
export function computeSummary(latest,now=Date.now(),hosts=[],page={knownAddresses:[],links:{}}){
 return {generatedAt:new Date(now).toISOString(),page:{knownAddresses:[...page.knownAddresses],links:structuredClone(page.links)},hosts:hosts.map(config=>{
  const h=hostDefinition(config);
  if(config.bridge===false)return {...h,state:'Inference not configured',bridge:'not-applicable',freshness:'fresh',collectedAt:null,os:config.os?{...config.os}:{name:'',version:''},uptimeSeconds:null,memory:{usedBytes:null,freeBytes:null,totalBytes:h.hardware.memoryBytes},power:{sleepDisabled:null,awakeSince:null},services:[],alerts:[]};
  const entry=latest?.[h.id]||{},s=entry.snapshot||null,fresh=s?freshness(s.collectedAt,now):'unknown',bridge=['connected','unavailable','unknown','not-configured'].includes(entry.bridge)?entry.bridge:'unavailable';
  const alerts=[];if(bridge!=='connected')alerts.push({tone:'amber',text:`${h.name}: bridge ${bridge==='not-configured'?'not configured':'unavailable'}; showing last known data.`});
  if(s&&fresh!=='fresh')alerts.push({tone:'amber',text:`${h.name}: telemetry is ${fresh}. Last collected ${s.collectedAt}.`});
  for(const service of s?.services||[])if(service.memory.pressure&&service.memory.pressure!=='ok')alerts.push({tone:service.memory.pressure==='critical'?'danger':'amber',text:`${h.name}: ${service.name} reports ${service.memory.pressure} memory pressure.`});
  return {...h,...(s||{}),hardware:s?.hardware||h.hardware,os:s?.os||{name:'',version:''},memory:s?.memory||{usedBytes:null,freeBytes:null,totalBytes:h.hardware.memoryBytes},power:s?.power||{sleepDisabled:null,awakeSince:null},services:s?.services||[],collectedAt:s?.collectedAt||null,freshness:fresh,bridge,checkedAt:time(entry.checkedAt),state:!s?(bridge==='connected'?'No data yet':'Unavailable'):fresh==='fresh'?'Reporting':'Stale',alerts};
 })};
}

const GiB=1073741824;
const gb=bytes=>bytes==null?null:Math.round(bytes/GiB*10)/10;
const short=n=>n>=1e9?`${Math.round(n/1e8)/10}G`:n>=1e6?`${Math.round(n/1e5)/10}M`:n>=1e4?`${Math.round(n/1e3)}k`:String(n);
function runtimeStats(service){
 const st=service.stats,out=[];
 if(service.mode==='cli')return [{label:'běží',value:String(service.activity?.active??0)},{label:'ve frontě',value:String(service.activity?.queued??0)},
  ...(gb(service.memory.usedBytes)>=0.1?[{label:'paměť úloh',value:`${gb(service.memory.usedBytes)} GB`}]:[])];
 if(st.avgGenerationTps>0)out.push({label:'tokeny/s',value:String(Math.round(st.avgGenerationTps*10)/10)});
 if(st.requests!=null)out.push({label:'požadavky',value:short(st.requests)});
 if(st.outputTokens!=null)out.push({label:'tokeny ven',value:short(st.outputTokens)});
 if(service.pool?.capacityGb!=null)out.push({label:'rozpočet paměti',value:`${service.pool.allocatedGb??0} / ${service.pool.capacityGb} GB`});
 else if(service.memory.maxBytes)out.push({label:'paměť modelů',value:`${gb(service.memory.usedBytes??0)} / ${gb(service.memory.maxBytes)} GB`});
 return out.slice(0,4);
}
export function runtimesFromLatest(latest,now=Date.now(),devices=Object.keys(latest||{})){
 const out={};
 for(const host of devices){
  const snapshot=latest?.[host]?.snapshot;if(!snapshot?.services?.length)continue;
  const fresh=freshness(snapshot.collectedAt,now)==='fresh';
  out[host]={source:'plugin macos-runtimes',observedAt:snapshot.collectedAt,runtimes:snapshot.services.map(service=>({
   id:service.id,name:service.name||service.id,kind:service.engine,version:service.version,url:service.url,
   status:!fresh?'unknown':service.status==='reachable'?'running':'stopped',
   ...(service.mode==='cli'?{mode:'cli'}:{}),...(fresh&&service.activity?{activity:service.activity}:{}),...(fresh&&service.pids.length?{pids:service.pids}:{}),
   models:[...service.models].sort((a,b)=>(b.state==='loaded')-(a.state==='loaded')).map(m=>({id:m.id,state:fresh?m.state:'unknown',
    sizeGb:gb(m.state==='loaded'?m.residentBytes??m.sizeBytes:m.sizeBytes)??m.capacityGb,contextTokens:m.contextLength,ttlRemainingSeconds:fresh?m.ttlRemainingSeconds:null,
    ...(m.kind?{kind:m.kind}:{}),...(fresh&&m.active!=null?{active:m.active,queued:m.queued,...(m.since?{since:m.since}:{})}:{}),...(fresh&&m.pids.length?{pids:m.pids}:{})})),
   stats:runtimeStats(service)}))};
 }
 return out;
}
