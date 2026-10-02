import { win32 } from "node:path";

/** Where Windows keeps the programs of its own that Kumi runs, under its folder (SystemRoot). */
const ON_WINDOWS = {
  tar: ["System32", "tar.exe"],
  tasklist: ["System32", "tasklist.exe"],
  powershell: ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
} as const;

/**
 * A program Windows comes with, by its full path when Kumi runs on Windows (its name elsewhere). A PATH
 * can put another of the same name first: a PowerShell started from Git Bash finds Git's GNU tar, which
 * reads "C:\…" as a remote host and opens no zip. And Windows looks for a bare name in the working folder
 * before the PATH.
 */
export function systemProgram(name: keyof typeof ON_WINDOWS, env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", ...ON_WINDOWS[name]) : name;
}
