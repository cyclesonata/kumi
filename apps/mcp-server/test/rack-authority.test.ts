import assert from "node:assert/strict";
import { test } from "node:test";
import { McpHost } from "../src/host.js";
import { DeterministicLiveSimulator } from "../src/live.js";
import { parameterAuthority } from "../src/transactions/batch.js";
import { visibleToolDescriptors, DEFAULT_TOOL_POLICY } from "../src/tool-catalog.js";

test("native rack macro aliases retain canonical parameter authorities", () => {
  const adapter = new DeterministicLiveSimulator();
  const snapshot = adapter.snapshot();
  const device = snapshot.tracks[0]!.devices[0]! as any;
  device.parameters = Array.from({ length: 17 }, (_, index) => ({ ...device.parameters[0], ref: `parameter-${index}`, objectIdentity: `identity-${index}` }));
  device.macros = device.parameters.slice(1);
  const expected = device.parameters.map(({ ref, objectIdentity }: any) => ({ ref, objectIdentity }));
  assert.deepEqual(parameterAuthority(snapshot, "parameter-1").siblings, expected);
  const targets = (new McpHost(adapter) as any).realtimeParameterTargets(snapshot, ["parameter-1"]);
  assert.deepEqual(targets[0].authority.siblings, expected);
  assert.equal(targets[0].kind, "device-parameter");
});

for (const kinds of [["macro-name", "macro-mapping", "variation-name"], ["selector-zone", "key-zone", "velocity-zone"]]) {
  test(`Willington schema advertises only enabled kinds: ${kinds.join(", ")}`, () => {
    const status = new DeterministicLiveSimulator().status();
    const tools = visibleToolDescriptors({ ...status, operations: [...status.operations!, "willington.device.read", "willington.device.set"], willingtonKinds: kinds }, DEFAULT_TOOL_POLICY);
    const schema = tools.find(tool => tool.name === "live_willington_device_preview")!.inputSchema as any;
    assert.deepEqual(schema.properties.kind.enum, kinds);
  });
}
