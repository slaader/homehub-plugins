import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,rename,appendFile,stat,readdir} from 'node:fs/promises';
import {classifyPath,uaFamilyOf,computeAction} from '../server/compute-data.mjs';
const exec=promisify(execFile);
export async function readBody(url,{timeout=8000,method='GET',body,headers={},max=2*1024*1024,fetcher=fetch}={}){
 const response=await fetcher(url,{method,body,headers:{'User-Agent':'home-hub-bridge/1',...headers},redirect:'error',signal:AbortSignal.timeout(timeout)});
 let size=0;const chunks=[];for await(const chunk of response.body||[]){size+=chunk.length;if(size>max){throw new Error('too-large');}chunks.push(Buffer.from(chunk));}
 if(!response.ok)throw new Error(`http-${response.status}`);return Buffer.concat(chunks).toString();
}
const readJson=async(url,options)=>JSON.parse(await readBody(url,options));
export function parseLlamaSwapConfig(source){
 const out={poolGb:null,globalTtl:null,models:{}};let section=null,model=null,sub=null;
 for(const raw of String(source).split('\n')){
  const line=raw.replace(/\s+#.*$/,'').replace(/^#.*$/,'').trimEnd();if(!line.trim())continue;
  const indent=line.length-line.trimStart().length,t=line.trim();
  if(indent===0){section=t.replace(/:.*$/,'');model=null;sub=null;const g=/^globalTTL:\s*(\d+)/.exec(t);if(g)out.globalTtl=Number(g[1]);continue;}
  if(section==='routing'){const m=/^ram:\s*([\d.]+)$/.exec(t);if(m&&out.poolGb==null)out.poolGb=Number(m[1]);continue;}
  if(section!=='models')continue;
  if(indent===2&&/^[\w.-]+:$/.test(t)){model=t.slice(0,-1);out.models[model]={};sub=null;continue;}
  if(!model)continue;
  if(indent===4){const m=/^(\w+):\s*(.*)$/.exec(t);if(!m)continue;sub=m[2]===''?m[1]:null;const entry=out.models[model];
   if(m[1]==='ttl')entry.ttl=Number(m[2]);if(m[1]==='useModelName')entry.useModelName=m[2];if(m[1]==='name')entry.name=m[2];if(m[1]==='description')entry.description=m[2];
   if(m[1]==='cmd'){const f=/MODEL_FILE=(\S+)/.exec(m[2]);if(f)entry.modelFile=f[1];if(/llama-swap-omlx-model/.test(m[2]))entry.sidecar='oMLX';}
   continue;}
  if(indent===6&&sub==='capacities'){const m=/^ram:\s*([\d.]+)$/.exec(t);if(m)out.models[model].capacityGb=Number(m[1]);}
 }
 return out;
}
export function parsePrometheus(source){const out=new Map();for(const line of String(source).split('\n')){if(!line||line.startsWith('#'))continue;const m=/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(line);if(m)out.set(m[1]+(m[2]||''),Number(m[3]));}return out;}
export function parseGoDuration(value){let ms=0,matched=false;for(const m of String(value).matchAll(/(\d+(?:\.\d+)?)(h|ms|µs|us|ns|m|s)/g)){matched=true;ms+=Number(m[1])*({h:3600000,m:60000,s:1000,ms:1,'µs':0.001,us:0.001,ns:0.000001})[m[2]];}return matched?Math.round(ms):null;}
const linePattern=/Request \S+ "([A-Z]+) (\S+) HTTP\/[\d.]+" (-?\d+) (-?\d+) "((?:[^"\\]|\\.)*)" (\S+)\s*$/;
export function parseAccessLine(line,now=Date.now()){
 const m=linePattern.exec(line);if(!m)return null;const [,method,rawPath,status,,ua,duration]=m;if(method!=='POST')return null;
 const kind=classifyPath(rawPath);if(kind==='other')return null;
 return {arrivedAt:now,kind,status:Number(status),uaFamily:uaFamilyOf(ua),durationMs:parseGoDuration(duration),used:false};
}
export function correlate(record,lines){
 const start=Date.parse(record.at),duration=record.durationMs||0;let best=null,bestDiff=Infinity;
 for(const line of lines){
  if(line.used||(record.path!=='other'&&line.kind!==record.path))continue;
  if(line.arrivedAt<start-8000||line.arrivedAt>start+duration+15000)continue;
  const diff=Math.abs((line.durationMs||0)-duration);if(diff>Math.max(1500,duration*0.1)||diff>=bestDiff)continue;
  best=line;bestDiff=diff;
 }
 if(best)best.used=true;return best;
}
export function watchAccessLog({base,flavor,onLine,delay=5000,get=http.get}){
 let stopped=false,request=null,timer=null;
 const url=flavor==='v268'?`${base}/logs/stream/http?no-history`:`${base}/logs/stream/proxy`;
 function retry(){if(stopped)return;clearTimeout(timer);timer=setTimeout(connect,delay);}
 function connect(){
  if(stopped)return;const startedAt=Date.now();
  request=get(url,{headers:{'User-Agent':'home-hub-bridge/1'}},response=>{
   if(response.statusCode!==200){response.resume();retry();return;}
   let buffer='';response.setEncoding('utf8');
   response.on('data',chunk=>{buffer+=chunk;if(buffer.length>65536)buffer=buffer.slice(-65536);let index;
    while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(flavor!=='v268'&&Date.now()-startedAt<2000)continue;onLine(line);}});
   response.on('end',retry);response.on('error',retry);
  });
  request.on('error',retry);
 }
 connect();return ()=>{stopped=true;clearTimeout(timer);request?.destroy();};
}
async function run(file,args,timeout=5000){try{return (await exec(file,args,{timeout,maxBuffer:65536})).stdout;}catch{return '';}}

export async function listProcesses(){return (await exec('/bin/ps',['-Ao','pid=,ppid=,etime=,pcpu=,rss=,args='],{timeout:5000,maxBuffer:8*1024*1024})).stdout;}
export function parseEtime(v){const m=/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(v).trim());return m?((Number(m[1]||0)*24+Number(m[2]||0))*60+Number(m[3]))*60+Number(m[4]):null;}
export function parsePs(text){
 const out=[];
 for(const line of String(text).split('\n')){const m=/^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);if(!m)continue;
  out.push({pid:Number(m[1]),ppid:Number(m[2]),seconds:parseEtime(m[3]),cpu:Number(m[4]),rssKb:Number(m[5]),args:m[6]});}
 return out;
}
const MFLUX=/(?:^|[\s/='"])(mflux-(?!(?:capabilities|check|completions|info|lora-library)(?=[\s'";]|$))[a-z0-9][a-z0-9.-]{0,60})(?=[\s'";]|$)/g;
const MODEL_FLAG=/(?:^|\s)(?:--model|--base-model|-m)(?:=|\s+)(\S+)/;
function modelName(raw,command){
 let v=String(raw||'').replace(/^['"]|['"]$/g,'');if(/^[/~.]/.test(v))v=v.replace(/\/+$/,'').split('/').pop();
 return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(v)?v:command.replace(/^mflux-(generate-|upscale-)?/,'')||'mflux';
}
const FILE=/\.(log|txt|out|err|json|ya?ml|md|png|jpe?g|webp|gif|mp4|mov|wav|py|sh|sock|lock|pid)$/i;
function mentions(args){
 const hits=[...String(args).matchAll(MFLUX)].filter(h=>!FILE.test(h[1]));
 return hits.map((h,i)=>{const end=i+1<hits.length?hits[i+1].index:args.length,segment=args.slice(h.index+h[0].length,end).split(/;|&&|\|\|/)[0];
  return {command:h[1],model:modelName(MODEL_FLAG.exec(segment)?.[1],h[1])};});
}
const base=token=>String(token).split('/').pop();
const isPython=token=>/^python\d*(\.\d+)*$/i.test(base(token));
const isWaiter=token=>/^-?(sh|bash|zsh|dash|ksh|fish|time|env|nice|nohup|caffeinate|timeout|gtimeout|uv|uvx|xargs|parallel)$/.test(base(token));
export function jobsFrom(processes,now=Date.now()){
 const byPid=new Map(processes.map(p=>[p.pid,p])),children=new Map();
 for(const p of processes){if(!children.has(p.ppid))children.set(p.ppid,[]);children.get(p.ppid).push(p);}
 const key=j=>`${j.command}\u0000${j.model}`,since=p=>p.seconds==null?null:new Date(now-p.seconds*1000).toISOString();
 const runners=new Map();
 for(const p of processes){const tokens=p.args.split(/\s+/);if(!isPython(tokens[0]))continue;const first=mentions(tokens.slice(1,2).join(' '))[0];if(!first)continue;
  const job=mentions(p.args)[0];runners.set(p.pid,{pid:p.pid,command:job.command,model:job.model,since:since(p),cpu:p.cpu,rssBytes:p.rssKb*1024});}
 const below=(pid,seen=new Set())=>{const out=[];for(const c of children.get(pid)||[]){if(seen.has(c.pid))continue;seen.add(c.pid);if(runners.has(c.pid))out.push(runners.get(c.pid));out.push(...below(c.pid,seen));}return out;};
 const waiting=new Map();// pid → keys it waits for
 for(const p of processes){if(runners.has(p.pid)||!isWaiter(p.args.split(/\s+/)[0]))continue;const named=mentions(p.args);if(!named.length)continue;
  const running=new Set(below(p.pid).map(key)),keys=new Set(named.map(key).filter(k=>!running.has(k)));if(keys.size)waiting.set(p.pid,{p,keys,named});}
 const queued=[];
 for(const {p,keys,named} of waiting.values())for(const k of keys){
  let up=byPid.get(p.ppid),outer=false;const seen=new Set();
  while(up&&!seen.has(up.pid)){seen.add(up.pid);if(waiting.get(up.pid)?.keys.has(k)){outer=true;break;}up=byPid.get(up.ppid);}
  if(!outer){const j=named.find(x=>key(x)===k);queued.push({command:j.command,model:j.model,since:since(p)});}
 }
 return {running:[...runners.values()].slice(0,20),queued:queued.slice(0,20)};
}
export function jobsService(profile,jobs,{observedAt,version=''}={}){
 const models=new Map();
 for(const [list,running] of [[jobs.running,true],[jobs.queued,false]])for(const j of list){
  const m=models.get(j.model)||{id:j.model,name:j.model,description:'',aliases:[],state:'unloaded',engineType:'mflux',kind:/video|ltx|wan2/i.test(`${j.command} ${j.model}`)?'video':'image',
   commands:new Set(),pids:[],contextLength:null,sizeBytes:null,residentBytes:null,capacityGb:null,ttlSeconds:null,ttlRemainingSeconds:null,lastRequestAt:null,capabilities:['image'],active:0,queued:0,since:null};
  m.commands.add(j.command.replace(/^mflux-/,''));
  if(running){m.state='loaded';m.active++;if(j.pid)m.pids.push(j.pid);if(j.rssBytes>=128*1024**2)m.residentBytes=(m.residentBytes||0)+j.rssBytes;if(j.since&&(!m.since||j.since<m.since))m.since=j.since;}else m.queued++;
  models.set(j.model,m);
 }
 const list=[...models.values()].map(({commands,...m})=>({...m,name:`${m.id} · ${[...commands].join(', ')}`}));
 const active=jobs.running.length,queued=jobs.queued.length;
 return {id:'mflux',name:profile.name,description:profile.description,engine:profile.engine,url:null,version,mode:'cli',status:active||queued?'reachable':'unreachable',observedAt,
  memory:{usedBytes:jobs.running.reduce((n,j)=>n+j.rssBytes,0),maxBytes:null,pressure:null},stats:{},pool:null,activity:{active,queued},pids:jobs.running.map(j=>j.pid).filter(Boolean).slice(0,16),models:list};
}
export function runtimePids(matchers,processes){
 const out={};for(const [id,re] of Object.entries(matchers||{}))out[id]=processes.filter(p=>re.test(p.args)).map(p=>p.pid).slice(0,16);return out;
}
async function toolVersion(dir){
 try{const lib=path.join(os.homedir(),dir,'lib');for(const py of await readdir(lib)){for(const entry of await readdir(path.join(lib,py,'site-packages'))){const m=/^mflux-([\w.]+)\.dist-info$/.exec(entry);if(m)return m[1];}}}catch{}
 return '';
}
async function deviceFacts(){
 const [version,cpu,pm,vm]=await Promise.all([run('/usr/bin/sw_vers',['-productVersion']),run('/usr/sbin/sysctl',['-n','machdep.cpu.brand_string']),run('/usr/bin/pmset',['-g']),run('/usr/bin/vm_stat',[])]);
 const sleep=/^\s*sleep\s+(\d+)/m.exec(pm),page=Number(/page size of (\d+)/.exec(vm)?.[1]||16384),pages=key=>Number(new RegExp(`^${key}:\\s+(\\d+)`,'m').exec(vm)?.[1]||0);
 const used=(pages('Pages active')+pages('Pages wired down')+pages('Pages occupied by compressor'))*page,total=os.totalmem();
 return {os:{name:'macOS',version:version.trim()},cpu:cpu.trim(),memory:{usedBytes:used,freeBytes:Math.max(0,total-used),totalBytes:total},power:{sleepDisabled:sleep?Number(sleep[1])===0:null,awakeSince:new Date(Date.now()-os.uptime()*1000).toISOString()},uptimeSeconds:Math.round(os.uptime())};
}
const pressureOf=v=>v==='ok'?'ok':/soft|warn/.test(String(v))?'warn':/hard|crit/.test(String(v))?'critical':null;
const stateOf=s=>s==='ready'||s==='loaded'?'loaded':['starting','loading','stopping','unloading','shutdown'].includes(s)?'loading':['unloaded','stopped',undefined,null,''].includes(s)?'unloaded':'unknown';
export function createComputeController({hostId,profile,fetcher=fetch,stateDirectory=path.join(os.homedir(),'.local/state/home-hub'),facts=deviceFacts,now=Date.now,watch=watchAccessLog,readConfig=file=>readFile(file,'utf8'),fileSize=async file=>(await stat(file)).size,processes=listProcesses,version=toolVersion}={}){
 if(!profile)throw new Error('invalid');
 const state={seq:0,queue:[],lastMetricAt:0,seenKeys:[],lines:[],lastRequest:new Map(),lastActivity:new Map(),previous:new Map(),warming:new Map(),config:{models:{}},sizes:new Map(),snapshot:null,builtAt:0};
 const seen=new Set();const file=path.join(stateDirectory,`compute-${hostId}.json`);
 const requests=new Map();let busy=false,building=null,stopWatch=null,timer=null;
 const get=(url,options)=>readJson(url,{...options,fetcher});
 async function load(){try{const saved=JSON.parse(await readFile(file,'utf8'));if(Number.isSafeInteger(saved.seq))state.seq=saved.seq;if(Number.isFinite(saved.lastMetricAt))state.lastMetricAt=saved.lastMetricAt;for(const key of Array.isArray(saved.seenKeys)?saved.seenKeys.slice(-2000):[])seen.add(key);state.queue=Array.isArray(saved.queue)?saved.queue.slice(-5000):[];}catch{}}
 async function save(){try{await mkdir(stateDirectory,{recursive:true,mode:0o700});const tmp=`${file}.${process.pid}.tmp`;await writeFile(tmp,JSON.stringify({seq:state.seq,lastMetricAt:state.lastMetricAt,seenKeys:[...seen].slice(-2000),queue:state.queue.slice(-5000)}),{mode:0o600});await rename(tmp,file);}catch{}}
 function enqueue(item){state.queue.push({seq:++state.seq,...item});if(state.queue.length>5000)state.queue.splice(0,state.queue.length-5000);}
 async function loadConfig(){if(!profile.llamaSwap)return;try{state.config=parseLlamaSwapConfig(await readConfig(profile.llamaSwap.configPath));}catch{state.config={models:{}};}
  for(const [id,cfg] of Object.entries(state.config.models||{}))if(cfg.modelFile&&!state.sizes.has(id))try{state.sizes.set(id,await fileSize(cfg.modelFile));}catch{}}
 async function collectLlamaSwap(){
  const ls=profile.llamaSwap;if(!ls)return null;const observedAt=new Date(now()).toISOString();
  const service={id:'llama-swap',name:ls.name,description:ls.description,engine:ls.engine,url:ls.url,version:'',status:'unreachable',observedAt,memory:{},stats:{},pool:null,models:[]};
  let listed;try{listed=(await get(`${ls.base}/v1/models`)).data;}catch{return service;}
  if(!Array.isArray(listed))return service;service.status='reachable';
  let running=[];try{running=(await get(`${ls.base}/running`)).running||[];}catch{}
  const runningBy=new Map(running.filter(r=>typeof r?.model==='string').map(r=>[r.model,r])),t=now();
  service.models=listed.filter(m=>typeof m?.id==='string').map(m=>{
   const cfg=state.config.models?.[m.id]||{},r=runningBy.get(m.id);let st=stateOf(r?.state||m.status?.value);
   const warm=state.warming.get(m.id);if(warm&&st==='unloaded'&&t-warm<600000)st='loading';else if(warm&&(st==='loaded'||t-warm>=600000))state.warming.delete(m.id);
   const ttl=Number.isFinite(r?.ttl)?r.ttl:cfg.ttl??state.config.globalTtl??null,last=state.lastActivity.get(m.id)||null;
   return {id:m.id,name:m.name||cfg.name||m.id,description:m.description||cfg.description||'',aliases:Array.isArray(m.meta?.llamaswap?.aliases)?m.meta.llamaswap.aliases:[],state:st,engineType:cfg.sidecar?'oMLX sidecar':cfg.modelFile?'llama.cpp':'',contextLength:m.context_length??m.meta?.n_ctx??null,sizeBytes:state.sizes.get(m.id)??null,residentBytes:null,capacityGb:cfg.capacityGb??null,ttlSeconds:ttl,ttlRemainingSeconds:st==='loaded'&&ttl&&last?Math.max(0,Math.round(ttl-(t-last)/1000)):null,lastRequestAt:state.lastRequest.has(m.id)?new Date(state.lastRequest.get(m.id)).toISOString():null,capabilities:[]};
  });
  if(ls.flavor==='v268'){
   try{service.version=String((await get(`${ls.base}/api/version`)).version||'');}catch{}
   try{const s=await get(`${ls.base}/api/metrics/stats`);service.stats={requests:s.total_requests,inputTokens:s.total_input_tokens,outputTokens:s.total_output_tokens};}catch{}
   if(state.config.poolGb!=null)service.pool={capacityGb:state.config.poolGb,allocatedGb:service.models.filter(m=>m.state!=='unloaded'&&m.capacityGb).reduce((n,m)=>n+m.capacityGb,0)};
  }else service.version='development build';
  return service;
 }
 async function collectOmlx(){
  const o=profile.omlx;if(!o)return null;const observedAt=new Date(now()).toISOString();
  const service={id:'omlx',name:o.name,description:o.description,engine:o.engine,url:o.url,version:'',status:'unreachable',observedAt,memory:{},stats:{},pool:null,models:[]};
  let health;try{health=await get(`${o.base}/health`);}catch{return service;}
  service.status='reachable';const pool=health.engine_pool||{};service.memory={usedBytes:pool.current_model_memory??null,maxBytes:pool.max_model_memory??pool.final_ceiling??null,pressure:null};
  let listed=[];try{listed=(await get(`${o.base}/v1/models`)).data||[];}catch{}
  if(o.admin){
   try{
    const [admin,stats]=await Promise.all([get(`${o.base}/admin/api/models`),get(`${o.base}/admin/api/stats`)]);
    service.version=stats.engines?.['mlx-lm']?.version?`mlx-lm ${stats.engines['mlx-lm'].version}`:'';
    service.stats={requests:stats.total_requests,inputTokens:stats.total_prompt_tokens,outputTokens:stats.total_completion_tokens,avgGenerationTps:stats.avg_generation_tps,avgPrefillTps:stats.avg_prefill_tps,uptimeSeconds:Math.round(stats.uptime_seconds||0)};
    const active=stats.active_models||{};service.memory={usedBytes:active.model_memory_used??service.memory.usedBytes,maxBytes:active.model_memory_max??service.memory.maxBytes,pressure:pressureOf(active.memory_pressure?.pressure_level)};
    service.models=(admin.models||[]).filter(m=>typeof m?.id==='string').map(m=>{const access=typeof m.last_access==='number'?new Date(m.last_access<1e12?m.last_access*1000:m.last_access).toISOString():typeof m.last_access==='string'?m.last_access:null;
     return {id:m.id,name:m.display_name||m.id,description:'',aliases:[],state:m.loaded?'loaded':m.is_loading?'loading':'unloaded',engineType:m.engine_type||'',contextLength:m.model_context_length??null,sizeBytes:m.estimated_size??null,residentBytes:m.loaded?(m.actual_size||m.estimated_size||null):null,capacityGb:null,ttlSeconds:m.settings?.ttl_seconds??null,ttlRemainingSeconds:null,lastRequestAt:access,capabilities:[]};});
    return service;
   }catch{}
  }
  const loadedCount=pool.loaded_count||0;
  service.models=listed.filter(m=>typeof m?.id==='string').map(m=>{const known=o.models?.[m.id]||{};return {id:m.id,name:m.id,description:known.description||'',aliases:[],state:loadedCount===0?'unloaded':loadedCount>=listed.length?'loaded':'unknown',engineType:'',contextLength:m.max_model_len??null,sizeBytes:null,residentBytes:loadedCount&&listed.length===1?pool.current_model_memory??null:null,capacityGb:null,ttlSeconds:known.ttlSeconds??null,ttlRemainingSeconds:null,lastRequestAt:null,capabilities:[]};});
  return service;
 }
 async function collectMlxServe(){
  const s=profile.mlxServe;if(!s)return null;const observedAt=new Date(now()).toISOString();
  const service={id:'mlx-serve',name:s.name,description:s.description,engine:s.engine,url:s.url,version:'',status:'unreachable',observedAt,memory:{maxBytes:s.residentCapBytes},stats:{},pool:null,models:[]};
  let data;try{data=await get(`${s.base}/v1/models`);}catch{return service;}
  service.status='reachable';const packs=Array.isArray(data.data)?data.data:[];
  service.memory={usedBytes:packs.reduce((n,m)=>n+(m.bytes_resident||0),0),maxBytes:s.residentCapBytes,pressure:null};
  service.models=packs.filter(m=>typeof m?.id==='string').map(m=>({id:m.id,name:m.id.split('/').pop(),description:'',aliases:[],state:m.loaded||m.state==='loaded'?'loaded':m.state==='loading'?'loading':'unloaded',engineType:m.meta?.architecture||'',contextLength:null,sizeBytes:m.bytes_on_disk??null,residentBytes:m.bytes_resident||null,capacityGb:null,ttlSeconds:null,ttlRemainingSeconds:null,lastRequestAt:null,capabilities:Array.isArray(m.capabilities)?m.capabilities:[]}));
  return service;
 }
 let jobsVersion=null;
 async function processTable(){if(!profile.jobs&&!profile.pids)return null;try{return parsePs(await processes());}catch{return null;}}
 async function collectJobs(table){
  const j=profile.jobs;if(!j||!table)return null;
  jobsVersion??=await version(j.toolDir).catch(()=>'');
  return jobsService(j,jobsFrom(table,now()),{observedAt:new Date(now()).toISOString(),version:jobsVersion?`mflux ${jobsVersion}`:''});
 }
 async function pollMetrics(){
  const ls=profile.llamaSwap;if(!ls)return;let raw;try{raw=ls.flavor==='v268'?(await get(`${ls.base}/api/metrics/activity`)).data:await get(`${ls.base}/api/metrics`);}catch{return;}
  if(!Array.isArray(raw))return;
  const fresh=raw.map(m=>({m,ts:Date.parse(m?.timestamp)})).filter(({m,ts})=>Number.isFinite(ts)&&typeof m.model==='string'&&ts>=state.lastMetricAt-3600000&&!seen.has(`${ts}:${m.id}`)).sort((a,b)=>a.ts-b.ts||a.m.id-b.m.id);
  for(const {m,ts} of fresh){
   const t=ls.flavor==='v268'?(m.tokens||{}):m,record={kind:'request',serviceId:'llama-swap',metricId:m.id,at:new Date(ts).toISOString(),model:m.model,path:ls.flavor==='v268'?classifyPath(m.req_path):'other',status:ls.flavor==='v268'?m.resp_status_code:null,inputTokens:t.input_tokens,outputTokens:t.output_tokens,cacheTokens:t.cache_tokens,promptTps:t.prompt_per_second,generationTps:t.tokens_per_second,durationMs:m.duration_ms};
   const line=correlate(record,state.lines);record.uaFamily=line?line.uaFamily:'';enqueue(record);
   seen.add(`${ts}:${m.id}`);if(ts>state.lastMetricAt)state.lastMetricAt=ts;
   const end=ts+(m.duration_ms||0);state.lastRequest.set(m.model,Math.max(state.lastRequest.get(m.model)||0,end));state.lastActivity.set(m.model,Math.max(state.lastActivity.get(m.model)||0,end));
  }
  if(seen.size>4000)for(const key of [...seen].slice(0,seen.size-2000))seen.delete(key);
  const cutoff=now()-900000;state.lines=state.lines.filter(l=>!l.used&&l.arrivedAt>=cutoff).slice(-2000);
 }
 function recordEvents(services){
  for(const service of services){if(!service||!['llama-swap','mlx-serve'].includes(service.id))continue;
   for(const model of service.models){const key=`${service.id}:${model.id}`,before=state.previous.get(key);
    if(before!==model.state&&(model.state==='loaded'||(before==='loaded'&&model.state==='unloaded')))enqueue({kind:'event',serviceId:service.id,at:new Date(now()).toISOString(),model:model.id,state:model.state});
    if(model.state==='loaded'&&before!=='loaded')state.lastActivity.set(model.id,Math.max(state.lastActivity.get(model.id)||0,now()));
    state.previous.set(key,model.state);}}
 }
 async function build(){
  if(building)return building;
  building=(async()=>{
   await loadConfig();await pollMetrics();
   const table=await processTable();
   const [device,llama,omlx,mlx,jobs]=await Promise.all([facts(),collectLlamaSwap(),collectOmlx(),collectMlxServe(),collectJobs(table)]);
   const services=[llama,omlx,mlx,jobs].filter(Boolean);recordEvents(services);
   if(table&&profile.pids){const pids=runtimePids(profile.pids,table);for(const s of services)if(pids[s.id])s.pids=pids[s.id];}
   let memory=device.memory;
   if(profile.llamaSwap?.flavor==='v268')try{const p=parsePrometheus(await readBody(`${profile.llamaSwap.base}/metrics`,{fetcher}));if(p.get('llamaswap_memory_total_bytes')>0)memory={usedBytes:p.get('llamaswap_memory_used_bytes'),freeBytes:p.get('llamaswap_memory_free_bytes'),totalBytes:p.get('llamaswap_memory_total_bytes')};}catch{}
   let gpu='';if(profile.llamaSwap?.flavor==='v268')try{const h=await get(`${profile.llamaSwap.base}/api/hardware`);gpu=h.accelerators?.[0]?.model||'';}catch{}
   state.snapshot={hostId,collectedAt:new Date(now()).toISOString(),hardware:{cpu:device.cpu,memoryBytes:os.totalmem(),gpu},os:device.os,uptimeSeconds:device.uptimeSeconds,memory,power:device.power,actions:profile.actions,services};
   state.builtAt=now();await save();return state.snapshot;
  })().finally(()=>{building=null;});
  return building;
 }
 async function snapshot(){if(!state.snapshot||now()-state.builtAt>15000)await build();return state.snapshot;}
 function records(after){
  const a=Number.isSafeInteger(after)&&after>=0?after:0;
  if(a>state.seq)return {items:[],cursor:state.seq,more:false};
  state.queue=state.queue.filter(i=>i.seq>a);const items=state.queue.slice(0,500);
  return {items,cursor:items.length?items[items.length-1].seq:state.seq,more:state.queue.length>items.length};
 }
 async function action(input){
  const value=computeAction({...(input&&typeof input==='object'?input:{}),host:hostId}),fingerprint=JSON.stringify(value),found=requests.get(value.requestId);
  if(found){if(found.fingerprint!==fingerprint)throw new Error('invalid');return found.promise;}
  if(busy)throw new Error('busy');busy=true;
  const promise=(async()=>{
   let outcome='failed';
   try{
    if(!profile.actions.includes(value.action))throw new Error('invalid');
    const ls=profile.llamaSwap,known=new Set((state.snapshot?.services||[]).find(s=>s.id==='llama-swap')?.models.flatMap(m=>[m.id,...m.aliases])||[]);
    if(value.model&&!known.has(value.model))throw new Error('not-found');
    if(value.action==='unload-all')await readBody(`${ls.base}/unload`,{timeout:30000,fetcher});
    else if(value.action==='unload-model'){if(ls.flavor!=='v268')throw new Error('invalid');await readBody(`${ls.base}/api/models/unload/${encodeURIComponent(value.model)}`,{method:'POST',timeout:30000,fetcher});}
    else if(value.action==='warm'){state.warming.set(value.model,now());state.lastActivity.set(value.model,now());readBody(`${ls.base}/upstream/${encodeURIComponent(value.model)}/health`,{timeout:900000,fetcher}).catch(()=>{});await new Promise(r=>setTimeout(r,1500));}
    else if(value.action==='unload-audio'){const packs=(state.snapshot?.services||[]).find(s=>s.id==='mlx-serve')?.models.filter(m=>m.state==='loaded')||[];for(const pack of packs)await readBody(`${profile.mlxServe.base}/v1/unload-model`,{method:'POST',timeout:30000,fetcher,headers:{'Content-Type':'application/json'},body:JSON.stringify({model:pack.id})});}
    outcome='accepted';state.builtAt=0;return {ok:true,snapshot:await snapshot()};
   }finally{
    try{await mkdir(stateDirectory,{recursive:true,mode:0o700});await appendFile(path.join(stateDirectory,'compute-actions.jsonl'),JSON.stringify({...value,at:new Date(now()).toISOString(),outcome})+'\n',{mode:0o600});}catch{}
   }
  })();
  requests.set(value.requestId,{fingerprint,promise});if(requests.size>128)requests.delete(requests.keys().next().value);
  try{return await promise;}finally{busy=false;}
 }
 async function start(){
  await load();
  if(profile.llamaSwap)stopWatch=watch({base:profile.llamaSwap.base,flavor:profile.llamaSwap.flavor,onLine:line=>{const parsed=parseAccessLine(line,now());if(parsed){state.lines.push(parsed);if(state.lines.length>2000)state.lines.shift();}}});
  await build().catch(()=>{});timer=setInterval(()=>build().catch(()=>{}),60000);timer.unref?.();
 }
 function stop(){clearInterval(timer);stopWatch?.();}
 return {snapshot,records,action,start,stop,build,state};
}
