
export const SERVICE_IDS=Object.freeze(['llama-swap','omlx','mlx-serve','mflux']);
export const COMPUTE_ACTIONS=Object.freeze(['unload-all','unload-model','warm','unload-audio']);
const DEVICE=/^[a-z][a-z0-9_-]{1,31}$/,CONTROL=/^[a-z][a-z0-9-]{0,31}$/,LABEL=/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/,ALIAS=/^[A-Za-z0-9._:-]{1,120}$/;
const LOOPBACK=/^http:\/\/127\.0\.0\.1:\d{2,5}$/,LOOPBACK_URL=/^http:\/\/127\.0\.0\.1:\d{2,5}(\/[A-Za-z0-9._/-]*)?$/;
const PATTERN_LIMIT=200;
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const fail=message=>{throw new Error(`site config: plugins.macos-runtimes.${message}`);};
const keys=(v,allowed,where)=>{if(!plain(v))fail(`${where} must be an object`);const extra=Object.keys(v).filter(k=>!allowed.includes(k));if(extra.length)fail(`${where} has unknown field(s): ${extra.join(', ')}`);return v;};
const text=(v,max,where,{empty=false}={})=>{if(typeof v!=='string'||v.length>max||/[\u0000-\u001f\u007f]/.test(v)||(!empty&&!v.trim()))fail(`${where} must be a text of ${empty?0:1} to ${max} characters`);return v;};
const count=(v,where)=>{if(!Number.isSafeInteger(v)||v<0)fail(`${where} must be a whole number of 0 or more`);return v;};
const oneOfList=(v,allowed,where)=>{if(!Array.isArray(v)||v.some(x=>!allowed.includes(x))||new Set(v).size!==v.length)fail(`${where} must be a list of ${allowed.join(', ')}`);return Object.freeze([...v]);};
const base=(v,where)=>{if(typeof v!=='string'||(!LOOPBACK.test(v)||Number(v.split(':').at(-1))>65535))fail(`${where} must be a loopback origin such as http://127.0.0.1:8000`);return v;};
const pageUrl=(v,where)=>{if(typeof v!=='string'||!LOOPBACK_URL.test(v))fail(`${where} must be a loopback address such as http://127.0.0.1:8000/`);return v;};

const KINDS={
 llamaSwap:{name:'llama-swap',engine:'llama.cpp server (GGUF)',fields:['base','name','engine','url','description','flavor','configPath']},
 omlx:{name:'oMLX',engine:'MLX (mlx-lm, mlx-vlm)',fields:['base','admin','name','engine','url','description','models']},
 mlxServe:{name:'mlx-serve',engine:'MLX-Serve (native)',fields:['base','name','engine','url','residentCapBytes','description']},
};
function runtime(raw,kind,where){
 const spec=KINDS[kind];keys(raw,spec.fields,where);
 const out={};
 for(const field of spec.fields){
  if(raw[field]===undefined)continue;
  const at=`${where}.${field}`,v=raw[field];
  if(field==='base')out.base=base(v,at);
  else if(field==='url')out.url=pageUrl(v,at);
  else if(field==='admin'){if(typeof v!=='boolean')fail(`${at} must be true or false`);out.admin=v;}
  else if(field==='flavor'){if(v!=='v268')fail(`${at} must be "v268" or left out`);out.flavor=v;}
  else if(field==='configPath'){if(typeof v!=='string'||!/^\/[A-Za-z0-9 ._/@+-]{1,299}$/.test(v)||v.split('/').includes('..'))fail(`${at} must be an absolute file path`);out.configPath=v;}
  else if(field==='residentCapBytes')out.residentCapBytes=count(v,at);
  else if(field==='models'){
   if(!plain(v)||Object.keys(v).length>50)fail(`${at} must be an object of at most 50 models`);
   out.models={};for(const [alias,m] of Object.entries(v)){if(!ALIAS.test(alias))fail(`${at} names "${alias}", which is not a model alias`);keys(m,['description','ttlSeconds'],`${at}.${alias}`);
    out.models[alias]={...(m.description!==undefined?{description:text(m.description,300,`${at}.${alias}.description`)}:{}),...(m.ttlSeconds!==undefined?{ttlSeconds:count(m.ttlSeconds,`${at}.${alias}.ttlSeconds`)}:{})};}
  }
  else out[field]=text(v,field==='description'?300:120,at);
 }
 if(!out.base)fail(`${where}.base is required`);
 if(kind==='llamaSwap'&&!out.configPath)fail(`${where}.configPath is required: the llama-swap configuration file the bridge reads`);
 return {name:out.name??spec.name,engine:out.engine??spec.engine,...out};
}
function agent(raw,where){
 keys(raw,['llamaSwap','omlx','mlxServe','jobs','pids','actions'],where);
 const out={};
 for(const kind of Object.keys(KINDS))out[kind]=raw[kind]===undefined||raw[kind]===null?null:runtime(raw[kind],kind,`${where}.${kind}`);
 if(raw.jobs!==undefined&&raw.jobs!==null){keys(raw.jobs,['name','engine','description','toolDir'],`${where}.jobs`);
  if(typeof raw.jobs.toolDir!=='string'||!/^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/.test(raw.jobs.toolDir)||raw.jobs.toolDir.split('/').includes('..'))fail(`${where}.jobs.toolDir must be a directory under the home directory, such as .local/share/uv/tools/mflux`);
  out.jobs={name:raw.jobs.name===undefined?'mflux':text(raw.jobs.name,60,`${where}.jobs.name`),engine:raw.jobs.engine===undefined?'MLX · CLI':text(raw.jobs.engine,120,`${where}.jobs.engine`),
   description:raw.jobs.description===undefined?'':text(raw.jobs.description,300,`${where}.jobs.description`),toolDir:raw.jobs.toolDir};}
 // A runtime's processes, by a pattern on the command line: a string here, compiled by the bridge (patternsOf).
 if(raw.pids!==undefined){if(!plain(raw.pids))fail(`${where}.pids must be an object: {"<service id>": "<pattern>"}`);
  out.pids={};for(const [id,source] of Object.entries(raw.pids)){if(!SERVICE_IDS.includes(id))fail(`${where}.pids names "${id}", which is not a runtime (${SERVICE_IDS.join(', ')})`);
   if(typeof source!=='string'||!source||source.length>PATTERN_LIMIT)fail(`${where}.pids.${id} must be a pattern of 1 to ${PATTERN_LIMIT} characters`);
   try{new RegExp(source);}catch{fail(`${where}.pids.${id} is not a valid pattern`);}
   out.pids[id]=source;}}
 out.actions=raw.actions===undefined?[]:oneOfList(raw.actions,COMPUTE_ACTIONS,`${where}.actions`);
 if(out.actions.some(a=>a!=='unload-audio')&&!out.llamaSwap)fail(`${where}.actions requires llamaSwap`);
 if(out.actions.includes('unload-audio')&&!out.mlxServe)fail(`${where}.actions requires mlxServe`);
 return out;
}
function host(id,raw,device,where,bridgeDevices){
 keys(raw,['name','role','hardware','bridge','os','runtimes','actions','agent'],where);
 if(!device)fail(`hosts names "${id}", which is not a device of this site (devices[])`);
 const bridge=raw.bridge===undefined?true:raw.bridge;if(typeof bridge!=='boolean')fail(`${where}.bridge must be true or false`);
 if(bridge&&!bridgeDevices.includes(id))fail(`${where}: only ${bridgeDevices.join(', ')||'the devices in bridges'} have a bridge; set "bridge": false for another device`);
 let hardware={cpu:device.hardware?.cpu||'',memoryBytes:Number.isFinite(device.hardware?.ramGb)?Math.round(device.hardware.ramGb*1024**3):null,gpu:device.hardware?.gpu||''};
 if(raw.hardware!==undefined){keys(raw.hardware,['cpu','memoryBytes','gpu'],`${where}.hardware`);
  hardware={cpu:raw.hardware.cpu===undefined?hardware.cpu:text(raw.hardware.cpu,80,`${where}.hardware.cpu`),memoryBytes:raw.hardware.memoryBytes===undefined?hardware.memoryBytes:count(raw.hardware.memoryBytes,`${where}.hardware.memoryBytes`),
   gpu:raw.hardware.gpu===undefined?hardware.gpu:text(raw.hardware.gpu,80,`${where}.hardware.gpu`)};}
 let os=null;if(raw.os!==undefined){keys(raw.os,['name','version'],`${where}.os`);os={name:text(raw.os.name,40,`${where}.os.name`),version:text(raw.os.version,40,`${where}.os.version`,{empty:true})};}
 return {id,name:raw.name===undefined?device.name:text(raw.name,80,`${where}.name`),ip:device.ip||'',role:raw.role===undefined?'':text(raw.role,80,`${where}.role`,{empty:true}),picture:device.picture??null,hardware,bridge,os,
  runtimes:raw.runtimes===undefined?null:oneOfList(raw.runtimes,SERVICE_IDS,`${where}.runtimes`),actions:raw.actions===undefined?null:oneOfList(raw.actions,COMPUTE_ACTIONS,`${where}.actions`),
  agent:raw.agent===undefined?null:agent(raw.agent,`${where}.agent`)};
}
function control(raw,where){
 keys(raw,['id','name','label','impact'],where);
 if(typeof raw.id!=='string'||!CONTROL.test(raw.id))fail(`${where}.id must match ${CONTROL}`);
 if(typeof raw.label!=='string'||!LABEL.test(raw.label))fail(`${where}.label must be a launchd label`);
 return {id:raw.id,name:text(raw.name,80,`${where}.name`),label:raw.label,impact:text(raw.impact,300,`${where}.impact`)};
}
const IPV4=/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
function page(raw,byId,where){
 keys(raw,['knownAddresses','links'],where);
 const addresses=raw.knownAddresses??[];
 if(!Array.isArray(addresses)||addresses.length>32||addresses.some(a=>typeof a!=='string'||!IPV4.test(a)))fail(`${where}.knownAddresses must be a list of at most 32 IPv4 addresses`);
 const links={};
 for(const [id,list] of Object.entries(raw.links===undefined?{}:keys(raw.links,Object.keys(raw.links),`${where}.links`))){
  if(!byId.has(id))fail(`${where}.links names "${id}", which is not a device of this site (devices[])`);
  if(!Array.isArray(list)||list.length>8)fail(`${where}.links.${id} must be a list of at most 8 links`);
  links[id]=list.map((l,i)=>{const at=`${where}.links.${id}[${i}]`;keys(l,['label','url'],at);let u;try{u=new URL(l.url);}catch{fail(`${at}.url must be an http(s) address`);}
   if(!['http:','https:'].includes(u.protocol)||u.username||u.password||l.url.length>300)fail(`${at}.url must be an http(s) address without a user or password`);
   return {label:text(l.label,60,`${at}.label`),url:l.url};});
 }
 return {knownAddresses:[...addresses],links};
}
const deepFreeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.freeze(v);for(const x of Object.values(v))deepFreeze(x);}return v;};
/** site.json → plugins.macos-runtimes, checked → frozen {hosts:[…] in the file's order, controls:{<device>:[…]}, page:{knownAddresses, links}}. devices: the site's devices[]. */
export function readComputeConfig(raw,{devices=[]}={}){
 if(raw===undefined)return null;
 keys(raw,['$comment','hosts','controls','page','sockets','agents'],'(the section)');
 const r=raw??{},byId=new Map(devices.map(m=>[m.id,m]));
 // The devices with a bridge: the ones bridges names, in slot order (memory, studio, miniServer).
 if(r.agents!==undefined){
  keys(r.agents,['bridge'],'agents');
  const entries=r.agents.bridge??{};keys(entries,Object.keys(entries),'agents.bridge');
  for(const [id,v] of Object.entries(entries)){
   if(!byId.has(id))fail(`agents.bridge.${id} must name a device`);
   keys(v,['target','label','node','env','logs'],`agents.bridge.${id}`);
   for(const field of ['target','node','logs'])if(v[field]!==undefined&&(typeof v[field]!=='string'||!v[field]||/[\x00-\x1f]/.test(v[field])))fail(`agents.bridge.${id}.${field} must be a path`);
   if(v.label!==undefined&&!LABEL.test(v.label))fail(`agents.bridge.${id}.label must be a launchd label`);
   if(v.env!==undefined){keys(v.env,Object.keys(v.env),`agents.bridge.${id}.env`);for(const [k,x] of Object.entries(v.env))if(!/^[A-Z_][A-Z0-9_]*$/.test(k)||typeof x!=='string'||/[\x00-\x1f]/.test(x))fail(`agents.bridge.${id}.env.${k} must be text`);}
  }
 }
 const sockets=r.sockets??{};keys(sockets,Object.keys(sockets),'sockets');
 for(const [id,socket] of Object.entries(sockets)){
  if(!byId.has(id))fail(`sockets.${id} must name a device`);
  if(typeof socket!=='string'||!socket.startsWith('/')||socket.length>100||/[\x00-\x1f]/.test(socket)||socket.split('/').includes('..'))fail(`sockets.${id} must be an absolute Unix socket path`);
 }
 const bridgeDevices=Object.keys(sockets),bridges={};

 const hosts=Object.entries(r.hosts===undefined?{}:keys(r.hosts,Object.keys(r.hosts),'hosts')).map(([id,h])=>{if(!DEVICE.test(id))fail(`hosts names "${id}", which is not a device id`);return host(id,h,byId.get(id),`hosts.${id}`,bridgeDevices);});
 for(const id of bridgeDevices)if(!hosts.some(h=>h.id===id))fail(`sockets.${id} needs hosts.${id}`);
 const controls={};
 for(const [id,list] of Object.entries(r.controls===undefined?{}:keys(r.controls,Object.keys(r.controls),'controls'))){
  if(!bridgeDevices.includes(id))fail(`controls names "${id}"; only ${bridgeDevices.join(', ')||'the devices in bridges'} have a bridge`);
  if(!Array.isArray(list)||list.length>40)fail(`controls.${id} must be a list of at most 40 services`);
  controls[id]=list.map((c,i)=>control(c,`controls.${id}[${i}]`));
  if(new Set(controls[id].map(c=>c.id)).size!==controls[id].length)fail(`controls.${id} lists an id twice`);
 }
 return deepFreeze({sockets:{...sockets},hosts,controls,page:page(r.page??{},byId,'page'),bridges:{...bridges},bridgeDevices});
}
export const hostDefinition=h=>({id:h.id,name:h.name,ip:h.ip,role:h.role,picture:h.picture,hardware:{...h.hardware},...(h.runtimes?{runtimes:[...h.runtimes]}:{}),...(h.actions?{actions:[...h.actions]}:{})});
export function compiledProfile(profile){
 if(!profile)return null;
 const out=structuredClone(profile);
 if(profile.pids)out.pids=Object.fromEntries(Object.entries(profile.pids).map(([id,source])=>[id,new RegExp(source)]));
 return out;
}
export function computeAgentConfig(config,device){
 const h=config.hosts.find(x=>x.id===device);
 return {hostId:device,profile:h?.agent?structuredClone(h.agent):null,controls:(config.controls[device]||[]).map(c=>({...c}))};
}
export function readComputeAgentConfig(raw){
 keys(raw,['hostId','profile','controls'],'(agent configuration)');
 if(typeof raw.hostId!=='string'||!DEVICE.test(raw.hostId))fail('(agent configuration).hostId must be a device id');
 if(!Array.isArray(raw.controls)||raw.controls.length>40)fail('(agent configuration).controls must be a list of at most 40 services');
 const controls=raw.controls.map((c,i)=>control(c,`(agent configuration).controls[${i}]`));
 return deepFreeze({hostId:raw.hostId,profile:raw.profile===null?null:compiledProfile(agent(raw.profile,'(agent configuration).profile')),controls});
}
