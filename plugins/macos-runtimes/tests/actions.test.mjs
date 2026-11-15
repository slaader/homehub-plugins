import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServiceController} from '../scripts/service-controller.mjs';
import {createComputeController} from '../scripts/compute-controller.mjs';
import {computeAction} from '../server/compute-data.mjs';
const requestId='00000000-0000-0000-0000-000000000001';
const definitions=[{id:'runtime',label:'com.example.runtime',name:'Runtime',impact:'Stops runtime'}];
async function directory(t){const dir=await mkdtemp(path.join(os.tmpdir(),'actions-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('launchd actions accept only configured IDs and execute fixed argv without a shell',async t=>{
 const dir=await directory(t);await writeFile(path.join(dir,'com.example.runtime.plist'),'fake');
 const calls=[];let running=true;
 const controller=createServiceController({definitions,agentDirectory:dir,auditDirectory:dir,uid:501,run:async(file,args)=>{
  calls.push({file,args});
  if(file.endsWith('PlistBuddy'))return {code:0,stdout:'com.example.runtime\n'};
  if(args[0]==='print')return running?{code:0,stdout:'pid = 123\n'}:{code:1,stderr:'Could not find service'};
  if(args[0]==='bootout')running=false;if(['bootstrap','kickstart'].includes(args[0]))running=true;
  return {code:0,stdout:''};
 }});
 for(const input of [null,[],{id:'other',action:'stop',requestId},{id:'runtime',action:'stop',requestId,label:'com.other.runtime'},{id:'runtime',action:'stop;whoami',requestId},{id:'runtime',action:'stop',requestId:'-'.repeat(36)}])await assert.rejects(controller.action(input),/invalid/);
 assert.equal(calls.length,0);
 const stopped=await controller.action({id:'runtime',action:'stop',requestId});assert.equal(stopped.services[0].state,'stopped');
 const before=calls.length;await controller.action({id:'runtime',action:'stop',requestId});assert.equal(calls.length,before,'same UUID is idempotent');
 await assert.rejects(controller.action({id:'runtime',action:'start',requestId}),/invalid/);
 await controller.action({id:'runtime',action:'start',requestId:requestId.slice(0,-1)+'2'});
 await controller.action({id:'runtime',action:'restart',requestId:requestId.slice(0,-1)+'3'});
 assert.ok(calls.some(c=>JSON.stringify(c.args)===JSON.stringify(['disable','gui/501/com.example.runtime'])));
 assert.ok(calls.some(c=>JSON.stringify(c.args)===JSON.stringify(['bootstrap','gui/501',path.join(dir,'com.example.runtime.plist')])));
 assert.ok(calls.some(c=>JSON.stringify(c.args)===JSON.stringify(['kickstart','-k','gui/501/com.example.runtime'])));
 assert.ok(calls.every(c=>['/bin/launchctl','/usr/libexec/PlistBuddy'].includes(c.file)&&Array.isArray(c.args)));
 const audit=await readFile(path.join(dir,'service-actions.jsonl'),'utf8');assert.ok(!audit.includes('com.example.runtime'),'audit contains action IDs, not command output');
});
test('service label mismatch and failed commands fail closed and release the busy guard',async t=>{
 const dir=await directory(t);await writeFile(path.join(dir,'com.example.runtime.plist'),'fake');let commands=0,mode='mismatch';
 const controller=createServiceController({definitions,agentDirectory:dir,auditDirectory:dir,run:async(file,args)=>{
  if(file.endsWith('PlistBuddy'))return {code:0,stdout:mode==='mismatch'?'com.other.runtime':'com.example.runtime'};
  if(args[0]==='print')return {code:0,stdout:'pid = 123'};
  commands++;return {code:1,stderr:'PRIVATE_TEST_OUTPUT'};
 }});
 await assert.rejects(controller.action({id:'runtime',action:'stop',requestId}),/unavailable/);assert.equal(commands,0);
 mode='failure';await assert.rejects(controller.action({id:'runtime',action:'stop',requestId:requestId.slice(0,-1)+'2'}),/unavailable/);assert.equal(commands,1);
 assert.ok(!(await readFile(path.join(dir,'service-actions.jsonl'),'utf8')).includes('PRIVATE_TEST_OUTPUT'));
});
test('model actions reject traversal, unlisted models and disabled actions before calling a runtime',async t=>{
 const dir=await directory(t);let calls=0;
 const controller=createComputeController({hostId:'mac',stateDirectory:dir,profile:{actions:['warm'],llamaSwap:{base:'http://127.0.0.1:8000'}},fetcher:async()=>{calls++;throw new Error('unexpected');}});
 for(const model of ['.','..','../unload','example?x=1','unknown-model'])await assert.rejects(controller.action({action:'warm',model,requestId}),/invalid|not-found/);
 await assert.rejects(controller.action({action:'unload-all',requestId:requestId.slice(0,-1)+'2'}),/invalid/);
 assert.equal(calls,0);
 assert.throws(()=>computeAction({host:'mac',action:'warm',model:'.',requestId}),/invalid/);
});
test('model action UUIDs deduplicate, reject conflicting reuse and recover after runtime errors',async t=>{
 const dir=await directory(t);let calls=0,release;
 const pending=new Promise(resolve=>release=resolve);
 const controller=createComputeController({hostId:'mac',stateDirectory:dir,profile:{actions:['unload-all','unload-model'],llamaSwap:{base:'http://127.0.0.1:8000',flavor:'v268'}},fetcher:async()=>{calls++;await pending;throw new Error('offline');}});
 const input={action:'unload-all',requestId},first=controller.action(input),duplicate=controller.action(input);
 await assert.rejects(controller.action({action:'unload-model',model:'example',requestId}),/invalid/);
 await assert.rejects(controller.action({...input,requestId:requestId.slice(0,-1)+'2'}),/busy/);
 release();await assert.rejects(first,/offline/);await assert.rejects(duplicate,/offline/);assert.equal(calls,1);
 await assert.rejects(controller.action({...input,requestId:requestId.slice(0,-1)+'2'}),/offline/);assert.equal(calls,2);
});
