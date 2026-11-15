import {readComputeConfig,computeAgentConfig} from './config.mjs';
export default function({site,device}){
 const config=readComputeConfig(site.plugins?.['macos-runtimes'],site);
 if(!config?.hosts.find(h=>h.id===device)?.agent)throw new Error('plugins.macos-runtimes.hosts: device needs an agent profile');
 return computeAgentConfig(config,device);
}
