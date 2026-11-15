import assert from 'node:assert/strict';
import { BrowserSessionsService } from '/Users/andrew/dev/threadkeeper/paperclip/packages/plugins/plugin-browser-sessions/src/service.ts';
import { MemoryStore } from '/Users/andrew/dev/threadkeeper/paperclip/packages/plugins/plugin-browser-sessions/src/store.ts';
const store=new MemoryStore();
const host={config:{get:async()=>({})},issues:{},agents:{},secrets:{},activity:{log:async()=>{}},events:{emit:async()=>{}}};
const service=new BrowserSessionsService({store,host:host as never});
try {
 const state=await service.state('company');state.tokenHash='paired';state.shared=true;await service.saveState('company',state);
 await store.put('session','company','private',{threadKey:'private',provider:'claude',title:'PRIVATE TITLE'});
 service.request=async()=>{await store.remove('session','company','private');return {threads:[{thread:{threadKey:'private',title:'PRIVATE TITLE'},passages:[{text:'PRIVATE TRANSCRIPT'}]}],passages:[{threadKey:'private',text:'PRIVATE TRANSCRIPT'}]};};
 const result=await service.executeTool('sessions_context',{question:'question'},{companyId:'company',agentId:'agent',runId:'run',projectId:''});
 console.log(JSON.stringify({topLevelPassages:(result.data as any)?.passages,leakedPrivate:JSON.stringify(result.data).includes('PRIVATE')}));
 assert.equal(JSON.stringify(result.data).includes('PRIVATE'),false,'Removed session must not survive in nested context payload');
} finally {service.close();}
