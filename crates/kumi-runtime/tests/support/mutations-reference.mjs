import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {homedir} from 'node:os';
const original=new URL('../../../../packages/runtime/dist/src/integrations/ableton/index.js',import.meta.url),file=new URL('index.mutations-oracle.js',original);
let source=readFileSync(original,'utf8');
const marker='    return {\n        async start(signal) {\n            if (closed || started)';
if(!source.includes(marker))throw Error('source hook changed');
source=source.replace(marker,`    return {
      async _ready(c){await tools.refresh(new AbortController().signal);available=c.available??true;lost=c.lost??false;currentEpoch=c.noEpoch?undefined:7;currentTempo=120;changesThisTurn=c.count??0;project=c.project;for(const [r,k] of c.refs??[])refs.set(r,k);for(const r of c.shorts??[])shortRef(r);for(const [r,t] of c.known??[])known.set(r,t);for(const [k,v] of c.cursors??[])cursors.set(k,v);for(const sample of c.samples??[])samples.set(sample.path,sample);},
      _bump(){observationGeneration++;},
      async _op(op,signal){const run=()=>op.action?act(ACTIONS.find(k=>k.tool===op.tool),op.input,signal,op.cleanup??false):change(CHANGES.find(k=>k.tool===op.tool),op.input,signal,op.settled??false);return op.quiet?quietly([],run):run();},
      _state(){return{changes:[...changes.values()],changesThisTurn,refs:[...refs],known:[...known],names:[...shortRefs],cursors:[...cursors],tempo:currentTempo,lease:observationGeneration,found:[...fastFound]};},
      async start(signal){if(closed||started)`);
writeFileSync(file,source);
const wrap=value=>({content:[{type:'text',text:JSON.stringify(value)}],...(value&&typeof value==='object'&&!Array.isArray(value)?{structuredContent:value}:{})});
const norm=value=>JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g,'<uuid>').replace(/\bc\d+\b/g,'<change>').split(homedir()).join('<home>'));
const refs=[['7:track:0','track'],['7:track:1','track'],['7:track:2','track'],['7:scene:0','scene'],['7:scene:1','scene'],['7:clip_slot:1:0','clip-slot'],['7:device:0:0','device'],['7:parameter:7:device:0:0:1','parameter'],['7:device:1:0','device'],['7:mixer:0:volume','parameter']];
const base={refs,shorts:refs.map(r=>r[0]),known:[['7:track:0',{name:'Bass',color:'#ff0000'}],['7:track:1',{name:'Lead'}]],cursors:[['next','device']]};
const change=(tool,input={},extra={})=>({tool,input,...extra}),action=(tool,input={},extra={})=>({tool,input,action:true,...extra});
const cases=[];
try{
 const {createAbletonIntegration}=await import(file.href);
 const {CHANGES}=await import(new URL('changes.js',original));
 const {ACTIONS}=await import(new URL('actions.js',original));
 const toolNames=[...new Set(['live_status','live_discover','live_run_python','live_session_emergency_stop',...CHANGES.flatMap(k=>[k.preview,k.apply]),...ACTIONS.flatMap(k=>[k.preview,k.apply])])];
 async function run(label,provided,operations){
  const config={...base,...provided},calls=[],responses=[],events=[],actions=[],results=[],disks=[];let controller,integration;let listCalls=0;
  const endpoint={pid:null,serverInfo:{name:'fixture',version:config.version??'1.0.73'},async list(){listCalls++;return{tools:toolNames.filter(n=>!(config.missing??[]).includes(n)&&!(listCalls===1&&(config.initiallyMissing??[]).includes(n))).map(name=>({name,inputSchema:{type:'object'}}))};},async call(name,args,signal){
   signal.throwIfAborted();const at=calls.length;calls.push({name,args:structuredClone(args)});let stage=name==='live_status'?'status':name==='live_discover'?'discover':name.endsWith('_preview')?'preview':name.endsWith('_apply')?'apply':'other';
   let response=config.responses?.[at]??config.fail?.[stage];
   if(!response){let value;
    if(stage==='status')value=config.status??{connected:true,epoch:7};
    else if(stage==='discover')value=config.discover??{epoch:7,items:args.kind==='session-state'?[{transport:{playing:false}}]:args.kind==='parameter'?[{ref:'7:parameter:7:device:0:0:1',name:'Drive',min:0,max:1,value:.5,displayValue:'3 dB'}]:args.kind==='device'?[{ref:'7:device:0:0',name:'Effect',className:'AudioEffect'}]:[]};
    else if(stage==='preview')value=config.preview??{epoch:7,transactionId:'tx',confirmation:'yes',priorTempo:120,proposedTempo:130,prior:{tracks:[{},{}],scenes:[{}]},proposed:[]};
    else if(stage==='apply')value=config.applied??{state:'applied'};
    else value={state:'stopped'};
    response={reply:wrap(value)};
   }
   responses.push(structuredClone(response));if(response.cancel)controller.abort();if(response.bump)integration._bump();if(response.throw)throw Error(response.throw);return response.reply;
  },onCatalogChanged(){return()=>{}},onDisconnect(){return()=>{}},stderrStatus(){return{bytes:0,truncated:false}},async close(){}};
  integration=createAbletonIntegration({connect:async()=>endpoint,onConnection(){},onChange:r=>events.push(r),onAction:r=>actions.push(r),lowDisk:async(...args)=>{disks.push(args);return config.disk;},now:()=>new Date('2026-10-03T12:00:00Z'),generation:'connection',fast:false,changeTimeoutMs:50});
  await integration.start(new AbortController().signal);await integration._ready(structuredClone(config));
  for(const op of operations){controller=new AbortController();if(op.abort)controller.abort();let value;try{value=await integration._op(op,controller.signal);}catch(e){value={error:e.name==='AbortError'?'cancelled':e.message};}results.push(structuredClone({value,state:integration._state()}));}
  await integration.close();cases.push(norm({label,config,operations,calls,responses,events,actions,disks,results,listCalls}));
 }
 for(const kind of CHANGES)await run('kind-'+kind.tool,{},[change(kind.tool)]);
 for(const config of [{available:false},{lost:true},{noEpoch:true},{count:5000},{missing:['live_tempo_preview']},{initiallyMissing:['live_tempo_apply']},{status:{connected:false}},{status:{connected:true,epoch:8}},{status:{}},{fail:{status:{throw:'private bridge failure'}}}])await run('guard',config,[change('set_tempo',{tempo:130})]);
 await run('old-bridge',{version:'1.0.1'},[change('delete_device',{ref:'device:1'})]);
 await run('stale-ref',{},[change('rename',{kind:'track',ref:'7:track:99',name:'New'})]);
 for(const op of [{abort:true},{settled:true},{quiet:true}])await run('mode',{},[change('set_tempo',{tempo:130},op)]);
 for(const preview of [{},{epoch:8,transactionId:'tx',confirmation:'yes'},{transactionId:2,confirmation:'yes'},{transactionId:'',confirmation:'yes'},{transactionId:'t'.repeat(257),confirmation:'yes'},{transactionId:'😀'.repeat(128),confirmation:'😀'.repeat(256)},{transactionId:'tx',confirmation:'c'.repeat(513)},[]])await run('preview-shape',{preview},[change('set_tempo',{tempo:130})]);
 for(const stage of ['preview','apply'])for(const response of [{throw:'private bridge failure'},{reply:{isError:true,content:[{type:'text',text:'refused'}]}},{reply:{isError:true,content:[{type:'text',text:'uncertain mutation'}]}},{reply:{isError:true,content:[],structuredContent:{state:'uncertain'}}},{reply:{content:[{type:'text',text:'malformed'}]}},{cancel:true,reply:wrap(stage==='preview'?{transactionId:'tx',confirmation:'yes'}:{state:'applied'})},{bump:true,reply:wrap(stage==='preview'?{transactionId:'tx',confirmation:'yes'}:{state:'applied'})}])await run('failure-'+stage,{fail:{[stage]:response}},[change('set_tempo',{tempo:130})]);
 for(const applied of [{},{state:'pending'},[],{state:'applied',blob:'😀'.repeat(5000)},{state:'applied',created:[{kind:'track',ref:'7:track:1',name:'New'}]}])await run('apply-shape',{applied},[change('set_tempo',{tempo:130})]);
 await run('rename-history',{preview:{transactionId:'tx',confirmation:'yes',target:{kind:'track',ref:'7:track:0',currentName:'Bass'},proposedName:'Sub'}},[change('rename',{kind:'track',ref:'track:1',name:'Sub'}),change('set_mixer',{trackRef:'track:1',volume:.7})]);
 await run('color-history',{preview:{transactionId:'tx',confirmation:'yes',ref:'7:track:0',prior:{color:'#ff0000'},proposed:{color:'#00ff00'}}},[change('set_track_color',{ref:'track:1',colorIndex:3})]);
 for(const created of [[{kind:'track',ref:'7:track:1',name:'New'}],[{kind:'scene',ref:'7:scene:1',name:'Chorus'}],[{kind:'track',ref:'7:track:1',name:'New'},{kind:'scene',ref:'7:scene:0'}],[{kind:'other',ref:'unrecognized'}],[],[null]])await run('structure',{applied:{state:'applied',created}},[change('add_tracks_and_scenes',{tracks:[{name:'New'}],scenes:[{name:'Chorus',index:0}]}),change('set_mixer',{trackRef:'track:1',volume:.7})]);
 await run('append-shape',{},[change('add_tracks_and_scenes',{tracks:[null,{}, {index:null}],scenes:[{}]})]);
 await run('append-refusal',{responses:[{reply:wrap({connected:true,epoch:7})},{reply:{isError:true,content:[]}}]},[change('add_tracks_and_scenes',{tracks:[{}]})]);
 for(const tool of ['move_device','move_device_to','delete_device'])for(const config of [{},{missing:['live_discover']}])await run('device-shift',config,[change(tool,tool==='move_device'?{deviceRef:'device:1',index:1}:tool==='move_device_to'?{deviceRef:'device:1',targetTrackRef:'track:2'}:{ref:'device:1'})]);
 await run('produced-ref',{applied:{state:'applied',clipRef:'7:clip:0:0'}},[change('write_midi_clip',{trackRef:'track:1',sceneIndex:0,length:4,notes:[{pitch:60,start:0,duration:1}]})]);
 for(const fail of [undefined,{preview:{reply:{isError:true,content:[{type:'text',text:'parameter range error'}]}}},{discover:{reply:{content:[{type:'text',text:'bad JSON'}]}}}])await run('prepared-parameters',{...(fail?{fail}:{})},[change('set_device_parameter',{deviceRef:'device:1',parameter:'Drive',value:.8})]);
 for(const kind of ACTIONS)await run('action-'+kind.tool,{},[action(kind.tool)]);
 for(const config of [{available:false},{lost:true},{noEpoch:true},{version:'1.0.1'},{missing:['live_recording_preview']},{disk:'Disk nearly full'}])await run('action-guard',config,[action('record',{action:'start',destinationTrackRef:'track:1'})]);
 for(const op of [{},{abort:true},{cleanup:true},{quiet:true}])await run('action-mode',{},[action('play',{action:'start'},op)]);
 await run('action-newer',{version:'1.0.34'},[action('play',{action:'back-to-arrangement'}),action('play',{action:'back-to-arrangement'},{cleanup:true})]);
 await run('action-stale-ref',{},[action('select',{trackRef:'7:track:99'}),action('select',{trackRef:'7:track:99'},{cleanup:true})]);
 await run('samples-cached',{samples:[{name:'Kick',path:'/fixture/kick.wav',folder:'/fixture',bytes:1000}]},[change('load_sample',{trackRef:'track:1',sample:'/fixture/kick.wav'}),change('load_sample_to_pad',{deviceRef:'device:1',note:36,sample:'/fixture/kick.wav',instrument:'Drum Sampler'}),change('load_samples_to_pads',{deviceRef:'device:1',pads:[{note:36,sample:'/fixture/kick.wav'},{note:37,sample:'/fixture/kick.wav'}]})]);
 for(const preview of [{},{transactionId:'',confirmation:'yes'},{transactionId:'tx',confirmation:3},{transactionId:'t'.repeat(600),confirmation:'c'.repeat(600)}])await run('action-preview-shape',{preview},[action('play',{action:'start'})]);
 for(const stage of ['preview','apply'])for(const response of [{throw:'private failure'},{reply:{isError:true,content:[{type:'text',text:'refused'}]}},{reply:{isError:true,content:[{type:'text',text:'uncertain'}]}},{reply:{content:[{type:'text',text:'bad JSON'}]}},{cancel:true,reply:wrap(stage==='preview'?{transactionId:'tx',confirmation:'yes'}:{state:'applied'})},{bump:true,reply:wrap(stage==='preview'?{transactionId:'tx',confirmation:'yes'}:{state:'applied'})}])await run('action-failure-'+stage,{fail:{[stage]:response}},[action('play',{action:'start'})]);
 for(const tool of ['play','record'])for(const missing of [[],['live_session_emergency_stop']])await run('stop-fallback',{missing,fail:{preview:{reply:{isError:true,content:[{type:'text',text:'ordinary stop refused'}]}}}},[action(tool,{action:'stop'})]);
 for(const alsoTrackRefs of [[],['track:2']])await run('disarm-before-record',{discover:{epoch:7,items:[{ref:'7:track:0',name:'Bass',armed:true},{ref:'7:track:1',name:'Lead',armed:true},{ref:'7:track:2',name:'Pad',armed:true}]}},[action('record',{action:'start',lane:'arrangement',destinationTrackRef:'track:1',alsoTrackRefs})]);
 await run('disarm-refused',{discover:{epoch:7,items:[{ref:'7:track:1',name:'Lead',armed:true}]},fail:{preview:{reply:{isError:true,content:[{type:'text',text:'refused'}]}}}},[action('record',{action:'start',destinationTrackRef:'track:1'})]);
 await run('record-saved-project',{project:{identity:'id',path:'/fixture/My Set.als',name:'My Set'}},[action('record',{action:'start'})]);
 const values=[],ids=new Map();for(const c of cases)c.responses=c.responses.map(v=>{const key=JSON.stringify(v);if(!ids.has(key)){ids.set(key,values.length);values.push(v);}return ids.get(key);});
 writeFileSync(new URL('mutations-oracle.json',import.meta.url),JSON.stringify({toolNames,cases,values})+'\n');console.log(cases.length+' source change/action sequences');
}finally{unlinkSync(file)}
