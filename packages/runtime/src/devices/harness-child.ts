/**
 * The device check's own process: the spec in on stdin, the result out on stdout, nothing else. Kumi
 * starts it with Node's permission model (it may read only Kumi's code), no environment, no code
 * generation from strings and a deadline, so a device's code can't reach Kumi, the producer's files
 * or keys, or hang Kumi (see checkMidiDeviceIsolated).
 */
import { checkMidiDevice } from "./harness.js";

const write = process.stdout.write.bind(process.stdout);
const chunks: Buffer[] = [];
process.stdin.on("data", (chunk: Buffer) => { chunks.push(chunk); });
process.stdin.on("end", () => {
  let result: unknown;
  try { result = checkMidiDevice(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch (error) { result = { passed: 0, of: 0, problems: [`Kumi's check couldn't run it: ${error instanceof Error ? error.message.slice(0, 200) : "it failed"}`] }; }
  write(JSON.stringify(result), () => process.exit(0));
});
