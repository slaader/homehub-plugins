import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
let core;
try{core=path.dirname(fileURLToPath(import.meta.resolve('home-hub/package.json')));}
catch{console.error('Link Home Hub 2.0 first: node <core>/scripts/plugins.mjs link --plugins <this-source>/plugins');process.exit(2);}
const r=spawnSync(process.execPath,[path.join(core,'scripts/run-tests.mjs'),'--plugins',root,...process.argv.slice(2)],{stdio:'inherit'});
process.exit(r.status??1);
