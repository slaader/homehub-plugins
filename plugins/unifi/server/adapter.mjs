// The router adapter "unifi-api": the hub asks the UniFi gateway itself, read-only, with an API key.
//
//   read()      the last observation at once (null before the first pull), and a pull in the background when the last
//               attempt is older than intervalSeconds. Never throws, never waits for the router.
//   refresh()   one pull (one at a time; a second caller gets the same promise). A failure keeps the last good census,
//               marked by its observedAt, with status "unavailable" and a short error code.
//   pollers     the plugin's poller calls refresh() every intervalSeconds while the integration is on (index.mjs).
//
// GET requests only (SPEC: collectors are read-only), to the integration API under /proxy/network/integration/v1:
//   /info, /sites, /sites/{id}/clients, /sites/{id}/devices; lists are paged with offset and limit.
// The API key comes from the Integrations page's write-only field, else from keyFile in the private directory (0600,
// owned by the hub's user). It is sent only on a socket whose certificate passed (server/client.mjs), and it never
// appears in an observation, a status, a log line or an error.
import {readFileSync,openSync,closeSync,fstatSync,readSync,realpathSync,constants} from 'node:fs';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {getJson,UnifiError} from './client.mjs';
import {parseCensus,networksFor,rows,pick,lanMac,MAX_CLIENTS,MAX_HARDWARE} from './census.mjs';

export const ADAPTER_ID='unifi-api';
export const INTEGRATION_ID='unifi.api';
export const BASE='/proxy/network/integration/v1';
export const PAGE=200;
const SITE_ID=/^[A-Za-z0-9_-]{1,64}$/;
const KEY=/^[A-Za-z0-9._~+/=-]{1,512}$/;
const STORE_FILE='observation.json',STORE_SCHEMA=1;

/** The API key: the Integrations page's field, else the key file. → {key, from} or throws a UnifiError. */
export function loadKey({secret,keyFile,privateDirectory,uid=process.getuid?.()}){
 if(typeof secret==='string'&&secret.trim()){const key=secret.trim();if(!KEY.test(key))throw new UnifiError('key-invalid');return {key,from:'ui'};}
 if(!keyFile)throw new UnifiError('key-missing');
 const file=path.resolve(privateDirectory,keyFile);
 if(!file.startsWith(path.resolve(privateDirectory)+path.sep))throw new UnifiError('key-missing');
 let fd;
 try{
  const root=realpathSync(privateDirectory),parent=realpathSync(path.dirname(file));
  if(parent!==root&&!parent.startsWith(root+path.sep))throw new UnifiError('key-permissions');
  // Never follow a leaf symlink or block opening a FIFO. Check the opened inode before reading it.
  fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const info=fstatSync(fd);
  if(!info.isFile()||(info.mode&0o077)||(uid!==undefined&&info.uid!==uid))throw new UnifiError('key-permissions');
  if(info.size>1024)throw new UnifiError('key-invalid');
  const bytes=Buffer.alloc(1025),size=readSync(fd,bytes,0,bytes.length,0);
  if(size>1024)throw new UnifiError('key-invalid');
  const key=bytes.subarray(0,size).toString('utf8').trim();
  if(!KEY.test(key))throw new UnifiError('key-invalid');
  return {key,from:'file'};
 }catch(e){throw e instanceof UnifiError?e:new UnifiError(e.code==='ELOOP'?'key-permissions':'key-missing');}
 finally{if(fd!==undefined)closeSync(fd);}
}

// Every page of a list, up to max items: offset/limit until a short page, the total, or the page budget.
export async function fetchAll(get,listPath,max){
 const items=[];let offset=0;
 for(let page=0;page<Math.ceil(max/PAGE);page++){
  const r=rows(await get(`${listPath}?offset=${offset}&limit=${PAGE}`));if(!r)throw new UnifiError('invalid-response');
  items.push(...r.items.filter(x=>x&&typeof x==='object'&&!Array.isArray(x)));offset+=r.items.length;
  if(!r.items.length||r.items.length<PAGE||offset>=r.total)break;
 }
 return items.slice(0,max);
}

// The UniFi site: the one whose internalReference, name or id is `wanted`, else (none configured) the first one listed.
export function chooseSite(sites,wanted){
 const valid=sites.filter(s=>SITE_ID.test(pick(s,['id'],64)));
 const site=wanted?valid.find(s=>[pick(s,['internalReference'],64),pick(s,['name'],64),pick(s,['id'],64)].includes(wanted)):valid[0];
 if(!site)throw new UnifiError('no-site');
 return site;
}

/** One pull: → the census part of an ok observation. Throws a UnifiError. */
export async function observe({config,key,networks,now,previousKnown,sockets,arpPath,active=()=>true}){
 const get=p=>{
  if(!active())throw new UnifiError('integration-off');
  return getJson(p,{host:config.host,port:config.port,fingerprint:config.fingerprint,key,timeoutMs:config.timeoutSeconds*1000,sockets});
 };
 const sites=await fetchAll(get,`${BASE}/sites`,PAGE);
 const site=chooseSite(sites,config.site),siteId=encodeURIComponent(pick(site,['id'],64));
 const clients=await fetchAll(get,`${BASE}/sites/${siteId}/clients`,MAX_CLIENTS);
 const gear=await fetchAll(get,`${BASE}/sites/${siteId}/devices`,MAX_HARDWARE);
 let version='';try{version=pick(await get(`${BASE}/info`),['applicationVersion'],40);}catch{}
 const census=parseCensus(clients,gear,{now,previousKnown,host:config.host,networks});
 const routerMac=lanMac(config.host,arpPath)||census.routerMac;
 return {...census,routerBaseMac:census.routerMac,routerMac,site:pick(site,['name','internalReference'])||pick(site,['id'],64),
  softwareVersion:version,applicationVersion:version,backend:'integration-api',source:'UniFi Network API'};
}

const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
// The last observation, kept in the plugin's data directory so a restart starts from it.
function loadStored(file){
 try{const raw=JSON.parse(readFileSync(file,'utf8'));
  if(raw?.schemaVersion!==STORE_SCHEMA||!plain(raw.observation)||typeof raw.observation.status!=='string')return null;
  return raw.observation;}catch{return null;}
}
async function store(file,observation){
 await mkdir(path.dirname(file),{recursive:true,mode:0o700});
 const tmp=`${file}.${process.pid}.tmp`;
 await writeFile(tmp,JSON.stringify({schemaVersion:STORE_SCHEMA,observation})+'\n',{mode:0o600});await rename(tmp,file);
}

/**
 * The adapter's state. options: config (readUnifiConfig), dataDirectory (hub.pluginData), privateDirectory, site (lanCidrs),
 * secret() → the Integrations page's key or null, enabled() → is the integration on, now() (clock), arpPath, log.
 */
export function createUnifiAdapter({config,dataDirectory,privateDirectory,site,secret=()=>null,enabled=()=>true,now=()=>Date.now(),arpPath,log=()=>{}}){
 const file=dataDirectory?path.join(dataDirectory,STORE_FILE):null;
 const networks=networksFor(site?.lanCidrs,config.host);
 const sockets=new Set();
 let observation=file?loadStored(file):null,inflight=null,lastAttemptAt=observation?Date.parse(observation.attemptedAt)||0:0,stopped=false;
 let keyFrom=null,generation=0;

 async function pull(){
  const run=generation,active=()=>run===generation&&!stopped&&enabled();
  const at=new Date(now()).toISOString();lastAttemptAt=now();
  const previous=observation||{};
  let next;
  try{
   const {key,from}=loadKey({secret:secret(),keyFile:config.keyFile,privateDirectory});keyFrom=from;
   const census=await observe({config,key,networks,now:at,previousKnown:plain(previous.knownClients)?previous.knownClients:{},sockets,arpPath,active});
   next={schemaVersion:2,status:'ok',observedAt:at,attemptedAt:at,error:null,...census};
  }catch(e){
   const code=e instanceof UnifiError?e.code:'internal-error';
   if(!(e instanceof UnifiError))log(`unifi: internal error during a pull (${e?.name||'Error'})`);
   // The last good census stays, marked by its own observedAt.
   next={...previous,schemaVersion:2,status:'unavailable',error:code,attemptedAt:at,observedAt:previous.observedAt||null,clients:Array.isArray(previous.clients)?previous.clients:[]};
  }
  // Disabling a feed abandons this pull, including any successful response received just before cancellation.
  // Keep the last accepted observation and never publish a partly completed pull after the switch is off.
  if(!active())return observation??{status:'unavailable',error:'integration-off'};
  observation=next;
  if(file&&!stopped)await store(file,next).catch(()=>log('unifi: the observation could not be stored'));
  return next;
 }
 const refresh=({force=false}={})=>{
  if(inflight)return inflight;
  if(stopped||!enabled())return Promise.resolve(observation);
  if(!force&&now()-lastAttemptAt<config.intervalSeconds*1000)return Promise.resolve(observation);
  inflight=pull().catch(()=>observation).finally(()=>{inflight=null;});
  return inflight;
 };
 const adapter=Object.freeze({id:ADAPTER_ID,title:'UniFi Network API',staleAfterSeconds:config.staleAfterSeconds,
  // Core's read: what is known now. Turned off, nothing is asked and the last census is marked so.
  async read(){
   if(!enabled())return observation?{...observation,status:'unavailable',error:'integration-off'}:null;
   refresh();
   return observation;
  }});
 const cancel=async()=>{generation++;for(const s of sockets)s.destroy();await inflight?.catch(()=>{});};
 return {adapter,refresh,cancel,
  status:()=>({observation,inflight:Boolean(inflight),lastAttemptAt:lastAttemptAt||null,keyFrom}),
  // Abandon a pull in flight (its sockets close; it ends as 'unreachable') and write nothing more.
  async stop(){stopped=true;await cancel();},
  resume(){stopped=false;}};
}
