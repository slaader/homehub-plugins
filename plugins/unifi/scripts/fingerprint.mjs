#!/usr/bin/env node
// The SHA-256 fingerprint of the certificate a UniFi gateway presents, for site.json → plugins.unifi.fingerprint.
// Only the TLS handshake happens: no request, no API key. Compare the value with what the UniFi console shows (or
// run it from a second computer) before you trust it.
//   node plugins/unifi/scripts/fingerprint.mjs 10.0.0.1 [443]
import {observeFingerprint} from '../server/client.mjs';

const [host,port='443']=process.argv.slice(2);
if(!host||!/^\d{1,5}$/.test(port)){console.error('usage: fingerprint.mjs <gateway address> [port]');process.exit(2);}
try{
 const fingerprint=await observeFingerprint({host,port:Number(port),timeoutMs:10000});
 console.log(JSON.stringify({host,port:Number(port),fingerprint}));
}catch(e){console.error(JSON.stringify({host,error:e.code||'unreachable'}));process.exit(1);}
