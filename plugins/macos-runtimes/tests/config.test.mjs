import test from 'node:test';
import assert from 'node:assert/strict';
import {readComputeConfig,readComputeAgentConfig,computeAgentConfig} from '../server/config.mjs';
const devices=[{id:'mac',name:'Example Mac'}];
const raw={sockets:{mac:'/tmp/example/bridge.sock'},hosts:{mac:{agent:{jobs:{toolDir:'.local/share/uv/tools/mflux'}}}}};
const payload=()=>computeAgentConfig(readComputeConfig(raw,{devices}),'mac');
test('installed bridge accepts the core installer envelope and the normalized jobs profile',()=>{
 const doc={$comment:'Written by the host-agent installer.',plugin:'macos-runtimes',agent:'bridge',device:'mac',...payload()};
 assert.equal(readComputeAgentConfig(doc).profile.jobs.description,'');
 for(const [field,value] of [['plugin','other'],['agent','other'],['device','other'],['unknown',true]])assert.throws(()=>readComputeAgentConfig({...doc,[field]:value}),new RegExp(`plugins.macos-runtimes.*${field}`));
});
test('malformed config containers fail with their configuration field',()=>{
 for(const [field,value] of [['hosts',null],['controls',null],['sockets',null],['page',null],['page',{links:null}],['agents',{bridge:null}],['agents',{bridge:{mac:{env:null}}}]]){
  assert.throws(()=>readComputeConfig({[field]:value},{devices}),new RegExp(`plugins.macos-runtimes.*${field}`));
 }
 const extra={hosts:{mac:{bridge:false,agent:{jobs:{toolDir:'.local/tools',typo:true}}}}};
 assert.throws(()=>readComputeConfig(extra,{devices}),/hosts.mac.agent.jobs.*typo/);
});
test('runtime origins and page links use valid loopback ports',()=>{
 for(const field of ['base','url'])for(const value of ['http://127.0.0.1:00','http://127.0.0.1:99999']){
  assert.throws(()=>readComputeConfig({hosts:{mac:{bridge:false,agent:{omlx:{base:'http://127.0.0.1:8000',[field]:value}}}}},{devices}),new RegExp(`omlx.${field}`));
 }
 assert.equal(readComputeConfig({hosts:{mac:{bridge:false,agent:{omlx:{base:'http://127.0.0.1:80',url:'http://127.0.0.1:80/'}}}}},{devices}).hosts[0].agent.omlx.url,'http://127.0.0.1:80/');
});
test('agent config refuses duplicate service IDs and non-string placement labels',()=>{
 const service={id:'example',label:'com.example.runtime',name:'Runtime',impact:'Stops runtime'};
 assert.throws(()=>readComputeAgentConfig({...payload(),controls:[service,service]}),/controls lists an id twice/);
 assert.throws(()=>readComputeConfig({agents:{bridge:{mac:{label:123}}}},{devices}),/agents.bridge.mac.label/);
});
