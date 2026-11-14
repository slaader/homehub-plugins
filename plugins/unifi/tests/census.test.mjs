// UniFi records → the observation (server/census.mjs), as core's scripts/collect-router-unifi.py maps them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseCensus,networksFor,lanIp,band,pick,lanMac,rows} from '../server/census.mjs';

const NOW='2026-11-14T12:00:00.000Z';
const nets=networksFor(['10.0.0.0/24'],'10.0.0.1');
const gear=[
 {id:'ap1',name:'Hallway AP',model:'U7PG2',macAddress:'0A:00:00:00:00:02',ipAddress:'10.0.0.250',state:'OFFLINE',firmwareVersion:'6.6.77'},
 {id:'gw',name:'Gateway',model:'UDR7',macAddress:'0A:00:00:00:00:01',ipAddress:'10.0.0.1',state:'ONLINE',firmwareVersion:'4.1.13'},
 {id:'sw',name:'Switch',model:'USW-Lite-8',macAddress:'nope',ipAddress:'192.0.2.9',state:'ONLINE'}];

test('clients: connection type, Wi-Fi band, presence, uplink name; what is not a LAN client is left out',()=>{
 const clients=[
  {macAddress:'02:00:00:00:00:0A',ipAddress:'10.0.0.10',name:'printer',type:'WIRED',uplinkDeviceId:'gw',connectedAt:'2026-11-14T08:00:00Z'},
  {macAddress:'02:00:00:00:00:0B',ipAddress:'10.0.0.11',hostname:'phone',type:'WIRELESS',frequencyGHz:5,uplinkDeviceId:'ap1'},
  {mac:'02:00:00:00:00:0c',ip:'10.0.0.12',displayName:'tablet',type:'wireless',radio:'ng'},
  {macAddress:'02:00:00:00:00:0D',ipAddress:'10.0.0.13',name:'laptop',type:'WIRELESS',wifi:{band:'6e'}},
  {macAddress:'02:00:00:00:00:0E',ipAddress:'10.0.0.14',name:'tv',type:'WIRELESS'},
  {macAddress:'02:00:00:00:00:0F',ipAddress:'10.0.0.15',name:'tunnel',type:'VPN'},
  {macAddress:'02:00:00:00:00:10',ipAddress:'10.9.9.9',name:'elsewhere',type:'WIRED'},
  {macAddress:'02:00:00:00:00:11',ipAddress:'10.0.0.255',name:'broadcast',type:'WIRED'},
  {macAddress:'02:00:00:00:00:12',ipAddress:'10.0.0.0',name:'network',type:'WIRED'},
  {macAddress:'not-a-mac',ipAddress:'10.0.0.16',type:'WIRED'},{macAddress:'02:00:00:00:00:13',type:'WIRED'},null,'x'];
 const c=parseCensus(clients,gear,{now:NOW,host:'10.0.0.1',networks:nets});
 assert.deepEqual(c.clients.map(x=>[x.mac,x.ip,x.name,x.connection,x.presence,x.type,x.uplink]),[
  ['02:00:00:00:00:0a','10.0.0.10','printer','Ethernet','reachable','WIRED','Gateway'],
  ['02:00:00:00:00:0b','10.0.0.11','phone','Wi-Fi · 5 GHz','associated','WIRELESS','Hallway AP'],
  ['02:00:00:00:00:0c','10.0.0.12','tablet','Wi-Fi · 2.4 GHz','associated','WIRELESS',''],
  ['02:00:00:00:00:0d','10.0.0.13','laptop','Wi-Fi · 6 GHz','associated','WIRELESS',''],
  ['02:00:00:00:00:0e','10.0.0.14','tv','Wi-Fi','associated','WIRELESS',''],
  ['02:00:00:00:00:0f','10.0.0.15','tunnel','Unknown','reachable','VPN','']]);
 assert.deepEqual(c.clientCounts,{wired:1,wireless:4,other:1});
 assert.equal(c.clients[0].connectedAt,'2026-11-14T08:00:00Z');assert.equal(c.clients[0].lastSeen,NOW);assert.equal(c.clients[0].connected,true);
});

test('hardware and the gateway: by address, else by model, else the first; model names and firmware',()=>{
 const c=parseCensus([],gear,{now:NOW,host:'10.0.0.1',networks:nets});
 assert.deepEqual(c.hardware,[
  {name:'Hallway AP',model:'U7PG2',mac:'0a:00:00:00:00:02',ip:'10.0.0.250',state:'OFFLINE',firmware:'6.6.77'},
  {name:'Gateway',model:'UDR7',mac:'0a:00:00:00:00:01',ip:'10.0.0.1',state:'ONLINE',firmware:'4.1.13'},
  {name:'Switch',model:'USW-Lite-8',mac:'',ip:null,state:'ONLINE',firmware:''}]);
 assert.equal(c.model,'UniFi Dream Router 7 (UDR7)');assert.equal(c.firmware,'4.1.13');assert.equal(c.routerMac,'0a:00:00:00:00:01');assert.equal(c.routerIp,'10.0.0.1');
 // The hub reaches the gateway by a name: the model decides.
 assert.equal(parseCensus([],gear,{now:NOW,host:'gateway.example.lan',networks:nets}).routerMac,'0a:00:00:00:00:01');
 // No gateway model: the first device.
 const plain=[{...gear[0]},{...gear[2]}];assert.equal(parseCensus([],plain,{now:NOW,host:'gateway.example.lan',networks:nets}).model,'U7PG2');
 assert.equal(parseCensus([],[],{now:NOW,host:'10.0.0.1',networks:nets}).model,'');
 assert.equal(parseCensus([],Array.from({length:80},(_,i)=>({id:`d${i}`,name:`d${i}`})),{now:NOW,host:'10.0.0.1',networks:nets}).hardware.length,50);
});

test('known clients: carried for 90 days, refreshed by what is seen now, at most 500',()=>{
 const previousKnown={
  '02:00:00:00:00:aa':{ip:'10.0.0.40',name:'old friend',type:'WIRED',lastSeen:'2026-10-01T00:00:00Z'},
  '02:00:00:00:00:bb':{ip:'10.0.0.41',name:'long gone',type:'WIRED',lastSeen:'2026-06-01T00:00:00Z'},
  '02:00:00:00:00:0a':{ip:'10.0.0.99',name:'printer',type:'WIRED',lastSeen:'2026-11-01T00:00:00Z'},'bad':{lastSeen:NOW}};
 const c=parseCensus([{macAddress:'02:00:00:00:00:0A',ipAddress:'10.0.0.10',name:'printer',type:'WIRED'}],[],{now:NOW,previousKnown,host:'10.0.0.1',networks:nets});
 assert.deepEqual(Object.keys(c.knownClients),['02:00:00:00:00:0a','02:00:00:00:00:aa']);
 assert.deepEqual(c.knownClients['02:00:00:00:00:0a'],{ip:'10.0.0.10',name:'printer',type:'WIRED',lastSeen:NOW});
 const many=Object.fromEntries(Array.from({length:700},(_,i)=>[`02:00:00:00:${(i>>8).toString(16).padStart(2,'0')}:${(i&255).toString(16).padStart(2,'0')}`,{lastSeen:NOW}]));
 assert.equal(Object.keys(parseCensus([],[],{now:NOW,previousKnown:many,host:'10.0.0.1',networks:nets}).knownClients).length,500);
});

test('the pieces: networks, addresses, bands, pick, list answers, the neighbour table',()=>{
 assert.deepEqual(networksFor([],'10.0.0.1').map(n=>n.bits),[24],'no lanCidrs: the /24 around the gateway');
 assert.deepEqual(networksFor([],'gateway.example.lan').map(n=>n.bits),[8,12,16],'a host name: the private ranges');
 assert.equal(lanIp('10.0.0.1',networksFor(['10.0.0.1/32'],'')),'10.0.0.1');
 assert.equal(lanIp('10.0.0.300',nets),null);assert.equal(lanIp('',nets),null);
 assert.equal(band({channelBand:'2.4GHz'}),'2.4');assert.equal(band({band:'na'}),'5');assert.equal(band({radio:true}),'');assert.equal(band({}),'');
 assert.equal(pick({a:true,b:' x ',c:'y'},['a','b','c']),'x');assert.equal(pick({a:3},['a']),'3');assert.equal(pick({a:'z'.repeat(300)},['a'],40).length,40);
 assert.deepEqual(rows([{a:1}]),{items:[{a:1}],total:1});assert.deepEqual(rows({data:[],totalCount:7}),{items:[],total:7});assert.equal(rows({nope:1}),null);
 const dir=mkdtempSync(path.join(os.tmpdir(),'unifi-arp-'));
 try{const arp=path.join(dir,'arp');
  writeFileSync(arp,'IP address       HW type     Flags       HW address            Mask     Device\n10.0.0.1         0x1         0x2         0A:00:00:00:00:99     *        br0\n10.0.0.9         0x1         0x0         00:00:00:00:00:00     *        br0\n');
  assert.equal(lanMac('10.0.0.1',arp),'0a:00:00:00:00:99');assert.equal(lanMac('10.0.0.9',arp),'');assert.equal(lanMac('10.0.0.1',path.join(dir,'none')),'');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
