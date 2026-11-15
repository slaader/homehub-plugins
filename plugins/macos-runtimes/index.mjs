import {readComputeConfig} from './server/config.mjs';
import {createComputeStore,computeAction,hostControlAction,runtimesFromLatest,normalizeSnapshot} from './server/compute-data.mjs';
import {createComputePoller} from './server/compute-poller.mjs';
import {enrichRuntimes,requestsReader} from './server/compute-models.mjs';
import {bridgeClient} from './server/transport.mjs';
const ID='macos-runtimes',INTEGRATION=ID+'.bridges';
const active=c=>c.state.config&&c.hub.integrationEnabled(INTEGRATION);
const error=()=>[503,'MACOS_RUNTIME_UNAVAILABLE','Runtime bridge unavailable or invalid request.'];
export default {
 id:ID,title:'macOS runtimes',
 scopes:{'macos-runtimes:control':{label:'macOS runtime controls',desc:'Change models and configured launchd services.'}},
 setup(hub){
  const config=readComputeConfig(hub.site.plugins?.[ID],hub.site);
  if(!config)return {config:null};
  const clients=Object.fromEntries(Object.entries(config.sockets).map(([id,socket])=>[id,hub.options.macosRuntimes?.[id]??bridgeClient(socket)]));
  const store=createComputeStore(hub.pluginData(ID),{hosts:config.hosts});
  const poller=createComputePoller({bridges:clients,store,hosts:config.hosts,devices:config.bridgeDevices,enabled:()=>hub.integrationEnabled(INTEGRATION)});
  return {config,clients,store,poller};
 },
 pollers:[{id:'bridges',start:s=>s.poller?.start(),stop:s=>s.poller?.stop()}],
 integrations:[{id:INTEGRATION,title:'macOS runtime bridges',kind:'bridge',description:'Read configured Unix sockets for local runtimes and request history.',howTo:'Configure plugins.macos-runtimes and install its bridge on each device.',
  devices:s=>s.config?.bridgeDevices.map(device=>({device,item:device}))??[],
  status:(s,h,{enabled=true}={})=>({state:!s.config?'not-configured':!enabled?'disabled':Object.values(s.poller.latest()).some(e=>e.bridge==='connected')?'ok':'stale',summary:'macOS runtime bridges'}),
  test:async s=>{await s.poller?.poll();return {state:s.config?'ok':'not-configured',summary:'Bridge check completed.'};}}],
 provides:{
  'home.runtimes':(s,h)=>s.config&&h.integrationEnabled(INTEGRATION)?enrichRuntimes(runtimesFromLatest(s.poller.latest(),Date.now(),s.config.bridgeDevices),s.poller.latest()):{},
  'runtimes.requests':(s,h)=>s.config&&h.integrationEnabled(INTEGRATION)?requestsReader(s.store,s.config.bridgeDevices):[],
 },
 routes:[
  {method:'GET',path:'/api/macos-runtimes',error,handler:c=>c.json(200,active(c)?{devices:c.state.config.hosts,snapshots:c.state.poller.latest()}:{devices:[],snapshots:{}})},
  {method:'POST',path:'/api/macos-runtimes/action',scope:'macos-runtimes:control',error,async handler(c){
   if(!active(c))return c.json(409,{error:{code:'INTEGRATION_DISABLED'}});
   const action=computeAction(c.input,c.state.config.hosts);
   const result=await c.state.clients[action.host]('/compute/action','POST',action);await c.state.poller.poll();
   return c.json(200,{snapshot:normalizeSnapshot(result.snapshot,Date.now(),c.state.config.hosts)});
  }},
  {method:'POST',path:'/api/macos-runtimes/controls/action',scope:'macos-runtimes:control',error,async handler(c){
   if(!active(c))return c.json(409,{error:{code:'INTEGRATION_DISABLED'}});
   const {host,...action}=hostControlAction(c.input,c.state.config.controls,c.state.config.bridgeDevices);
   return c.json(200,await c.state.clients[host]('/controls/action','POST',action));
  }},
  {method:'GET',path:'/api/macos-runtimes/controls',error,async handler(c){
   if(!active(c))return c.json(200,{devices:[]});
   return c.json(200,{devices:await Promise.all(c.state.config.bridgeDevices.map(async device=>({device,...await c.state.clients[device]('/controls')})))});
  }},
 ],
};
