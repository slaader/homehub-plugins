// Plugin "unifi": the router census pulled by the hub itself from a UniFi gateway's Network integration API, with a
// API key (README.md); every request is read-only. Nothing is installed on the router or on another host. It provides the router adapter
// "unifi-api" (core docs/plugins.md → The router adapter); site.json → router.adapter = "unifi-api" selects it.
// Without site.json → plugins.unifi the plugin is inert: no adapter, no poller work, nothing contacted.
import {resolvePaths,tx} from 'home-hub/plugin-api';
import {readUnifiConfig} from './server/config.mjs';
import {createUnifiAdapter,ADAPTER_ID,INTEGRATION_ID} from './server/adapter.mjs';

const ERRORS={
 'key-missing':'Chybí API klíč.','key-invalid':'API klíč nemá platný tvar.','key-permissions':'Soubor s API klíčem musí mít práva 0600 a patřit uživateli hubu.',
 unauthorized:'Brána API klíč odmítla (401).',forbidden:'Brána přístup odmítla (403).','rate-limited':'Brána žádá o pomalejší čtení (429).',
 'certificate-changed':'Certifikát brány nesouhlasí s otiskem v plugins.unifi.fingerprint.','certificate-untrusted':'Certifikát brány není důvěryhodný; nastav plugins.unifi.fingerprint.',
 timeout:'Brána neodpověděla včas.',unreachable:'Brána není dosažitelná.','response-too-large':'Odpověď brány je větší než povolený limit.',
 'invalid-response':'Odpověď brány nemá očekávaný tvar.','no-site':'Brána nemá žádnou (nebo nastavenou) síť UniFi.','internal-error':'Vnitřní chyba při čtení.',
};

function keySource(state,hub){
 if(hub.integrationSecret(INTEGRATION_ID,'apiKey'))return {source:'ui',name:'apiKey'};
 if(state.config?.keyFile)return {source:'file',name:`private/${state.config.keyFile}`};
 return null;
}
function configuredBy(state,hub){
 if(!state.config)return [];
 const out=[{source:'site.json',name:'plugins.unifi.host'}];
 if(state.config.fingerprint)out.push({source:'site.json',name:'plugins.unifi.fingerprint'});
 const key=keySource(state,hub);if(key)out.push(key);
 if(hub.site.router?.adapter)out.push({source:'site.json',name:`router.adapter = ${hub.site.router.adapter}`});
 return out;
}

// Integration "unifi.api": the card on Administration → Integrations. Cheap: what the last pull left, no network call.
export function unifiStatus(state,hub,{enabled=true}={}){
 const by=configuredBy(state,hub);
 if(!state.config)return {state:'not-configured',summary:'V site.json chybí plugins.unifi.',configuredBy:by};
 if(!enabled)return {state:'disabled',summary:'',configuredBy:by};
 const items=[];
 const wanted=hub.site.router?.adapter;
 if(wanted&&wanted!==ADAPTER_ID)items.push({id:'adapter',label:'router.adapter',state:'not-configured',summary:tx('site.json → router.adapter je „{adapter}“: hub tenhle adaptér nepoužívá.',{adapter:wanted})});
 if(!keySource(state,hub))return {state:'not-configured',summary:'Chybí API klíč: zadej ho v nastavení téhle integrace, nebo nastav plugins.unifi.keyFile.',configuredBy:by,items};
 const {observation:o}=state.unifi.status();
 const lastSuccessAt=o?.observedAt||null;
 if(!o)return {state:'stale',summary:'Zatím nic nepřečteno.',configuredBy:by,items};
 if(o.status!=='ok')return {state:'error',summary:ERRORS[o.error]||tx('Poslední čtení selhalo: {code}.',{code:o.error||'unavailable'}),lastSuccessAt,lastError:o.error||'unavailable',configuredBy:by,items};
 const age=Date.now()-Date.parse(o.observedAt);
 if(!(age<=state.config.staleAfterSeconds*1000))return {state:'stale',summary:'Poslední pozorování je staré.',lastSuccessAt,configuredBy:by,items};
 return {state:'ok',summary:tx('Brána hlásí {clients} klientů a {hardware} zařízení UniFi.',{clients:o.clients?.length||0,hardware:o.hardware?.length||0}),lastSuccessAt,configuredBy:by,items};
}

export default {
 id:'unifi',title:'UniFi Network API',
 setup(hub){
  const config=readUnifiConfig(hub.site.plugins?.unifi);
  if(!config)return {config:null,unifi:null};
  const options=hub.options.unifi||{};
  const unifi=createUnifiAdapter({config,site:hub.site,dataDirectory:hub.pluginData('unifi'),
   privateDirectory:options.privateDirectory||resolvePaths().private,arpPath:options.arpPath,now:options.now,
   secret:()=>hub.integrationSecret(INTEGRATION_ID,'apiKey'),enabled:()=>hub.integrationEnabled(INTEGRATION_ID)&&hub.integrationEnabled('router.adapter'),
   log:message=>console.warn(message)});
  return {config,unifi};
 },
 provides:{'router.adapter':state=>state.unifi?.adapter??null},
 pollers:[{id:'pull',
  start(state,hub){
   if(!state.unifi)return;
   // Only while this adapter is the one in use: site.json → router.adapter unset or "unifi-api".
   const inUse=()=>!hub.site.router?.adapter||hub.site.router.adapter===ADAPTER_ID;
   if(!inUse())return;
   const tick=Math.min(5000,state.config.intervalSeconds*1000);
   state.timer=setInterval(()=>state.unifi.refresh(),tick);state.timer.unref?.();
   state.unsubscribe=hub.onIntegrationChange(({id,enabled})=>{
    if(id!==INTEGRATION_ID&&id!=='router.adapter')return;
    if(!enabled)return state.unifi.cancel();
    // A previous cancellation may still be settling; finish it before requesting the newly enabled feed.
    return state.unifi.cancel().then(()=>state.unifi.refresh({force:true}));
   });
   state.unifi.refresh();
  },
  async stop(state){clearInterval(state.timer);state.unsubscribe?.();await state.unifi?.stop();}}],
 integrations:[{id:INTEGRATION_ID,title:'UniFi Network API',kind:'router',
  description:'Hub se sám ptá brány UniFi (jen čtení, API klíč) na klienty v síti a stav zařízení UniFi; na routeru ani jinde nic neběží. Vypnutý: hub bránu nečte a router hlásí poslední sčítání jako nedostupné.',
  howTo:'V site.json nastav plugins.unifi.host (a fingerprint certifikátu brány) a router.adapter na „unifi-api“; API klíč zadej v nastavení téhle integrace.',
  docs:'plugins/unifi/README.md',
  devices:(state,hub)=>state.config?hub.site.devices.filter(d=>d.role==='router').map(d=>d.id):[],
  status:unifiStatus,
  // "Test now": a real pull, whatever the interval says.
  async test(state,hub){if(state.unifi)await state.unifi.refresh({force:true});return unifiStatus(state,hub);},
  settings:{schema:[{key:'apiKey',label:'API klíč',type:'text',secret:true,
   help:'UniFi Network → Settings → Control Plane → Integrations → Create API key. Ukládá se jen pro zápis; hub ho nikdy nevrací.'}],
   read:()=>({}),write:async()=>{}}}],
 strings:{en:{
  'UniFi Network API':'UniFi Network API',
  'Hub se sám ptá brány UniFi (jen čtení, API klíč) na klienty v síti a stav zařízení UniFi; na routeru ani jinde nic neběží. Vypnutý: hub bránu nečte a router hlásí poslední sčítání jako nedostupné.':'The hub itself asks the UniFi gateway (read-only, an API key) for the network clients and the state of the UniFi devices; nothing runs on the router or anywhere else. Off: the hub does not read the gateway and the router reports the last census as unavailable.',
  'V site.json nastav plugins.unifi.host (a fingerprint certifikátu brány) a router.adapter na „unifi-api“; API klíč zadej v nastavení téhle integrace.':'In site.json set plugins.unifi.host (and the fingerprint of the gateway certificate) and router.adapter to "unifi-api"; enter the API key in this integration\'s settings.',
  'API klíč':'API key',
  'UniFi Network → Settings → Control Plane → Integrations → Create API key. Ukládá se jen pro zápis; hub ho nikdy nevrací.':'UniFi Network → Settings → Control Plane → Integrations → Create API key. Stored write-only; the hub never sends it back.',
  'V site.json chybí plugins.unifi.':'site.json has no plugins.unifi.',
  'site.json → router.adapter je „{adapter}“: hub tenhle adaptér nepoužívá.':'site.json → router.adapter is "{adapter}": the hub does not use this adapter.',
  'Chybí API klíč: zadej ho v nastavení téhle integrace, nebo nastav plugins.unifi.keyFile.':'No API key: enter it in this integration\'s settings, or set plugins.unifi.keyFile.',
  'Zatím nic nepřečteno.':'Nothing read yet.',
  'Poslední čtení selhalo: {code}.':'The last read failed: {code}.',
  'Poslední pozorování je staré.':'The last observation is old.',
  'Brána hlásí {clients} klientů a {hardware} zařízení UniFi.':'The gateway reports {clients} clients and {hardware} UniFi devices.',
  'Chybí API klíč.':'No API key.','API klíč nemá platný tvar.':'The API key is not well formed.',
  'Soubor s API klíčem musí mít práva 0600 a patřit uživateli hubu.':'The API key file must be mode 0600 and owned by the hub\'s user.',
  'Brána API klíč odmítla (401).':'The gateway refused the API key (401).','Brána přístup odmítla (403).':'The gateway refused access (403).',
  'Brána žádá o pomalejší čtení (429).':'The gateway asks for slower reads (429).',
  'Certifikát brány nesouhlasí s otiskem v plugins.unifi.fingerprint.':'The gateway certificate does not match plugins.unifi.fingerprint.',
  'Certifikát brány není důvěryhodný; nastav plugins.unifi.fingerprint.':'The gateway certificate is not trusted; set plugins.unifi.fingerprint.',
  'Brána neodpověděla včas.':'The gateway did not answer in time.','Brána není dosažitelná.':'The gateway cannot be reached.',
  'Odpověď brány je větší než povolený limit.':'The gateway\'s answer is larger than the limit.','Odpověď brány nemá očekávaný tvar.':'The gateway\'s answer is not in the expected form.',
  'Brána nemá žádnou (nebo nastavenou) síť UniFi.':'The gateway has no UniFi site (or not the configured one).','Vnitřní chyba při čtení.':'Internal error while reading.',
 }},
};
