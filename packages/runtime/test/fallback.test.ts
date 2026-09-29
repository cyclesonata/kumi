import assert from "node:assert/strict";
import { test } from "node:test";
import type { Integration, Observation } from "../src/core/contracts.js";
import { KumiError } from "../src/core/errors.js";
import { withFallback } from "../src/integrations/fallback.js";

const observation = (key: string): Observation => ({ key, label: key, context: "{}", instructions: "", tools: [] });
function integration(name: string, start: () => Promise<void>, log: string[]): Integration {
  return { start: async () => { log.push(`${name}:start`); await start(); }, observe: async () => observation(name), close: async () => { log.push(`${name}:close`); } };
}

test("a bridge that won't start leaves Kumi chatting without Live, saying how to fix it; other failures stay failures", async () => {
  const log: string[] = []; const said: string[] = [];
  const fallen = withFallback(integration("live", async () => { throw new KumiError("live", "Quit Live, then run npm run kumi -- bridge"); }, log),
    () => integration("chat", async () => {}, log), (message) => said.push(message));
  await fallen.start(AbortSignal.timeout(1_000));
  assert.deepEqual(log, ["live:start", "live:close", "chat:start"], "the failed bridge is closed before carrying on");
  assert.deepEqual(said, ["Quit Live, then run npm run kumi -- bridge"]);
  assert.equal((await fallen.observe(AbortSignal.timeout(1_000))).key, "chat");
  assert.equal(await fallen.stopLive!(AbortSignal.timeout(1_000)), false, "nothing to stop without Live");
  assert.throws(() => fallen.undo!(undefined, AbortSignal.timeout(1_000)), /isn't connected to Live/);

  const other = withFallback(integration("live", async () => { throw new Error("socket closed"); }, []), () => integration("chat", async () => {}, []), () => assert.fail("no fallback"));
  await assert.rejects(other.start(AbortSignal.timeout(1_000)), /socket closed/);
  const controller = new AbortController(); controller.abort();
  const stopped = withFallback(integration("live", async () => { throw new KumiError("live", "x"); }, []), () => integration("chat", async () => {}, []), () => assert.fail("no fallback when stopped"));
  await assert.rejects(stopped.start(controller.signal), /x/);
});
