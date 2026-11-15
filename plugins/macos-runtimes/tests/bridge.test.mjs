import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {mkdtemp,rm,mkdir,chmod,lstat,writeFile,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startBridge} from '../scripts/bridge.mjs';
async function fixture(t,options={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'bridge-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const calls=[];const controller={start:async()=>calls.push('start'),stop(){},snapshot:async()=>({hostId:'mac'}),records:after=>{calls.push(after);return {cursor:after};},action:async input=>{calls.push(input);return {ok:true};}};
 const controls={status:async()=>({services:[]}),action:controller.action};
 const socket=path.join(dir,'bridge.sock');
 const bridge=await startBridge({socket,controller,controls,...options});t.after(()=>bridge.stop());
 const request=(route,{method='GET',body,headers={'Content-Type':'application/json'}}={})=>new Promise((resolve,reject)=>{
  const req=http.request({socketPath:socket,path:route,method,headers,agent:false},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});
  req.on('error',reject);req.end(body);
 });
 return {dir,socket,bridge,calls,request,controller,controls};
}
test('bridge socket is private and a second start preserves a live listener',async t=>{
 const f=await fixture(t);assert.equal((await lstat(f.socket)).mode&0o777,0o600);
 await assert.rejects(startBridge({socket:f.socket,controller:f.controller,controls:f.controls}),/already in use/);
 assert.equal((await f.request('/compute/snapshot')).status,200);
});
test('unsafe directories, symlinks and occupied paths are refused before controllers start',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'bridge-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let starts=0;const controller={start:async()=>starts++},controls={};
 const unsafe=path.join(root,'unsafe');await mkdir(unsafe);await chmod(unsafe,0o777);
 await assert.rejects(startBridge({socket:path.join(unsafe,'bridge.sock'),controller,controls}),/owner-only/);
 const link=path.join(root,'link');await symlink(root,link);
 await assert.rejects(startBridge({socket:path.join(link,'bridge.sock'),controller,controls}),/owner-only/);
 const file=path.join(root,'file');await writeFile(file,'preserve');
 await assert.rejects(startBridge({socket:file,controller,controls}),/socket path exists/);
 await assert.rejects(startBridge({socket:file+'/../other',controller,controls}),/invalid socket/);
 assert.equal(starts,0);
});
test('bridge rejects malformed, oversized and ambiguous requests without dispatch',async t=>{
 const {request,calls}=await fixture(t);
 for(const body of ['{','null','[]','true','"text"'])assert.equal((await request('/compute/action',{method:'POST',body})).status,400);
 assert.equal((await request('/compute/action',{method:'POST',body:'{}',headers:{'Content-Type':'text/plain'}})).status,415);
 assert.equal((await request('/compute/action',{method:'POST',body:'x'.repeat(17000),headers:{'Content-Type':'application/json','Transfer-Encoding':'chunked'}})).status,413);
 assert.equal((await request('/compute/action',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':'17000'}})).status,413);
 for(const route of ['/compute/records?after=-1','/compute/records?after=NaN','/compute/records?after=9007199254740992','/compute/records?after=1&after=2','/compute/records?extra=1'])assert.equal((await request(route)).status,400);
 assert.equal((await request('/compute/action?extra=1',{method:'POST',body:'{}'})).status,404);
 assert.deepEqual(calls,['start']);
 assert.deepEqual((await request('/compute/records?after=7')).body,{cursor:7});
 assert.equal((await request('/controls/action',{method:'POST',body:'{}'})).status,200);
});
test('bridge closes slow partial headers and partial bodies at the arrival deadline',async t=>{
 const f=await fixture(t,{requestTimeoutMs:50});
 for(const text of ['POST /compute/action HTTP/1.1\r\nHost: localhost\r\n','POST /compute/action HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{']){
  await new Promise((resolve,reject)=>{
   const socket=net.createConnection(f.socket,()=>socket.write(text));
   const fail=setTimeout(()=>{socket.destroy();reject(new Error('slow connection survived'));},1000);
   socket.on('error',()=>{});socket.on('close',()=>{clearTimeout(fail);resolve();});
  });
 }
 assert.deepEqual(f.calls,['start']);
});
test('a failed controller start closes the socket and listener',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'bridge-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let stopped=false;const socket=path.join(root,'bridge.sock');
 await assert.rejects(startBridge({socket,controller:{start:async()=>{throw new Error('failed');},stop(){stopped=true;}},controls:{}}),/failed/);
 assert.equal(stopped,true);await assert.rejects(lstat(socket),{code:'ENOENT'});
});
