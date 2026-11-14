// A fake UniFi gateway for the tests: HTTPS on 127.0.0.1 with core's throwaway test certificate
// (home-hub/testing → CORE_FIXTURES, tls-test.*), answering the integration API the plugin reads. Placeholder data only.
import https from 'node:https';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {X509Certificate,createHash} from 'node:crypto';
import {CORE_FIXTURES} from 'home-hub/testing';

export const KEY='TestKey-0123456789abcdefABCDEF_xyz';
export const SITE_ID='88f7af54-98f8-306a-a1c7-c9349722b1f6';
const pem=name=>readFileSync(path.join(CORE_FIXTURES,name));
const fp=cert=>createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
export const PIN=fp(pem('tls-test.crt')),OTHER_PIN=fp(pem('tls-other.crt'));

const hex=n=>(n&255).toString(16).padStart(2,'0');
const mac=i=>`02:00:00:00:${hex(i>>8)}:${hex(i)}`;
// n network clients on 10.0.0.0/24 (and beyond, for n > 250): wired, Wi-Fi in three bands, a VPN one.
export function makeClients(n){
 return Array.from({length:n},(_,i)=>{
  const ip=i<250?`10.0.0.${i+2}`:`10.0.1.${(i-250)%250+2}`;
  const base={id:`c${i}`,macAddress:mac(i).toUpperCase(),ipAddress:ip,name:`client-${i}`,connectedAt:'2026-11-01T10:00:00Z',uplinkDeviceId:i%2?'dev-ap':'dev-gw'};
  return i%5===0?{...base,type:'WIRED'}:i%5===1?{...base,type:'WIRELESS',frequencyGHz:5}:i%5===2?{...base,type:'WIRELESS',radio:'ng'}:i%5===3?{...base,type:'WIRELESS',wifi:{band:'6e'}}:{...base,type:'VPN'};
 });
}
export const DEVICES=[
 {id:'dev-gw',name:'Gateway',model:'UDR7',macAddress:'0A:00:00:00:00:01',ipAddress:'10.0.0.1',state:'ONLINE',firmwareVersion:'4.1.13'},
 {id:'dev-ap',name:'Hallway AP',model:'U7PG2',macAddress:'0A:00:00:00:00:02',ipAddress:'10.0.0.250',state:'OFFLINE',firmwareVersion:'6.6.77'},
];

/**
 * Starts the fake. options: cert ('tls-test' | 'tls-other'), clients (list), mode (null | 'hang' | 'huge' | 'huge-chunked' |
 * 'bad-json' | 'status:<n>'), changed at any time through the returned object. → {port, requests, close(), set(options)}.
 */
export async function startFakeUnifi(options={}){
 const state={cert:'tls-test',clients:makeClients(12),devices:DEVICES,mode:null,key:KEY,...options};
 const requests=[];
 const server=https.createServer({key:pem(`${state.cert}.key`),cert:pem(`${state.cert}.crt`)},(req,res)=>{
  const url=new URL(req.url,'https://gateway.example.lan');
  requests.push({method:req.method,path:url.pathname,query:Object.fromEntries(url.searchParams),key:req.headers['x-api-key']??null});
  state.onRequest?.();
  if(state.mode==='hang')return;
  const send=(status,body)=>{const text=typeof body==='string'?body:JSON.stringify(body);res.writeHead(status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(text)});res.end(text);};
  if(req.method!=='GET')return send(405,{error:'read-only fake'});
  // An echo of what was sent, as a real error page might carry: the plugin must not pass it on.
  if(req.headers['x-api-key']!==state.key)return send(401,{error:'unauthorized',echo:req.headers['x-api-key']??''});
  if(state.mode?.startsWith('status:'))return send(Number(state.mode.slice(7)),{error:'x'});
  if(state.mode==='huge')return send(200,{data:[],pad:'x'.repeat(1100*1024)});
  if(state.mode==='huge-chunked'){res.writeHead(200,{'Content-Type':'application/json'});const chunk='x'.repeat(64*1024);let sent=0;const more=()=>{while(sent<20){sent++;if(!res.write(chunk))return res.once('drain',more);}res.end();};res.write('{"pad":"');more();return;}
  if(state.mode==='bad-json')return send(200,'<html>not json</html>');
  const page=list=>{const offset=Number(url.searchParams.get('offset')||0),limit=Math.min(Number(url.searchParams.get('limit')||25),200);
   const data=list.slice(offset,offset+limit);return {offset,limit,count:data.length,totalCount:list.length,data};};
  const base='/proxy/network/integration/v1';
  if(url.pathname===`${base}/info`)return send(200,{applicationVersion:'9.4.19'});
  if(url.pathname===`${base}/sites`)return send(200,page([{id:SITE_ID,internalReference:'default',name:'Default'}]));
  if(url.pathname===`${base}/sites/${SITE_ID}/clients`)return send(200,page(state.clients));
  if(url.pathname===`${base}/sites/${SITE_ID}/devices`)return send(200,page(state.devices));
  send(404,{error:'not found'});
 });
 const sockets=new Set();server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {port:server.address().port,requests,set(next){Object.assign(state,next);},
  async close(){for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
