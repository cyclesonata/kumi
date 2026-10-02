import { win32 } from "node:path";

export function npmExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Windows PowerShell by its full path. A client may start the bridge with a PATH that holds only
 * Node's folder (Kumi does), where a bare `powershell.exe` isn't found; a bare name is also looked
 * for in the working folder first, which is no place to take a security check's program from.
 */
export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
