import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const core=path.dirname(fileURLToPath(import.meta.resolve('home-hub/package.json')));
const {scanContent,formatFindings}=await import(pathToFileURL(path.join(core,'scripts/leak-scan.mjs')));
function files(dir=''){
 return readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>{
  if(['.git','node_modules'].includes(e.name))return [];
  const rel=path.join(dir,e.name);return e.isDirectory()?files(rel):e.isFile()?[rel]:[];
 });
}
test('all public plugin files, fixtures and documents contain no household details',()=>{
 const findings=files().flatMap(f=>scanContent(f,readFileSync(path.join(root,f))));
 assert.equal(findings.length,0,formatFindings(findings));
});
