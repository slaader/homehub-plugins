import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,appendFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {controlAction,controlState} from '../server/control-data.mjs';
const exec=promisify(execFile);
async function execute(file,args){try{const r=await exec(file,args,{timeout:20000,maxBuffer:2*1024*1024});return {code:0,stdout:r.stdout,stderr:r.stderr};}catch(e){return {code:typeof e.code==='number'?e.code:-1,stdout:e.stdout||'',stderr:e.stderr||''};}}
export function createServiceController({run=execute,definitions=[],agentDirectory=path.join(os.homedir(),'Library/LaunchAgents'),uid=process.getuid(),auditDirectory=path.join(os.homedir(),'.local/state/home-hub')}={}){
 const domain=`gui/${uid}`,cache=new Map();let busy=false;
 async function state(service){
  try{await access(path.join(agentDirectory,service.label+'.plist'));}catch{return {id:service.id,state:'not-installed',pid:null};}
  const r=await run('/bin/launchctl',['print',`${domain}/${service.label}`]);
  if(r.code!==0)return {id:service.id,state:/Could not find service/.test(r.stderr)?'stopped':'unavailable',pid:null};
  const pid=Number(r.stdout.match(/^\s*pid = (\d+)$/m)?.[1]);return {id:service.id,state:pid>0?'running':'waiting',pid:pid>0?pid:null};
 }
 async function status(){return controlState({observedAt:new Date().toISOString(),services:await Promise.all(definitions.map(state))},definitions);}
 async function action(input){
  const value=controlAction(input,definitions),fingerprint=JSON.stringify(value),found=cache.get(value.requestId);
  if(found){if(found.fingerprint!==fingerprint)throw new Error('invalid');return found.promise;}
  if(busy)throw new Error('busy');busy=true;
  const promise=(async()=>{
   let outcome='failed';
   try{
    const service=definitions.find(x=>x.id===value.id);if(!service)throw new Error('invalid');const plist=path.join(agentDirectory,service.label+'.plist'),target=`${domain}/${service.label}`;
    const label=await run('/usr/libexec/PlistBuddy',['-c','Print :Label',plist]);if(label.code!==0||label.stdout.trim()!==service.label)throw new Error('unavailable');
    let current=await state(service);if(['unavailable','not-installed'].includes(current.state))throw new Error('unavailable');
    const command=async args=>{const r=await run('/bin/launchctl',args);if(r.code!==0)throw new Error('unavailable');};
    if(value.action==='stop'){
     await command(['disable',target]);if(current.state!=='stopped')await command(['bootout',target]);
    }else{
     await command(['enable',target]);
     if(current.state==='stopped')await command(['bootstrap',domain,plist]);
     else if(value.action==='restart'||current.state!=='running')await command(['kickstart','-k',target]);
    }
    outcome='accepted';return await status();
   }finally{
    await mkdir(auditDirectory,{recursive:true,mode:0o700});await appendFile(path.join(auditDirectory,'service-actions.jsonl'),JSON.stringify({...value,at:new Date().toISOString(),outcome})+'\n',{mode:0o600});
   }
  })();cache.set(value.requestId,{fingerprint,promise});if(cache.size>128)cache.delete(cache.keys().next().value);
  try{return await promise;}finally{busy=false;}
 }
 return {status,action};
}
