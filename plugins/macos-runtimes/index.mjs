import {tx} from 'home-hub/plugin-api';
import {readComputeConfig} from './server/config.mjs';
import {createComputeStore,computeAction,hostControlAction,runtimesFromLatest,normalizeSnapshot,hostControlState,freshness} from './server/compute-data.mjs';
import {createComputePoller} from './server/compute-poller.mjs';
import {enrichRuntimes,requestsReader} from './server/compute-models.mjs';
import {bridgeClient} from './server/transport.mjs';
const ID='macos-runtimes',INTEGRATION=ID+'.bridges';
const active=c=>c.state.config&&c.hub.integrationEnabled(INTEGRATION);
const error=e=>[({invalid:400,'not-found':404,busy:429})[e.message]||503,'MACOS_RUNTIME_UNAVAILABLE','Most runtimu není dostupný nebo je požadavek neplatný.'];
export function runtimeStatus(s,h,{enabled=true}={}){
 const configuredBy=s.config?[{source:'site.json',name:'plugins.macos-runtimes'}]:[];
 if(!s.config||!s.config.bridgeDevices.length)return {state:'not-configured',summary:'Nejsou nastavené mosty macOS runtimů.',configuredBy};
 if(!enabled)return {state:'disabled',summary:'',configuredBy};
 const latest=s.poller.latest(),items=s.config.bridgeDevices.map(id=>{
  const entry=latest[id],state=entry?.bridge==='connected'?(freshness(entry.snapshot?.collectedAt)==='fresh'?'ok':'stale'):entry?.bridge==='unavailable'?'error':'stale';
  return {id,label:s.config.hosts.find(x=>x.id===id)?.name||id,state,summary:state==='ok'?'Most odpovídá.':state==='error'?'Most není dostupný.':'Čeká se na aktuální data.',lastSuccessAt:entry?.snapshot?.collectedAt};
 });
 const connected=items.filter(x=>x.state==='ok').length;
 return {state:items.some(x=>x.state==='error')?'error':connected===items.length?'ok':'stale',summary:tx('Připojeno {connected} z {total} mostů.',{connected,total:items.length}),configuredBy,items};
}
export default {
 id:ID,title:'macOS runtimes',
 scopes:{'macos-runtimes:control':{label:'Ovládání macOS runtimů',desc:'Měnit modely a nastavené služby launchd.'}},
 setup(hub){
  const config=readComputeConfig(hub.site.plugins?.[ID],hub.site);
  if(!config)return {config:null};
  const clients=Object.fromEntries(Object.entries(config.sockets).map(([id,socket])=>[id,hub.options.macosRuntimes?.[id]??bridgeClient(socket)]));
  const store=createComputeStore(hub.pluginData(ID),{hosts:config.hosts});
  const poller=createComputePoller({bridges:clients,store,hosts:config.hosts,devices:config.bridgeDevices,enabled:()=>hub.integrationEnabled(INTEGRATION)});
  return {config,clients,store,poller};
 },
 pollers:[{id:'bridges',start:s=>s.poller?.start(),stop:s=>s.poller?.stop()}],
 integrations:[{id:INTEGRATION,title:'Mosty macOS runtimů',kind:'bridge',description:'Čte místní runtimy a historii požadavků přes nastavené unixové sockety.',howTo:'Nastav plugins.macos-runtimes a nainstaluj most na každé zařízení.',
  devices:s=>s.config?.bridgeDevices.map(device=>({device,item:device}))??[],
  status:runtimeStatus,
  test:async(s,h)=>{await s.poller?.poll();return runtimeStatus(s,h);}}],
 provides:{
  'home.runtimes':(s,h)=>s.config&&h.integrationEnabled(INTEGRATION)?enrichRuntimes(runtimesFromLatest(s.poller.latest(),Date.now(),s.config.bridgeDevices),s.poller.latest()):{},
  'runtimes.requests':(s,h)=>s.config&&h.integrationEnabled(INTEGRATION)?requestsReader(s.store,s.config.bridgeDevices):[],
 },
 strings:{en:{
  'Ovládání macOS runtimů':'macOS runtime controls',
  'Měnit modely a nastavené služby launchd.':'Change models and configured launchd services.',
  'Mosty macOS runtimů':'macOS runtime bridges',
  'Čte místní runtimy a historii požadavků přes nastavené unixové sockety.':'Read configured Unix sockets for local runtimes and request history.',
  'Nastav plugins.macos-runtimes a nainstaluj most na každé zařízení.':'Configure plugins.macos-runtimes and install its bridge on each device.',
  'Most runtimu není dostupný nebo je požadavek neplatný.':'Runtime bridge unavailable or invalid request.',
  'Nejsou nastavené mosty macOS runtimů.':'No macOS runtime bridges are configured.',
  'Most odpovídá.':'The bridge is responding.',
  'Most není dostupný.':'The bridge is unavailable.',
  'Čeká se na aktuální data.':'Waiting for current data.',
  'Připojeno {connected} z {total} mostů.':'Connected to {connected} of {total} bridges.',
  'rozpočet paměti':'memory budget','paměť úloh':'job memory',
 }},
 routes:[
  {method:'GET',path:'/api/macos-runtimes',error,handler:c=>c.json(200,active(c)?{devices:c.state.config.hosts,snapshots:c.state.poller.latest()}:{devices:[],snapshots:{},disabled:c.hub.integrationDisabled(INTEGRATION)})},
  {method:'POST',path:'/api/macos-runtimes/action',scope:'macos-runtimes:control',error,async handler(c){
   if(!active(c))return c.json(409,{error:{code:'INTEGRATION_DISABLED'}});
   const action=computeAction(c.input,c.state.config.hosts);
   const result=await c.state.clients[action.host]('/compute/action','POST',action);await c.state.poller.poll();
   return c.json(200,{snapshot:normalizeSnapshot(result.snapshot,Date.now(),c.state.config.hosts.filter(h=>h.id===action.host))});
  }},
  {method:'POST',path:'/api/macos-runtimes/controls/action',scope:'macos-runtimes:control',error,async handler(c){
   if(!active(c))return c.json(409,{error:{code:'INTEGRATION_DISABLED'}});
   const {host,...action}=hostControlAction(c.input,c.state.config.controls,c.state.config.bridgeDevices);
   return c.json(200,hostControlState(await c.state.clients[host]('/controls/action','POST',action),host,c.state.config.controls));
  }},
  {method:'GET',path:'/api/macos-runtimes/controls',error,async handler(c){
   if(!active(c))return c.json(200,{devices:[],disabled:c.hub.integrationDisabled(INTEGRATION)});
   return c.json(200,{devices:await Promise.all(c.state.config.bridgeDevices.map(async device=>({device,...hostControlState(await c.state.clients[device]('/controls'),device,c.state.config.controls)})))});
  }},
 ],
};
