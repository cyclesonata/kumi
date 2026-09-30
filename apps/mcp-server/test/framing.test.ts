import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_FRAME_BYTES, NdjsonFramer } from "../src/framing.js";

test("frames arbitrary chunks, CRLF, multiple records, and EOF", () => {
  const framer = new NdjsonFramer();
  const events = [
    ...framer.push(Buffer.from('{"a":')),
    ...framer.push(Buffer.from('1}\r\n{"b":2}\n')),
    ...framer.end(),
  ];
  assert.deepEqual(events, [
    { type: "record", value: '{"a":1}' },
    { type: "record", value: '{"b":2}' },
  ]);
});

test("reports invalid UTF-8 and discards exactly one oversized record", () => {
  // The bound is as large as a string can be (500 MiB); a framer with a small one shows the same handling
  // without allocating it: an oversized record, whole or arriving in chunks, is dropped and the next one read.
  assert.equal(MAX_FRAME_BYTES, 500 * 1024 * 1024);
  const bound = 1024;
  const framer = new NdjsonFramer(bound);
  assert.deepEqual(framer.push(Uint8Array.from([0xc3, 0x28, 10])), [{ type: "error", message: "invalid-utf8" }]);
  const oversized = new Uint8Array(bound + 2);
  oversized.fill(97);
  oversized[bound + 1] = 10;
  assert.deepEqual(framer.push(oversized), [{ type: "error", message: "oversized" }]);
  assert.deepEqual(framer.push(Buffer.from("ok\n")), [{ type: "record", value: "ok" }]);
  assert.equal(framer.retainedBytes, 0);
  const chunk = new Uint8Array(bound / 4).fill(98);
  for (let index = 0; index < 5; index += 1) assert.deepEqual(framer.push(chunk), []);
  assert.equal(framer.retainedBytes, 0, "an oversized record is not retained while it arrives");
  assert.deepEqual(framer.push(Buffer.from("tail\nnext\n")), [{ type: "error", message: "oversized" }, { type: "record", value: "next" }]);
  const exact = new Uint8Array(bound + 1).fill(99); exact[bound] = 10;
  assert.deepEqual(framer.push(exact), [{ type: "record", value: "c".repeat(bound) }], "a record of exactly the bound is read");
});
