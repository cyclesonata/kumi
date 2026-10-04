import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const base=new URL('.',pathToFileURL(process.argv[2]));
const {McpHost}=await import(new URL('host.js',base));
const {DeterministicLiveSimulator}=await import(new URL('live.js',base));
const init={jsonrpc:'2.0',id:'setup',method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'oracle',version:'1'}}};
const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}};
const clean=value=>{
 if(typeof value==='string'&&/^(tempo|parameter|parameters|structure|arrangement|rename|transport|change|noteupdate|notedelete|routing|capturemidi|scenecapture|clipdup|arrclip|clipmove)_[A-Za-z0-9_-]+$/.test(value))return value.split('_')[0]+'_<id>';
 if(Array.isArray(value))return value.map(clean);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,['expiresAt','sampledAt'].includes(key)?'<time>':key==='text'&&typeof v==='string'?(()=>{try{return clean(JSON.parse(v))}catch{return v}})():clean(v)]));
 return value;
};
const cases=[];
async function run(label,operations,{modern=false,sync=false,policy}={}){
 const sim=new DeterministicLiveSimulator(),host=new McpHost(sim,{...(policy?{toolPolicy:policy}:{})}),results=[];let tx,seq=0;
 if(!modern){host.handle(init);host.handle({jsonrpc:'2.0',method:'notifications/initialized'});}
 for(const op of operations){
  if(op.policy){host.setToolPolicy(op.policy);results.push({policy:true});continue;}
  const args=JSON.parse(JSON.stringify(Object.hasOwn(op,'args')?op.args:{}).replaceAll('"$tx"',JSON.stringify(tx??'missing')));
  const request={jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name:op.tool,arguments:args,...(modern?{_meta:meta}:{})}};
  const controller=new AbortController();if(op.abort)controller.abort();
  try{const result=sync?host.handle(request):await host.handleAsync(request,controller.signal);results.push(clean(result));
   try{const body=JSON.parse(result.result.content[0].text);if(body.transactionId)tx=body.transactionId}catch{}
  }catch(e){results.push({error:e.message});}
 }
 cases.push({label,operations,modern,sync,...(policy?{policy}:{}),results,state:clean(sim.state)});
}
const tools=['live_routing_preview','live_routing_apply','live_capture_midi_preview','live_capture_midi_apply','live_scene_capture_preview','live_scene_capture_apply','live_status','live_snapshot','live_discover','live_note_read','live_song_state','live_performance_read','live_data_read','live_device_read','live_browser_roots','live_browser_inspect','live_automation_read','live_message','live_observe_poll','live_subscribe','live_unsubscribe','live_tempo_preview','live_tempo_apply','live_session_structure_preview','live_session_structure_apply','live_device_parameter_preview','live_device_parameter_apply','live_object_rename_preview','live_object_rename_apply','live_arrangement_section_preview','live_arrangement_section_apply','live_undo','live_transaction_release','live_recovery_finalize','live_undo_step_begin','live_undo_step_end','live_song_undo','live_song_redo','live_change'];
for(const modern of [false,true])for(const tool of tools)for(const args of [null,{},[],{extra:true}])await run('validation',[{tool,args}],{modern});
for(const modern of [false,true])for(const sync of [false,true])await run('tempo',[{tool:'live_tempo_preview',args:{tempo:130}},{tool:'live_tempo_apply',args:{transactionId:'$tx',confirmation:'apply',idempotencyKey:'apply-key'}},{tool:'live_undo',args:{transactionId:'$tx',confirmation:'undo',idempotencyKey:'undo-key'}},{tool:'live_transaction_release',args:{transactionIds:['$tx']}}],{modern,sync});
for(const modern of [false,true])await run('fused-tempo',[{tool:'live_change',args:{tool:'live_tempo_preview',args:{tempo:135},idempotencyKey:'fused-key'}},{tool:'live_change',args:{tool:'live_tempo_preview',args:{tempo:135},idempotencyKey:'fused-key'}},{tool:'live_change',args:{tool:'live_tempo_preview',args:{tempo:136},idempotencyKey:'fused-key'}},{tool:'live_undo',args:{transactionId:'$tx',confirmation:'undo',idempotencyKey:'undo-key'}}],{modern});
for(const tool of ['live_session_audition_preview','live_clip_launch_preview','live_audio_capture_preview','live_recording_preview','live_realtime_arm_preview','live_application_dialog_preview','live_fire_button_preview','live_missing_preview','wrong','live_change_preview'])await run('fused-rejection',[{tool:'live_change',args:{tool,args:{}}}]);
for(const args of [{tool:'live_tempo_preview',args:{tempo:20},idempotencyKey:'short'},{tool:'live_tempo_preview',args:{tempo:19}},{tool:'live_tempo_preview',args:[]},{tool:'live_tempo_preview',args:{tempo:125},extra:true},{tool:'live_tempo_preview',args:{tempo:999}}])await run('fused-input',[{tool:'live_change',args}]);
for(const types of [undefined,[],['transport'],['transport','transport'],['missing'],null,3])await run('subscriptions',[{tool:'live_subscribe',args:types===undefined?{}:{types}},{tool:'live_unsubscribe'}]);
await run('preabort',[{tool:'live_change',args:{tool:'live_tempo_preview',args:{tempo:130}},abort:true},{tool:'live_undo',abort:true},{tool:'live_status'}]);
await run('undo-policy',[{tool:'live_change',args:{tool:'live_tempo_preview',args:{tempo:140}}},{policy:{profile:'read-only'}},{tool:'live_undo',args:{transactionId:'$tx',confirmation:'undo',idempotencyKey:'undo-key'}}]);
const pool=[],seen=new Map(),intern=v=>{const k=JSON.stringify(v);if(!seen.has(k)){seen.set(k,pool.length);pool.push(v)}return seen.get(k)};
for(const c of cases){c.results=c.results.map(intern);c.state=intern(c.state)}
fs.writeFileSync(new URL('host-dispatch-oracle.json',import.meta.url),JSON.stringify({cases,pool}));
console.log(cases.length+' public dispatcher cases');
