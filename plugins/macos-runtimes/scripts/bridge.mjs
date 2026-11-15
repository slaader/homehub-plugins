import http from 'node:http';
import path from 'node:path';
import {readFile,mkdir,chmod,lstat,unlink} from 'node:fs/promises';
import {resolvePaths,installedAgent} from 'home-hub/plugin-api';
import {readComputeAgentConfig} from '../server/config.mjs';
import {createComputeController} from './compute-controller.mjs';
import {createServiceController} from './service-controller.mjs';
export async function startBridge({config,socket,stateDirectory,controller,controls}={}){
 controller??=createComputeController({...config,stateDirectory});
 controls??=createServiceController({definitions:config.controls,auditDirectory:stateDirectory});
 await mkdir(path.dirname(socket),{recursive:true,mode:0o700});
 try{const s=await lstat(socket);if(!s.isSocket())throw new Error('socket path exists');await unlink(socket);}catch(e){if(e.code!=='ENOENT')throw e;}
 const server=http.createServer(async(req,res)=>{
  const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  try{
   const url=new URL(req.url,'http://localhost');let input={};
   if(req.method==='POST'){
    const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>16384)throw new Error('invalid');chunks.push(b);}input=JSON.parse(Buffer.concat(chunks));
   }
   let value;
   if(req.method==='GET'&&url.pathname==='/compute/snapshot')value={...await controller.snapshot(),agent:installedAgent()};
   else if(req.method==='GET'&&url.pathname==='/compute/records')value=controller.records(Number(url.searchParams.get('after')??0));
   else if(req.method==='POST'&&url.pathname==='/compute/action')value=await controller.action(input);
   else if(req.method==='GET'&&url.pathname==='/controls')value=await controls.status();
   else if(req.method==='POST'&&url.pathname==='/controls/action')value=await controls.action(input);
   else return reply(404,{error:'not-found'});
   reply(200,value);
  }catch{reply(400,{error:'unavailable'});}
 });
 await controller.start();
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});await chmod(socket,0o600);
 return {server,async stop(){controller.stop();await new Promise(r=>server.close(r));await unlink(socket).catch(e=>{if(e.code!=='ENOENT')throw e;});}};
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const paths=resolvePaths(),config=readComputeAgentConfig(JSON.parse(await readFile(path.join(paths.config,'bridge.json'),'utf8')));
 const bridge=await startBridge({config,socket:process.env.HOME_HUB_AGENT_SOCKET,stateDirectory:paths.data});
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>bridge.stop().then(()=>process.exit(0)));
}
