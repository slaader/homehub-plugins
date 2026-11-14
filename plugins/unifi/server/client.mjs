// One bounded, read-only HTTPS GET to the UniFi gateway, and its certificate's fingerprint.
//
// Trust: with a pinned fingerprint the TLS handshake is finished first, the SHA-256 of the certificate the gateway
// presents is compared with the pin, and only on a match is the request (with the API key) written on that socket.
// UniFi gateways carry a self-signed certificate, so the chain itself is not checked then: the pin is the trust.
// Without a pin the certificate must verify against the system's certificate authorities and the host name, as any
// HTTPS client does; a self-signed gateway is then refused ('certificate-untrusted'). Verification is never off.
//
// Bounds: one deadline for connect, handshake and answer (timeoutMs), at most maxBytes of body, GET only, one request
// per connection. Errors are short codes (UnifiError.code), never a body, a header or the key.
import tls from 'node:tls';
import http from 'node:http';
import {createHash} from 'node:crypto';
import net from 'node:net';

export class UnifiError extends Error{constructor(code){super(code);this.code=code;}}
export const USER_AGENT='home-hub-unifi-plugin/1';
export const MAX_BYTES=1024*1024;

export const certificateFingerprint=raw=>createHash('sha256').update(raw).digest('hex');

// A TLS socket whose handshake is done and whose certificate is trusted (pinned, or verified). Rejects with a code.
export function connectTrusted({host,port=443,fingerprint=null,timeoutMs=10000,sockets}){
 return new Promise((resolve,reject)=>{
  let done=false,socket;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error){socket?.destroy();reject(error);}else resolve(value);};
  const timer=setTimeout(()=>finish(new UnifiError('timeout')),timeoutMs);
  const pinned=Boolean(fingerprint);
  try{
   socket=tls.connect({host,port,minVersion:'TLSv1.2',ALPNProtocols:['http/1.1'],
    // Pinned: the chain of a self-signed certificate cannot verify; the fingerprint below decides instead.
    rejectUnauthorized:!pinned,...(net.isIP(host)?{}:{servername:host})});
  }catch{return finish(new UnifiError('unreachable'));}
  sockets?.add(socket);socket.once('close',()=>sockets?.delete(socket));
  socket.once('secureConnect',()=>{
   const cert=socket.getPeerCertificate(false);
   const observed=cert?.raw?certificateFingerprint(cert.raw):null;
   if(pinned&&observed!==fingerprint){const e=new UnifiError('certificate-changed');e.observed=observed;return finish(e);}
   finish(null,{socket,observed});
  });
  socket.once('error',e=>{
   const code=e?.code||'';
   if(/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_CERT_ALTNAME|HOSTNAME/i.test(code))return finish(new UnifiError('certificate-untrusted'));
   if(code==='ETIMEDOUT')return finish(new UnifiError('timeout'));
   finish(new UnifiError('unreachable'));
  });
  socket.once('close',()=>finish(new UnifiError('unreachable')));
 });
}

// The fingerprint of the certificate the gateway presents. Sends nothing but the TLS handshake.
export async function observeFingerprint({host,port=443,timeoutMs=10000}){
 const {socket,observed}=await connectTrusted({host,port,fingerprint:'0'.repeat(64),timeoutMs}).catch(e=>{
  if(e.code==='certificate-changed')return {socket:null,observed:e.observed};throw e;});
 socket?.destroy();
 if(!observed)throw new UnifiError('unreachable');
 return observed;
}

const STATUS={401:'unauthorized',403:'forbidden',429:'rate-limited'};
/**
 * GET path on the gateway with the API key → the parsed JSON. options: host, port, fingerprint, key, timeoutMs,
 * maxBytes, sockets (a Set the caller may destroy to abandon the request).
 */
export async function getJson(path,{host,port=443,fingerprint=null,key,timeoutMs=10000,maxBytes=MAX_BYTES,sockets}){
 if(typeof path!=='string'||!path.startsWith('/'))throw new UnifiError('invalid-request');
 const started=Date.now();
 const {socket}=await connectTrusted({host,port,fingerprint,timeoutMs,sockets});
 const left=Math.max(1,timeoutMs-(Date.now()-started));
 return new Promise((resolve,reject)=>{
  let done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(new UnifiError('timeout')),left);
  // createConnection hands the request the socket checked above (no agent: with agent:false Node would dial anew).
  const request=http.request({method:'GET',path,host,port,createConnection:()=>socket,
   headers:{Host:net.isIP(host)===6?`[${host}]`:host,Accept:'application/json','User-Agent':USER_AGENT,'X-API-KEY':key,Connection:'close'}},response=>{
   const status=response.statusCode;
   if(status!==200){response.resume();return finish(new UnifiError(STATUS[status]||`http-${status}`));}
   const declared=Number(response.headers['content-length']);
   if(Number.isFinite(declared)&&declared>maxBytes){finish(new UnifiError('response-too-large'));return response.destroy();}
   const chunks=[];let size=0;
   response.on('data',chunk=>{if(done)return;size+=chunk.length;if(size>maxBytes){finish(new UnifiError('response-too-large'));return response.destroy();}chunks.push(chunk);});
   response.on('end',()=>{if(done)return;let parsed;try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return finish(new UnifiError('invalid-response'));}finish(null,parsed);});
   response.on('error',()=>finish(new UnifiError('unreachable')));
   response.on('aborted',()=>finish(new UnifiError('unreachable')));
  });
  request.on('error',()=>finish(new UnifiError('unreachable')));
  request.end();
 });
}
