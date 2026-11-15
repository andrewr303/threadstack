import assert from 'node:assert/strict';
import { BrowserSessionsService } from '/Users/andrew/dev/threadkeeper/paperclip/packages/plugins/plugin-browser-sessions/src/service.ts';
import { MemoryStore } from '/Users/andrew/dev/threadkeeper/paperclip/packages/plugins/plugin-browser-sessions/src/store.ts';
const store=new MemoryStore();let now=Date.now();
const host={config:{get:async()=>({})},issues:{get:async(id:string,companyId:string)=>({id,companyId})},agents:{},secrets:{},activity:{log:async()=>{}},events:{emit:async()=>{}}};
const service=new BrowserSessionsService({store,host:host as never,now:()=>now});
try {
 const state=await service.state('company');Object.assign(state,{tokenHash:'paired',shared:true,policy:{enabled:true,providers:['claude'],disabledAt:0},extensionPolicy:{enabled:true,providers:['claude'],disabledAt:0},trustedAgentIds:['agent']});await service.saveState('company',state);
 await store.put('session','company','session',{threadKey:'session',provider:'claude',title:'Session'});
 await store.put('link','company','link',{threadKey:'session',companyId:'company',issueId:'task',origin:'user'});
 const old=(id:string,days:number)=>({id,companyId:'company',agentId:'agent',runId:'old',issueId:'task',tool:'session_send',threadKey:'session',provider:'claude',accountLabel:'',text:'old',clientRequestId:id,inputHash:'old',admitted:true,status:'Delivered',createdAt:new Date(now-days*86400000).toISOString(),completedAt:new Date(now-days*86400000).toISOString(),result:{data:{delivered:true}}});
 await store.put('action','company',JSON.stringify(['agent','reused']),old('reused',3));
 await store.put('action','company',JSON.stringify(['agent','later-old']),old('later-old',2));
 service.request=async()=>({delivered:true,at:new Date(now).toISOString()});
 const run={companyId:'company',agentId:'agent',runId:'run',projectId:'',issueId:'task'};
 const first=await service.executeTool('session_send',{threadKey:'session',text:'new send',clientRequestId:'reused'},run);
 now+=1000;
 const second=await service.executeTool('session_send',{threadKey:'session',text:'second send',clientRequestId:'new'},run);
 console.log(JSON.stringify({first,second}));
 assert.match(second.error??'',/rate_limited/,'A fresh send must enforce the per-session minute after reusing an expired client ID');
}finally{service.close();}
