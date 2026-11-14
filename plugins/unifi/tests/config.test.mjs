// site.json → plugins.unifi (server/config.mjs): the defaults, and what is refused, by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readUnifiConfig,normalizeFingerprint} from '../server/config.mjs';

const PIN='ab'.repeat(32);

test('plugins.unifi: no section is an inert plugin; only host is needed, the rest has defaults',()=>{
 assert.equal(readUnifiConfig(undefined),null);
 assert.equal(readUnifiConfig(null),null);
 assert.deepEqual(readUnifiConfig({host:'10.0.0.1'}),{host:'10.0.0.1',port:443,site:null,fingerprint:null,keyFile:null,intervalSeconds:60,staleAfterSeconds:180,timeoutSeconds:10});
 const full=readUnifiConfig({$comment:'x',host:'gateway.example.lan',port:8443,site:'default',fingerprint:PIN.toUpperCase().match(/../g).join(':'),keyFile:'unifi/api-key',intervalSeconds:300,timeoutSeconds:5});
 assert.deepEqual(full,{host:'gateway.example.lan',port:8443,site:'default',fingerprint:PIN,keyFile:'unifi/api-key',intervalSeconds:300,staleAfterSeconds:900,timeoutSeconds:5});
 assert.ok(Object.isFrozen(full));
 assert.equal(readUnifiConfig({host:'10.0.0.1',intervalSeconds:60,staleAfterSeconds:60}).staleAfterSeconds,60);
 assert.equal(normalizeFingerprint(`sha256:${PIN}`),PIN);
 assert.equal(normalizeFingerprint('abc'),null);
});

test('plugins.unifi: what is refused, by name',()=>{
 const read=raw=>()=>readUnifiConfig(raw),ok={host:'10.0.0.1'};
 assert.throws(read([]),/plugins\.unifi\.\(the section\) must be an object/);
 assert.throws(read({...ok,apiKey:'secret'}),/plugins\.unifi\.\(the section\) has unknown field\(s\): apiKey/);
 assert.throws(read({}),/plugins\.unifi\.host is required/);
 for(const host of ['https://10.0.0.1','10.0.0.1:443','10.0.0.1/api','999.0.0.1','-bad.example.lan','',7])assert.throws(read({host}),/host must be an IPv4 address or a host name/,String(host));
 for(const port of [0,65536,'443',1.5])assert.throws(read({...ok,port}),/port must be a whole number from 1 to 65535/,String(port));
 assert.throws(read({...ok,site:'my site'}),/site must be a UniFi site name/);
 for(const fingerprint of ['ab',PIN+'00','zz'.repeat(32),42])assert.throws(read({...ok,fingerprint}),/fingerprint must be the SHA-256 of the gateway certificate/);
 for(const keyFile of ['/etc/unifi-key','../unifi-key','unifi/../../x','./key','a//b','key file',''])assert.throws(read({...ok,keyFile}),/keyFile must be a path relative to the private directory/,keyFile);
 assert.throws(read({...ok,intervalSeconds:10}),/intervalSeconds must be a whole number from 30 to 3600/);
 assert.throws(read({...ok,staleAfterSeconds:30}),/staleAfterSeconds must be a whole number from 60 to 86400/);
 assert.throws(read({...ok,intervalSeconds:600,staleAfterSeconds:300}),/staleAfterSeconds must not be shorter than intervalSeconds/);
 assert.throws(read({...ok,timeoutSeconds:0}),/timeoutSeconds must be a whole number from 1 to 60/);
});
