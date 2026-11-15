import http from 'node:http';
export function bridgeClient(socketPath){
 return (pathname,method='GET',input)=>new Promise((resolve,reject)=>{
  const url=new URL(pathname,'http://localhost');
  if(method==='GET'&&input)for(const [k,v] of Object.entries(input))url.searchParams.set(k,v);
  const body=method==='POST'?JSON.stringify(input):null;
  const req=http.request({socketPath,path:url.pathname+url.search,method,headers:body?{'Content-Type':'application/json'}:{}},res=>{
   const chunks=[];let size=0;
   res.on('data',b=>{size+=b.length;if(size>2097152)res.destroy(new Error('too-large'));else chunks.push(b);});
   res.on('error',reject);res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('unavailable');resolve(JSON.parse(Buffer.concat(chunks)));}catch(e){reject(e);}});
  });
  req.setTimeout(30000,()=>req.destroy(new Error('timeout')));req.on('error',reject);req.end(body);
 });
}
