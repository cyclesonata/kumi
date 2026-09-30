import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { McpHost, PROTOCOL_VERSION } from '../src/host.js';
import { DeterministicLiveSimulator, type LiveStatus, type LiveInvocation, type LiveOperationContext } from '../src/live.js';
class DeviceSimulator extends DeterministicLiveSimulator {
  names = { 'macro-name':'Macro 1', 'variation-name':'Variation 1' };
  mapping: unknown = null;
  override status(): LiveStatus { const s = super.status(); return {...s, operations:[...s.operations!, 'willington.device.read','willington.device.set']}; }
  override invoke(invocation: LiveInvocation): unknown {
    if (!invocation.operation.startsWith('willington.device.')) return super.invoke(invocation);
    const args = invocation.args as any; const kind = args.kind as keyof typeof this.names;
    const read = () => { const state = kind === ('macro-mapping' as any) ? {mapping:JSON.stringify(this.mapping),parameterValue:0.5,parameterMin:0,parameterMax:1,macroValues:'[0]',targetIdentity:'target',deviceIdentity:'rack'} : {name:this.names[kind],deviceIdentity:'rack'}; return {state,stateRevision:createHash('sha256').update(JSON.stringify(state)).digest('hex')}; };
    if (invocation.operation === 'willington.device.read') return read();
    assert.equal(args.expectedStateRevision,read().stateRevision);
    if (kind === ('macro-mapping' as any)) this.mapping=args.next.mapping;
    else this.names[kind] = args.next.name;
    return {changed:true,revision:1,...read()};
  }
}
function fixture(adapter = new DeviceSimulator()) {
  const host = new McpHost(adapter);
  host.handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'test',version:'1'}}});
  host.handle({jsonrpc:'2.0',method:'notifications/initialized'}); let id=2;
  const call = async(name:string,args:object) => { const reply = await host.handleAsync({jsonrpc:'2.0',id:id++,method:'tools/call',params:{name,arguments:args}}) as any; if(reply.error || reply.result?.isError) throw new Error(JSON.stringify(reply)); return JSON.parse(reply.result.content[0].text); };
  return {adapter,call};
}
for (const edit of [{kind:'macro-name',macroIndex:0,name:'New macro'},{kind:'variation-name',name:'New variation'},{kind:'macro-mapping',targetRef:'target',mappingIndex:0,minimum:0.75,maximum:0.25,mappingKind:'continuous'}]) {
  test(`Willington ${edit.kind} preview/apply/history undo`,async()=>{
    const {adapter,call}=fixture(); const original=JSON.stringify([adapter.names,adapter.mapping]);
    const preview=await call('live_willington_device_preview',{ref:'rack',...edit});
    const apply={transactionId:preview.transactionId,confirmation:'apply',idempotencyKey:'device-apply-1'};
    await call('live_willington_device_apply',apply);
    assert.equal((await call('live_willington_device_apply',apply)).idempotent,true);
    const undo={transactionId:preview.transactionId,confirmation:'undo',idempotencyKey:'device-undo-1'};
    await call('live_undo',undo);
    assert.equal(JSON.stringify([adapter.names,adapter.mapping]),original);
    assert.equal((await call('live_undo',undo)).idempotent,true);
  });
}
test('Willington refuses stale apply and external changes before undo',async()=>{
  const {adapter,call}=fixture(); const preview=await call('live_willington_device_preview',{ref:'rack',kind:'macro-name',macroIndex:0,name:'New'});
  adapter.names['macro-name']='External';
  await assert.rejects(call('live_willington_device_apply',{transactionId:preview.transactionId,confirmation:'apply',idempotencyKey:'stale-apply-1'}),/changed/);
  const fresh=await call('live_willington_device_preview',{ref:'rack',kind:'macro-name',macroIndex:0,name:'New'});
  await call('live_willington_device_apply',{transactionId:fresh.transactionId,confirmation:'apply',idempotencyKey:'fresh-apply-1'});
  adapter.names['macro-name']='Later external';
  await assert.rejects(call('live_undo',{transactionId:fresh.transactionId,confirmation:'undo',idempotencyKey:'stale-undo-1'}),/changed/);
});

class LostDeviceAcknowledgement extends DeviceSimulator {
  cache=new Map<string, unknown>(); failNext=true;
  override async invokeAsync(invocation:LiveInvocation,context?:LiveOperationContext):Promise<unknown> {
    if(invocation.operation!=='willington.device.set') return super.invokeAsync(invocation);
    const key=context?.idempotencyKey??'';
    if(this.cache.has(key)) return this.cache.get(key);
    const result=this.invoke(invocation);this.cache.set(key,result);
    if(this.failNext){this.failNext=false;throw new Error('Injected lost acknowledgement');}
    return result;
  }
}
test('Willington recovers apply and undo only with the exact key',async()=>{
  const adapter=new LostDeviceAcknowledgement();const {call}=fixture(adapter);
  const preview=await call('live_willington_device_preview',{ref:'rack',kind:'macro-name',macroIndex:0,name:'New'});
  const apply={transactionId:preview.transactionId,confirmation:'apply',idempotencyKey:'lost-device-apply'};
  await assert.rejects(call('live_willington_device_apply',apply));
  await assert.rejects(call('live_willington_device_apply',{...apply,idempotencyKey:'different-device-key'}));
  await call('live_willington_device_apply',apply);
  adapter.failNext=true;
  const undo={transactionId:preview.transactionId,confirmation:'undo',idempotencyKey:'lost-device-undo'};
  await assert.rejects(call('live_undo',undo));await call('live_undo',undo);
  assert.equal(adapter.names['macro-name'],'Macro 1');
});
