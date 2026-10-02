import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { McpHost, PROTOCOL_VERSION } from '../src/host.js';
import { DeterministicLiveSimulator, type LiveStatus, type LiveInvocation, type LiveOperationContext } from '../src/live.js';
class DeviceSimulator extends DeterministicLiveSimulator {
  names = { 'macro-name':'Macro 1', 'variation-name':'Variation 1' };
  mapping: unknown = null;
  async refreshStatusAsync(): Promise<LiveStatus> { return this.status(); }
  override status(): LiveStatus { const s = super.status(); return {...s, operations:[...s.operations!, 'willington.device.read','willington.device.set']}; }
  override invoke(invocation: LiveInvocation): unknown {
    if (!invocation.operation.startsWith('willington.device.')) return super.invoke(invocation);
    const args = invocation.args as any; const kind = args.kind as keyof typeof this.names;
    const read = () => { const state = kind === ('macro-mapping' as any) ? {mapping:JSON.stringify(this.mapping),parameterValue:0.5,parameterMin:0,parameterMax:1,macroValues:'[0]',targetIdentity:'target',deviceIdentity:'rack'} : {name:this.names[kind],deviceIdentity:'rack'}; return {state,stateRevision:createHash('sha256').update(JSON.stringify(state)).digest('hex')}; };
    if (invocation.operation === 'willington.device.read') return read();
    if (args.expectedStateRevision !== read().stateRevision) throw new Error('Willington target changed since preview or after apply; undo refused');
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
  return {adapter,call,host};
}
class ZoneSimulator extends DeviceSimulator {
  zone = {minimum:12, maximum:104, fadeMinimum:24, fadeMaximum:88};
  override invoke(invocation: LiveInvocation): unknown {
    const args = invocation.args as any;
    if (!String(args.kind).endsWith('-zone')) return super.invoke(invocation);
    const read = () => { const state = {...this.zone, lowerBound:args.kind==='velocity-zone'?1:0,
      upperBound:127, deviceIdentity:'rack', targetIdentity:'chain', rackClass:'InstrumentGroupDevice'};
      return {state,stateRevision:createHash('sha256').update(JSON.stringify(state)).digest('hex')}; };
    if (invocation.operation==='willington.device.read') return read();
    if (args.expectedStateRevision !== read().stateRevision) throw new Error('Willington target changed since preview or after apply; undo refused');
    this.zone={...args.next};
    return {changed:true,revision:1,...read()};
  }
}
for (const kind of ['selector-zone','key-zone','velocity-zone']) {
  test(`Willington ${kind} captures coupled fades and restores history`,async()=>{
    const adapter=new ZoneSimulator();const {call}=fixture(adapter);const prior={...adapter.zone};
    const preview=await call('live_willington_device_preview',{ref:'rack',targetRef:'chain',kind,
      minimum:16,maximum:40,fadeMinimum:20,fadeMaximum:36});
    assert.equal(preview.prior.fadeMaximum,88);
    const apply={transactionId:preview.transactionId,confirmation:'apply',idempotencyKey:'zone-apply-1'};
    await call('live_willington_device_apply',apply);
    assert.deepEqual(adapter.zone,{minimum:16,maximum:40,fadeMinimum:20,fadeMaximum:36});
    assert.equal((await call('live_willington_device_apply',apply)).idempotent,true);
    await call('live_undo',{transactionId:preview.transactionId,confirmation:'undo',idempotencyKey:'zone-undo-1'});
    assert.deepEqual(adapter.zone,prior);
  });
}
test('zone preview rejects no-op, crossing fades and noninteger values; apply fences all fades',async()=>{
  const adapter=new ZoneSimulator();const {call}=fixture(adapter);
  const selector={ref:'rack',targetRef:'chain',kind:'key-zone'};
  await assert.rejects(call('live_willington_device_preview',{...selector,minimum:12}),/not change/);
  await assert.rejects(call('live_willington_device_preview',{...selector,minimum:50}),/ordered/);
  await assert.rejects(call('live_willington_device_preview',{...selector,fadeMinimum:25.5}),/integers/);
  const preview=await call('live_willington_device_preview',{...selector,fadeMinimum:25});
  adapter.zone.fadeMaximum=86;
  await assert.rejects(call('live_willington_device_apply',{transactionId:preview.transactionId,confirmation:'apply',idempotencyKey:'zone-stale-apply'}),/changed/);
});
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


test("willington-device undo respects a policy changed after apply", async () => {
  const { host, adapter, call } = fixture();
  const preview = await call("live_willington_device_preview", { ref: "rack", kind: "macro-name", macroIndex: 0, name: "New" });
  await call("live_willington_device_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "policy-apply" });
  host.setToolPolicy({ profile: "full", deny: ["live_willington_device_apply"] });
  const undo = { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "policy-undo" };
  await assert.rejects(call("live_undo", undo), /deployment policy/);
  host.setToolPolicy({ profile: "full" });
  await call("live_undo", undo);
  assert.equal(adapter.names["macro-name"], "Macro 1");
});


test("willington-device undo retries after a connection failure before the restore was recorded", async () => {
  const { host, adapter, call } = fixture();
  const preview = await call("live_willington_device_preview", { ref: "rack", kind: "macro-name", macroIndex: 0, name: "New" });
  await call("live_willington_device_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "early-apply" });
  let fail = true;
  Object.assign(adapter, { refreshStatusAsync: async () => { if (fail) { fail = false; throw new Error("injected status failure"); } return adapter.status(); } });
  const undo = { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "early-undo" };
  await assert.rejects(call("live_undo", undo), /injected/);
  await call("live_undo", undo);
  assert.equal(adapter.names["macro-name"], "Macro 1");
});


test("willington-device undo retries after a failure before restore dispatch", async () => {
  const { host, adapter, call } = fixture();
  const preview = await call("live_willington_device_preview", { ref: "rack", kind: "macro-name", macroIndex: 0, name: "New" });
  await call("live_willington_device_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "early-apply" });
  let fail = true;
  const original = adapter.invokeAsync.bind(adapter);
    adapter.invokeAsync = async (invocation) => { if (fail && invocation.operation === "willington.device.set") { fail = false; throw new Error("injected read failure"); } return original(invocation); };
  const undo = { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "early-undo" };
  await assert.rejects(call("live_undo", undo), /injected/);
  await call("live_undo", undo);
  assert.equal(adapter.names["macro-name"], "Macro 1");
});


test("Willington preview reports playback and mapping validation errors without a full snapshot", async () => {
  const { adapter, call } = fixture();
  adapter.snapshotAsync = async () => { throw new Error("full snapshot forbidden"); };
  (adapter as any).state.playback.transport.playing = true;
  await assert.rejects(call("live_willington_device_preview", { ref: "rack", kind: "macro-name", macroIndex: 0, name: "New" }), /Willington edits require stopped playback/);
  (adapter as any).state.playback.transport.playing = false;
  await assert.rejects(call("live_willington_device_preview", { ref: "rack", kind: "macro-mapping", targetRef: "target", mappingIndex: 0, minimum: 3, maximum: 1, mappingKind: "continuous" }), /Mapping endpoints are outside parameter bounds/);
});

test("Willington apply retries after a status failure before dispatch", async () => {
  const { adapter, call } = fixture();
  const preview = await call("live_willington_device_preview", { ref: "rack", kind: "macro-name", macroIndex: 0, name: "New" });
  const refresh = adapter.status.bind(adapter);
  let fail = true;
  adapter.refreshStatusAsync = async () => { if (fail) { fail = false; throw new Error("injected status failure"); } return refresh(); };
  const apply = { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "retry-status" };
  await assert.rejects(call("live_willington_device_apply", apply), /injected/);
  assert.equal(adapter.names["macro-name"], "Macro 1");
  await call("live_willington_device_apply", apply);
  assert.equal(adapter.names["macro-name"], "New");
});

test("Willington apply and undo use the fenced set readback without redundant reads", async () => {
  const { adapter, call } = fixture();
  const preview = await call("live_willington_device_preview", { ref: "rack", kind: "macro-name", macroIndex: 0, name: "New" });
  const invoke = adapter.invokeAsync.bind(adapter);
  const operations: string[] = [];
  adapter.invokeAsync = async (invocation) => { operations.push(invocation.operation); return invoke(invocation); };
  await call("live_willington_device_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "minimal-apply" });
  await call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "minimal-undo" });
  assert.deepEqual(operations.filter(operation => operation.startsWith("willington.device.")), ["willington.device.set", "willington.device.set"]);
  assert.equal(adapter.names["macro-name"], "Macro 1");
});

test("common validation prefixes do not bypass path and stack filtering", async () => {
  for (const message of ["Mapping failure in /private/native/library", "Boolean failure in C:\\native\\library", "Enum failure at native_call (library)"]) {
    const { adapter, call } = fixture();
    const invoke = adapter.invokeAsync.bind(adapter);
    adapter.invokeAsync = async invocation => { if (invocation.operation === "willington.device.read") throw new Error(message); return invoke(invocation); };
    await assert.rejects(call("live_willington_device_preview", { ref: "rack", kind: "macro-name", macroIndex: 0, name: "New" }), /adapter request failed/);
  }
});
