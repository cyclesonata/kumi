import assert from "node:assert/strict";
import { test } from "node:test";
import { systemProgram } from "../src/system.js";

test("on Windows, Windows' own programs are run by their full path, wherever Windows is; elsewhere by name", () => {
  assert.equal(systemProgram("tar", { SystemRoot: "D:\\Windows" }, "win32"), "D:\\Windows\\System32\\tar.exe");
  assert.equal(systemProgram("tasklist", { SYSTEMROOT: "C:\\WINDOWS" }, "win32"), "C:\\WINDOWS\\System32\\tasklist.exe");
  assert.equal(systemProgram("powershell", {}, "win32"), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(systemProgram("tar", { SystemRoot: "C:\\Windows" }, "darwin"), "tar");
  assert.equal(systemProgram("tar", {}, "linux"), "tar");
});
