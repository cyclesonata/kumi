import {writeFileSync} from 'node:fs';
import {CHANGES} from '../../../../packages/runtime/dist/src/integrations/ableton/changes.js';
import {MORE_CHANGES} from '../../../../packages/runtime/dist/src/integrations/ableton/more-changes.js';
const tracks={'t1':{name:'Bass',color:'#c08040'},'7:track:2':{name:'Kick'},'empty':{name:'',color:''}};
const cases=[];
const add=(tool,preview={},input={},applied)=>{const kind=CHANGES.find(k=>k.tool===tool);cases.push({tool,preview,input,...(applied===undefined?{}:{applied}),value:kind.summarize(preview,input,ref=>tracks[ref],applied)});};
for(const kind of CHANGES.filter(k=>!MORE_CHANGES.includes(k)))add(kind.tool);
const fields=[null,false,'',0,1,-1,0.33333,'  padded  ',[],{}];
for(const v of fields){
 add('set_tempo',{priorTempo:v,proposedTempo:123.12345});add('set_tempo',{priorTempo:140,proposedTempo:v});
 add('set_mixer',{trackRef:'t1',prior:{volume:.85},proposed:{volume:v,pan:v,mute:v,solo:v,cueVolume:v,sends:v}});
 add('rename',{target:{kind:'track',ref:'t1',currentName:v},proposedName:v},{name:'fallback',ref:'t1'});
 add('set_device_parameter',{device:{name:v,trackRef:'t1'},parameter:{name:v,currentValue:v,proposedValue:.6,min:0,max:1,displayValue:v}},{value:.3},{displayValue:'-6 dB'});
 add('load_device',{trackRef:'t1',chainName:'Chain',rackName:v,item:{name:v}},{},{placement:{devices:['Operator',v],index:v,chain:v,rack:v,chains:[{name:v,devices:[v,'Operator']}]}});
 add('set_track_color',{ref:'t1'},{},{color:v});
}
for(const parts of [{}, {volume:.5,pan:-.5,mute:true,solo:false,cueVolume:0,sends:[0,.5]}, {volume:.85,pan:0,mute:false,solo:true,sends:[.1]}, {volume:1,pan:1,sends:[.1,.2]}])for(const display of [false,true]){
 add('set_mixer',{trackRef:'t1',prior:{volume:.85},proposed:parts,...(display?{priorDisplay:{volume:' 0.0 dB ',pan:'Center',sends:['-inf dB','0.0 dB']}}:{})},{},display?{display:{volume:'-6.0 dB',pan:'50 L',sends:['-6.0 dB','0.0 dB']}}:{});
 for(const chainActivator of [true,false,null])add('set_chain_mixer',{rackName:' Rack ',chainName:'Ch 1',prior:{volume:.85},proposed:{...parts,chainActivator}});
}
for(const proposed of [[],[{kind:'track',trackKind:'audio',name:'Voice'}],[{kind:'track'}],[{kind:'scene',name:'Drop'}],[{kind:'track'},{kind:'track',trackKind:'audio'},{kind:'scene'}],[{kind:'unknown'},null]])add('add_tracks_and_scenes',{proposed});
for(const kind of ['clip','device','scene','track',null])add('rename',{target:{kind,ref:'t1',currentName:'Old'},proposedName:' New '});
for(const notes of [[],[{pitch:60,start:0,duration:1},{pitch:64,start:.25,duration:2,velocity:50}], [{pitch:60,start:0,duration:0},{pitch:'60',start:0,duration:1},null,{}, {pitch:-3,start:-1,duration:.5,velocity:0}],Array.from({length:520},(_,i)=>({pitch:i%128,start:i/4,duration:1}))])for(const length of [0,8,null])add('write_midi_clip',{target:{trackRef:'t1'},proposed:{name:' Tune ',length,notes}},{name:'Fallback',length:4,notes:[{pitch:42,start:0,duration:1}]});
for(const filePath of ['/a/Kick.wav','C:\\Drums\\Hat.v2.aif','/a/noext','/a/end.','.wav','/a/name.\n',null]){add('load_sample',{}, {trackRef:'t1',filePath});for(const note of [undefined,36,37.5,-1])add('load_sample_to_pad',{}, {filePath,note,instrument:'Drum Sampler'});}
for(const notes of [[],[36],[36,37,38],[36,40],[-1,.5],[36,null]])for(const drum of [true,false])add('load_samples_to_pads',{}, {pads:notes.map((note,i)=>({note,filePath:`/samples/Pad ${i}.wav`,...(drum?{instrument:'Drum Sampler'}:{})}))});
for(const action of ['insert-chain','randomize-macros','store-variation','recall-variation','delete-variation','set','copy-pad','add-macro','remove-macro'])for(const applied of [{},{visibleMacroCount:5},{placement:{rack:'Rack',chain:1,chains:[{name:'x',devices:['Operator']}]}}])add('edit_rack',{rackName:'Old Rack',prior:{visibleMacroCount:4}},{action,index:2,sourceIndex:36,targetIndex:42},applied);
for(const parameters of [[],[{ref:'p',name:'Drive',currentValue:0,proposedValue:1,displayValue:'0.0 dB'}],[{ref:'a',name:'Cutoff',currentValue:800,proposedValue:800},{ref:'b',name:'Resonance',currentValue:0,proposedValue:1}], [null,{name:'Old',currentValue:1,proposedValue:0},{ref:'p',name:'Name',displayValue:'  old  '}]] )for(const tool of ['set_device_parameter','set_device_parameters'])add(tool,{device:{name:' Filter ',trackRef:'t1'},parameters},{values:[{},{}]},{parameters:[{ref:'p',displayValue:'wrong'},{ref:'p',displayValue:'-6.0 dB'},{displayValue:' New '}]});
for(const color of [-1,0,16777215,16777216,1.5,123456])add('set_track_color',{}, {ref:'t1'},{color});
for(const input of [{},{start:0,end:32,startName:'Intro',endName:'Drop'}, {start:1.005,end:1.99999}, {startName:'x'.repeat(100),endName:'　'}])add('set_locators',{},input);
for(const deviceRef of ['7:device:2','7:device:2:chain:1','bad',null])for(const action of ['sidechain','routing'])add('set_sidechain',{}, {deviceRef,action,routingType:'Kick'});
writeFileSync(new URL('./change-summaries-oracle.json',import.meta.url),JSON.stringify({tracks,cases})+'\n');
