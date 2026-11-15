import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,mkdir,chmod,lstat,realpath,unlink} from 'node:fs/promises';
import {resolvePaths,installedAgent} from 'home-hub/plugin-api';
import {readComputeAgentConfig} from '../server/config.mjs';
import {createComputeController} from './compute-controller.mjs';
import {createServiceController} from './service-controller.mjs';

async function privateSocket(socket){
 if(typeof socket!=='string'||!path.isAbsolute(socket)||socket.split(path.sep).includes('..')||/[\x00-\x1f\x7f]/.test(socket))throw new Error('invalid socket path');
 const parent=path.dirname(socket),uid=process.getuid();
 await mkdir(parent,{recursive:true,mode:0o700});
 const info=await lstat(parent);
 if(!info.isDirectory()||info.uid!==uid||(info.mode&0o077))throw new Error('socket directory must be owner-only');
 // Use the canonical directory so a replaceable ancestor symlink cannot redirect the bind.
 const directory=await realpath(parent);
 for(let dir=directory;;dir=path.dirname(dir)){
  const s=await lstat(dir);
  // A root-owned sticky temporary directory cannot have our private child replaced by another user.
  const sharedTemp=s.uid===0&&(s.mode&0o1000)!==0;
  if((s.uid!==0&&s.uid!==uid)||((s.mode&0o022)&&!sharedTemp))throw new Error('unsafe socket ancestor');
  if(dir===path.dirname(dir))break;
 }
 const result=path.join(directory,path.basename(socket));
 if(Buffer.byteLength(result)>103)throw new Error('socket path too long');
 return result;
}
async function removeStaleSocket(socket){
 let info;try{info=await lstat(socket);}catch(e){if(e.code==='ENOENT')return;throw e;}
 if(!info.isSocket()||info.uid!==process.getuid()||(info.mode&0o077))throw new Error('socket path exists');
 const stale=await new Promise(resolve=>{
  const probe=net.createConnection(socket);let done=false;
  const finish=value=>{if(done)return;done=true;probe.destroy();resolve(value);};
  probe.once('connect',()=>finish(false));probe.once('error',e=>finish(e.code==='ECONNREFUSED'));
  probe.setTimeout(1000,()=>finish(false));
 });
 if(!stale)throw new Error('socket already in use');
 await unlink(socket);
}
export async function startBridge({config,socket,stateDirectory,controller,controls,requestTimeoutMs=10000}={}){
 socket=await privateSocket(socket);
 await removeStaleSocket(socket);
 controller??=createComputeController({...config,stateDirectory});
 controls??=createServiceController({definitions:config.controls,auditDirectory:stateDirectory});
 const headerTimers=new WeakMap();
 const server=http.createServer({maxHeaderSize:8192,headersTimeout:requestTimeoutMs,requestTimeout:requestTimeoutMs},async(req,res)=>{
  clearTimeout(headerTimers.get(req.socket));
  const deadline=setTimeout(()=>{if(!req.complete)req.destroy();},requestTimeoutMs);deadline.unref();
  req.once('close',()=>clearTimeout(deadline));
  const reply=(status,value)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json',...(status>=400?{Connection:'close'}:{})});res.end(JSON.stringify(value));}};
  try{
   const url=new URL(req.url,'http://localhost');let input={};
   if(req.method==='POST'){
    if(req.headers['content-type']!=='application/json')return reply(415,{error:'json-required'});
    if(Number(req.headers['content-length'])>16384)return reply(413,{error:'too-large'});
    const chunks=[];let size=0;for await(const b of req.iterator({destroyOnReturn:false})){size+=b.length;if(size>16384)return reply(413,{error:'too-large'});chunks.push(b);}input=JSON.parse(Buffer.concat(chunks));
    if(!input||typeof input!=='object'||Array.isArray(input))return reply(400,{error:'invalid'});
   }
   let value;
   if(req.method==='GET'&&url.pathname==='/compute/snapshot'&&!url.search)value={...await controller.snapshot(),agent:installedAgent()};
   else if(req.method==='GET'&&url.pathname==='/compute/records'){
    const after=url.searchParams.get('after')??'0';
    if([...url.searchParams.keys()].some(k=>k!=='after')||url.searchParams.getAll('after').length>1||!/^\d{1,16}$/.test(after)||!Number.isSafeInteger(Number(after)))return reply(400,{error:'invalid'});
    value=controller.records(Number(after));
   }
   else if(req.method==='POST'&&url.pathname==='/compute/action'&&!url.search)value=await controller.action(input);
   else if(req.method==='GET'&&url.pathname==='/controls'&&!url.search)value=await controls.status();
   else if(req.method==='POST'&&url.pathname==='/controls/action'&&!url.search)value=await controls.action(input);
   else return reply(404,{error:'not-found'});
   reply(200,value);
  }catch{reply(400,{error:'unavailable'});}
 });
 server.maxConnections=32;server.timeout=30000;server.keepAliveTimeout=1000;server.maxRequestsPerSocket=100;
 // Also bound partial headers; Node's requestTimeout is checked on a coarser timer.
 server.on('connection',connection=>{
  const timer=setTimeout(()=>connection.destroy(),requestTimeoutMs);timer.unref();headerTimers.set(connection,timer);
  connection.setTimeout(30000,()=>connection.destroy());connection.once('close',()=>clearTimeout(timer));
 });
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
  await chmod(socket,0o600);
  await controller.start();
 }catch(e){controller.stop();server.closeAllConnections();await new Promise(r=>server.close(()=>r()));throw e;}
 return {server,async stop(){controller.stop();server.closeAllConnections();await new Promise(r=>server.close(r));await unlink(socket).catch(e=>{if(e.code!=='ENOENT')throw e;});}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const paths=resolvePaths(),config=readComputeAgentConfig(JSON.parse(await readFile(path.join(paths.config,'bridge.json'),'utf8')));
 const bridge=await startBridge({config,socket:process.env.HOME_HUB_AGENT_SOCKET,stateDirectory:paths.data});
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>bridge.stop().then(()=>process.exit(0)));
}
