// The unifi plugin's settings: site.json → plugins.unifi. Which UniFi gateway the hub asks, on which port, which UniFi
// site, how its certificate is trusted, where the API key file is, how often it is read and how long a census stays fresh.
//   {"host": "10.0.0.1", "port": 443, "site": "default", "fingerprint": "<sha-256 of the certificate>",
//    "keyFile": "unifi/api-key", "intervalSeconds": 60, "staleAfterSeconds": 180, "timeoutSeconds": 10}
// Only host is needed. No section at all = the plugin is loaded but inert (no adapter, nothing is contacted).
// Strict: an unknown field or a wrong value stops the start, by name. The API key itself is never here: it is the
// Integrations page's write-only field, or the file keyFile names, relative to the instance's private directory.

const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const fail=message=>{throw new Error(`site config: plugins.unifi.${message}`);};
const HOST=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$/;
const IPV4=/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const SITE=/^[A-Za-z0-9_-]{1,64}$/;
const KEY_FILE=/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const FIELDS=['$comment','host','port','site','fingerprint','keyFile','intervalSeconds','staleAfterSeconds','timeoutSeconds'];

const int=(v,where,min,max)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail(`${where} must be a whole number from ${min} to ${max}`);return v;};

// "AB:CD:…" (as openssl and browsers print it) or 64 hex characters → 64 lowercase hex characters.
export function normalizeFingerprint(v){
 if(typeof v!=='string')return null;
 const hex=v.trim().toLowerCase().replace(/^sha256[:=]/,'').replaceAll(':','');
 return /^[0-9a-f]{64}$/.test(hex)?hex:null;
}

/**
 * site.json → plugins.unifi → frozen {host, port, site, fingerprint, keyFile, intervalSeconds, staleAfterSeconds,
 * timeoutSeconds}, or null when the section is absent (the plugin stays inert). site is null for "the first site the
 * gateway lists"; fingerprint null for "verify against the system's certificate authorities"; keyFile null for "only the
 * Integrations page's field".
 */
export function readUnifiConfig(raw){
 if(raw===undefined||raw===null)return null;
 if(!plain(raw))fail('(the section) must be an object');
 const extra=Object.keys(raw).filter(k=>!FIELDS.includes(k));if(extra.length)fail(`(the section) has unknown field(s): ${extra.join(', ')}`);
 if(raw.host===undefined)fail('host is required');
 if(typeof raw.host!=='string'||raw.host.length>253||!(IPV4.test(raw.host)||(HOST.test(raw.host)&&!/^[\d.]+$/.test(raw.host))))fail('host must be an IPv4 address or a host name (no scheme, port or path)');
 const port=raw.port===undefined?443:int(raw.port,'port',1,65535);
 if(raw.site!==undefined&&(typeof raw.site!=='string'||!SITE.test(raw.site)))fail('site must be a UniFi site name, reference or id such as "default"');
 let fingerprint=null;
 if(raw.fingerprint!==undefined){fingerprint=normalizeFingerprint(raw.fingerprint);if(!fingerprint)fail('fingerprint must be the SHA-256 of the gateway certificate: 64 hex characters, colons allowed');}
 let keyFile=null;
 if(raw.keyFile!==undefined){
  if(typeof raw.keyFile!=='string'||raw.keyFile.length>200||!KEY_FILE.test(raw.keyFile)||raw.keyFile.split('/').some(p=>p==='..'||p==='.'))
   fail('keyFile must be a path relative to the private directory, such as "unifi/api-key" (no leading /, no ..)');
  keyFile=raw.keyFile;
 }
 const intervalSeconds=raw.intervalSeconds===undefined?60:int(raw.intervalSeconds,'intervalSeconds',30,3600);
 // Core accepts an adapter's staleAfterSeconds from 60 s to a day; a census must outlive at least one interval.
 const staleAfterSeconds=raw.staleAfterSeconds===undefined?Math.min(86400,Math.max(180,intervalSeconds*3)):int(raw.staleAfterSeconds,'staleAfterSeconds',60,86400);
 if(staleAfterSeconds<intervalSeconds)fail('staleAfterSeconds must not be shorter than intervalSeconds');
 const timeoutSeconds=raw.timeoutSeconds===undefined?10:int(raw.timeoutSeconds,'timeoutSeconds',1,60);
 return Object.freeze({host:raw.host,port,site:raw.site??null,fingerprint,keyFile,intervalSeconds,staleAfterSeconds,timeoutSeconds});
}
