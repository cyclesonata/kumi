import assert from "node:assert/strict";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator, type LiveStatus, type LiveInvocation, type LiveOperationContext } from "../src/live.js";
import { FOLLOW_ACTION_FIELDS } from "../src/follow-actions.js";

const initial = { followActionEnabled: false, followActionLinked: true, followActionA: 4, followActionB: 0, followActionChanceA: 100, followActionChanceB: 0, followActionLoopCount: 1, followActionTime: 4, followActionJumpA: 1, followActionJumpB: 1 };
class FollowSimulator extends DeterministicLiveSimulator {
  constructor() { super(); for (const track of (this as any).state.tracks) for (const clip of track.clips) Object.assign(clip, initial, { isPlaying: false, isTriggered: false, isRecording: false }); }
  override status(): LiveStatus { const status = super.status(); return { ...status, operations: [...status.operations!, "clip.follow-actions.set"] }; }
}
function fixture(adapter = new FollowSimulator()) {
  const host = new McpHost(adapter);
  host.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  host.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  let id = 2;
  const call = async (name: string, args: object) => {
    const reply = await host.handleAsync({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }) as any;
    if (reply.error || reply.result?.isError) throw new Error(JSON.stringify(reply));
    return JSON.parse(reply.result.content[0].text);
  };
  return { host, adapter, call, clipRef: adapter.snapshot().tracks[0]!.clips[0]!.ref };
}
test("follow actions capture coupled state, apply idempotently, and restore through history", async () => {
  const { adapter, call, clipRef } = fixture();
  const preview = await call("live_follow_actions_preview", { clipRef, followActionChanceA: 75, followActionEnabled: true });
  assert.equal(preview.proposed.followActionChanceB, 25);
  const args = { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "follow-apply-1" };
  await call("live_follow_actions_apply", args);
  assert.equal((adapter.get(clipRef) as any).followActionChanceB, 25);
  assert.equal((await call("live_follow_actions_apply", args)).idempotent, true);
  await call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "follow-undo-1" });
  const restored = adapter.get(clipRef) as any;
  assert.deepEqual(Object.fromEntries(FOLLOW_ACTION_FIELDS.map(field => [field, restored[field]])), initial);
});
test("follow actions refuse malformed values and external edits", async () => {
  const { adapter, call, clipRef } = fixture();
  for (const change of [{ followActionA: 10 }, { followActionJumpA: 0 }, { followActionChanceA: 20, followActionChanceB: 30 }]) await assert.rejects(call("live_follow_actions_preview", { clipRef, ...change }));
  const preview = await call("live_follow_actions_preview", { clipRef, followActionA: 7 });
  (adapter as any).state.tracks[0].clips[0].followActionA = 5;
  await assert.rejects(call("live_follow_actions_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "stale-follow-1" }), /changed/);
});
test("follow actions are absent without negotiated extension", () => {
  const { host } = fixture(new DeterministicLiveSimulator() as FollowSimulator);
  const reply = host.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }) as any;
  assert.equal(reply.result.tools.some((item: any) => item.name.startsWith("live_follow_actions_")), false);
});

class LostAcknowledgementSimulator extends FollowSimulator {
  cached = new Map<string, unknown>();
  failNext = true;
  override async invokeAsync(invocation: LiveInvocation, context?: LiveOperationContext): Promise<unknown> {
    if (invocation.operation !== 'clip.follow-actions.set') return super.invokeAsync(invocation);
    const key = context?.idempotencyKey ?? '';
    if (this.cached.has(key)) return this.cached.get(key);
    const result = super.invoke(invocation); this.cached.set(key,result);
    if (this.failNext) { this.failNext=false; throw new Error('Injected lost acknowledgement'); }
    return result;
  }
}
test('follow actions reconcile lost apply and undo acknowledgements with the exact key',async()=>{
  const adapter=new LostAcknowledgementSimulator(); const {call,clipRef}=fixture(adapter);
  const preview=await call('live_follow_actions_preview',{clipRef,followActionA:7});
  const apply={transactionId:preview.transactionId,confirmation:'apply',idempotencyKey:'lost-follow-apply'};
  await assert.rejects(call('live_follow_actions_apply',apply));
  await assert.rejects(call('live_follow_actions_apply',{...apply,idempotencyKey:'different-follow-key'}));
  await call('live_follow_actions_apply',apply);
  adapter.failNext=true;
  const undo={transactionId:preview.transactionId,confirmation:'undo',idempotencyKey:'lost-follow-undo'};
  await assert.rejects(call('live_undo',undo));
  await call('live_undo',undo);
  assert.equal((adapter.get(clipRef) as any).followActionA,initial.followActionA);
});

test("paused Session playing/triggered flags allow Follow Action edits and undo", async () => {
  for (const retained of [{ isPlaying: true }, { isTriggered: true }]) {
    const { adapter, call, clipRef } = fixture();
    Object.assign((adapter as any).state.tracks[0].clips[0], retained);
    const preview = await call("live_follow_actions_preview", { clipRef, followActionB: 2, followActionChanceA: 50 });
    await call("live_follow_actions_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "paused-follow-apply" });
    assert.equal((adapter.get(clipRef) as any).followActionChanceB, 50);
    await call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "paused-follow-undo" });
    assert.equal((adapter.get(clipRef) as any).followActionChanceB, 0);
    for (const [key,value] of Object.entries(retained)) assert.equal((adapter.get(clipRef) as any)[key], value);
  }
});
test("active transport and recording are refused with actionable errors, including after preview", async () => {
  const { adapter, call, clipRef } = fixture();
  const state = (adapter as any).state;
  state.playback.transport.playing = true;
  await assert.rejects(call("live_follow_actions_preview", { clipRef, followActionA: 8 }), /stopped transport.*non-recording clip/);
  state.playback.transport.playing = false; state.tracks[0].clips[0].isRecording = true;
  await assert.rejects(call("live_follow_actions_preview", { clipRef, followActionA: 8 }), /Stop Live transport/);
  state.tracks[0].clips[0].isRecording = false;
  const preview = await call("live_follow_actions_preview", { clipRef, followActionA: 8 });
  state.playback.transport.playing = true;
  await assert.rejects(call("live_follow_actions_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "transport-resumed" }), /stopped transport/);
  assert.equal((adapter.get(clipRef) as any).followActionA, initial.followActionA);
});


test("follow-actions undo respects a policy changed after apply", async () => {
  const { host, adapter, call, clipRef } = fixture();
  const preview = await call("live_follow_actions_preview", { clipRef, followActionA: 8 });
  await call("live_follow_actions_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "policy-apply" });
  host.setToolPolicy({ profile: "full", deny: ["live_follow_actions_apply"] });
  const undo = { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "policy-undo" };
  await assert.rejects(call("live_undo", undo), /deployment policy/);
  host.setToolPolicy({ profile: "full" });
  await call("live_undo", undo);
  assert.equal((adapter.get(clipRef) as any).followActionA, 4);
});


test("follow-actions undo retries after a connection failure before the restore was recorded", async () => {
  const { host, adapter, call, clipRef } = fixture();
  const preview = await call("live_follow_actions_preview", { clipRef, followActionA: 8 });
  await call("live_follow_actions_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "early-apply" });
  let fail = true;
  const original = (host as any).requireConnected.bind(host);
    (host as any).requireConnected = (...args: unknown[]) => { if (fail) { fail = false; throw new Error("injected status failure"); } return original(...args); };
  const undo = { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "early-undo" };
  await assert.rejects(call("live_undo", undo), /injected/);
  await call("live_undo", undo);
  assert.equal((adapter.get(clipRef) as any).followActionA, 4);
});


test("follow-actions undo retries after a read failure before the restore was recorded", async () => {
  const { host, adapter, call, clipRef } = fixture();
  const preview = await call("live_follow_actions_preview", { clipRef, followActionA: 8 });
  await call("live_follow_actions_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "early-apply" });
  let fail = true;
  const original = adapter.snapshotAsync.bind(adapter);
    adapter.snapshotAsync = async (...args) => { if (fail) { fail = false; throw new Error("injected read failure"); } return original(...args); };
  const undo = { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "early-undo" };
  await assert.rejects(call("live_undo", undo), /injected/);
  await call("live_undo", undo);
  assert.equal((adapter.get(clipRef) as any).followActionA, 4);
});


test("Follow validation errors retain their useful reasons", async () => {
  const { call, clipRef } = fixture();
  await assert.rejects(call("live_follow_actions_preview", { clipRef, followActionChanceA: 20, followActionChanceB: 30 }), /probabilities must sum to 100/);
});

test("Follow timing accepts float32 readback while integral fields remain exact", async () => {
  const { adapter, call, clipRef } = fixture();
  const invoke = adapter.invokeAsync.bind(adapter);
  adapter.invokeAsync = async (invocation) => {
    const result = await invoke(invocation);
    if (invocation.operation === "clip.follow-actions.set") {
      const clip = (adapter as any).state.tracks[0].clips[0];
      clip.followActionTime = Math.fround(clip.followActionTime);
    }
    return result;
  };
  const preview = await call("live_follow_actions_preview", { clipRef, followActionTime: 1.333 });
  await call("live_follow_actions_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "rounded-time-apply" });
  await call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "rounded-time-undo" });
  assert.equal((adapter.get(clipRef) as any).followActionTime, 4);
});
