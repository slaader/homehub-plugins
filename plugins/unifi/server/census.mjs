// UniFi Network integration API (v1) records → the router observation core reads (router.adapter, core
// server/router-data.mjs → normalizeRouter). A port of the integration-API backend of core's
// scripts/collect-router-unifi.py: the same fields, connection types, presence, gateway choice and known-clients memory.
//   clients:  {macAddress, ipAddress, name, type: WIRED | WIRELESS | …, connectedAt, uplinkDeviceId, …band fields}
//   devices:  {id, name, model, macAddress, ipAddress, state, firmwareVersion}
import {readFileSync} from 'node:fs';

export const MAX_CLIENTS=500,MAX_HARDWARE=50,KNOWN_DAYS=90;
const MAC=/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const BANDS={'2.4':'Wi-Fi · 2.4 GHz','5':'Wi-Fi · 5 GHz','6':'Wi-Fi · 6 GHz'};
// Model codes the API reports, with the name people know them by.
const MODELS={UDR7:'UniFi Dream Router 7'};
const GATEWAY_MODELS=['UDR','UDM','UCG','UXG'];
const PRIVATE_NETWORKS=['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16'];

// The first of names that holds a non-empty string or number, trimmed and cut to max; booleans never count.
export function pick(obj,names,max=160){
 if(!obj||typeof obj!=='object')return '';
 for(const name of names){const v=obj[name];if(typeof v==='boolean')continue;
  if((typeof v==='string'||(typeof v==='number'&&Number.isFinite(v)))&&String(v).trim())return String(v).trim().slice(0,max);}
 return '';
}

// '2.4' | '5' | '6' | '' from whichever band field the client (or one of its nested objects) carries.
export function band(client){
 for(const obj of [client,...Object.values(client).filter(v=>v&&typeof v==='object'&&!Array.isArray(v))]){
  for(const key of ['frequencyGHz','frequency','band','radioBand','radio','wifiBand','channelBand']){
   const value=obj[key];if(value===undefined||value===null||value===''||typeof value==='boolean')continue;
   const text=String(value).trim().toLowerCase();
   if(['ng','2g','2'].includes(text)||text.startsWith('2.4')||text.startsWith('24'))return '2.4';
   if(['6e','6g'].includes(text)||text.startsWith('6'))return '6';
   if(['na','ac','5g'].includes(text)||text.startsWith('5'))return '5';
  }
 }
 return '';
}

// --- networks ------------------------------------------------------------------------------------
const ipv4=text=>{const m=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text).trim());if(!m)return null;
 const parts=m.slice(1).map(Number);if(parts.some(p=>p>255))return null;return ((parts[0]<<24)|(parts[1]<<16)|(parts[2]<<8)|parts[3])>>>0;};
export function parseNetwork(text){
 const m=/^([\d.]+)\/(\d{1,2})$/.exec(String(text).trim());if(!m)return null;
 const base=ipv4(m[1]),bits=Number(m[2]);if(base===null||bits>32)return null;
 const mask=bits===0?0:(0xffffffff<<(32-bits))>>>0;return {base:(base&mask)>>>0,mask,bits};
}
/** The networks clients must be in: site.json → lanCidrs, else the /24 around the gateway, else the private ranges. */
export function networksFor(lanCidrs,host){
 const own=(lanCidrs||[]).map(parseNetwork).filter(Boolean).slice(0,16);
 if(own.length)return own;
 const around=ipv4(host)!==null?parseNetwork(`${host}/24`):null;
 return around?[around]:PRIVATE_NETWORKS.map(parseNetwork);
}
/** A host address inside one of the networks (not its network or broadcast address), else null. */
export function lanIp(value,networks){
 const n=ipv4(value);if(n===null)return null;
 const net=networks.find(x=>((n&x.mask)>>>0)===x.base);if(!net)return null;
 if(net.bits<31){const host=(n&~net.mask)>>>0,last=(~net.mask)>>>0;if(host===0||host===last)return null;}
 return String(value).trim();
}

/** The MAC the router uses on the LAN (its base MAC in the API can differ), from the kernel neighbour table (Linux). */
export function lanMac(ip,arpPath='/proc/net/arp'){
 let lines;try{lines=readFileSync(arpPath,'utf8').split('\n').slice(1,4097);}catch{return '';}
 for(const line of lines){const parts=line.trim().split(/\s+/);
  if(parts.length>=4&&parts[0]===ip&&parts[2]==='0x2'&&MAC.test(parts[3].toLowerCase()))return parts[3].toLowerCase();}
 return '';
}

const time=v=>{const t=Date.parse(v);return Number.isFinite(t)?t:null;};

/**
 * clients and gear (the API's records), now (ISO time), previousKnown ({mac: {ip, name, type, lastSeen}}), host (the
 * gateway's address), networks → the census part of an observation: {clients, clientCounts, model, firmware, routerMac,
 * routerIp, hardware, knownClients}.
 */
export function parseCensus(clients,gear,{now,previousKnown={},host,networks}){
 const names=new Map(),hardware=[];
 for(const item of gear.slice(0,MAX_HARDWARE)){
  if(!item||typeof item!=='object')continue;
  const mac=pick(item,['macAddress','mac']).toLowerCase();
  const entry={name:pick(item,['name']),model:pick(item,['model'],40),mac:MAC.test(mac)?mac:'',ip:lanIp(pick(item,['ipAddress','ip']),networks),
   state:pick(item,['state'],32),firmware:pick(item,['firmwareVersion','firmware'],64)};
  hardware.push(entry);names.set(pick(item,['id'],64),entry.name);
 }
 const gateway=hardware.find(h=>h.ip===host)||hardware.find(h=>GATEWAY_MODELS.some(p=>h.model.toUpperCase().startsWith(p)))||hardware[0]||null;
 const records=new Map(),counts={wired:0,wireless:0,other:0};
 for(const client of clients){
  if(!client||typeof client!=='object')continue;
  const mac=pick(client,['macAddress','mac']).toLowerCase(),ip=lanIp(pick(client,['ipAddress','ip']),networks);
  if(!MAC.test(mac)||!ip)continue;
  const kind=pick(client,['type','connectionType'],16).toUpperCase();
  let connection,presence;
  if(kind==='WIRED'){connection='Ethernet';presence='reachable';counts.wired++;}
  else if(kind==='WIRELESS'){connection=BANDS[band(client)]||'Wi-Fi';presence='associated';counts.wireless++;}
  else{connection='Unknown';presence='reachable';counts.other++;}
  records.set(mac,{mac,ip,name:pick(client,['name','hostname','displayName']),connection,presence,connected:true,type:kind||'UNKNOWN',
   connectedAt:pick(client,['connectedAt'],40),lastSeen:now,uplink:names.get(pick(client,['uplinkDeviceId'],64))||''});
 }
 // Clients seen in the last 90 days (what the health's "known" count is), carried from one observation to the next.
 const cutoff=(time(now)??Date.now())-KNOWN_DAYS*86400000;
 const known=new Map();
 for(const [mac,entry] of Object.entries(previousKnown&&typeof previousKnown==='object'?previousKnown:{})){
  const seen=entry&&typeof entry==='object'?time(entry.lastSeen):null;
  if(MAC.test(mac)&&seen!==null&&seen>=cutoff)known.set(mac,{ip:lanIp(entry.ip,networks),name:pick(entry,['name']),type:pick(entry,['type'],16),lastSeen:String(entry.lastSeen).slice(0,40)});
 }
 for(const [mac,r] of records)known.set(mac,{ip:r.ip,name:r.name,type:r.type,lastSeen:now});
 const knownClients=Object.fromEntries([...known].sort((a,b)=>(time(b[1].lastSeen)??0)-(time(a[1].lastSeen)??0)).slice(0,MAX_CLIENTS));
 const model=gateway?.model||'';
 return {clients:[...records.values()].slice(0,MAX_CLIENTS),clientCounts:counts,model:MODELS[model]?`${MODELS[model]} (${model})`:model,
  firmware:gateway?.firmware||'',routerMac:gateway?.mac||'',routerIp:host,hardware,knownClients};
}

/** A list answer: a bare list, or {data: [...], totalCount}. → {items, total}; anything else is 'invalid-response'. */
export function rows(payload){
 if(Array.isArray(payload))return {items:payload,total:payload.length};
 if(payload&&typeof payload==='object'&&Array.isArray(payload.data))
  return {items:payload.data,total:Number.isSafeInteger(payload.totalCount)?payload.totalCount:payload.data.length};
 return null;
}
