import http from 'node:http';
export function bridgeClient(socketPath,{timeoutMs=30000}={}){
 return (pathname,method='GET',input)=>new Promise((resolve,reject)=>{
  const url=new URL(pathname,'http://localhost');
  if(method==='GET'&&input)for(const [k,v] of Object.entries(input))url.searchParams.set(k,v);
  const body=method==='POST'?JSON.stringify(input):null;
  const finish=(error,value)=>{clearTimeout(deadline);error?reject(error):resolve(value);};
  const req=http.request({socketPath,path:url.pathname+url.search,method,agent:false,headers:body?{'Content-Type':'application/json'}:{}},res=>{
   const chunks=[];let size=0;
   res.on('data',b=>{size+=b.length;if(size>2097152)res.destroy(new Error('too-large'));else chunks.push(b);});
   res.on('error',error=>finish(error));res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('unavailable');finish(null,JSON.parse(Buffer.concat(chunks)));}catch(e){finish(e);}});
  });
  // An inactivity timeout alone lets a trickling response hold a poll forever.
  const deadline=setTimeout(()=>req.destroy(new Error('timeout')),timeoutMs);deadline.unref();
  req.on('error',error=>finish(error));req.end(body);
 });
}
