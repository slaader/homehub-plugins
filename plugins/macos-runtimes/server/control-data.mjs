export function controlAction(input,definitions=[]){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['id','action','requestId'].includes(k))||!definitions.some(s=>s.id===input.id)||!['start','stop','restart'].includes(input.action)||typeof input.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(input.requestId))throw new Error('invalid');
 return {id:input.id,action:input.action,requestId:input.requestId};
}
export function controlState(raw,definitions=[]){
 if(!raw||!Array.isArray(raw.services)||!Number.isFinite(Date.parse(raw.observedAt)))throw new Error('unavailable');
 return {observedAt:raw.observedAt,services:definitions.map(s=>{const r=raw.services.find(x=>x.id===s.id);return {id:s.id,name:s.name,impact:s.impact,state:['running','stopped','waiting','not-installed'].includes(r?.state)?r.state:'unavailable',pid:Number.isSafeInteger(r?.pid)&&r.pid>0?r.pid:null};})};
}
