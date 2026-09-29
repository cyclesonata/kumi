import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { KumiError } from "../core/errors.js";

export interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  /** Epoch milliseconds. */
  expires: number;
  accountId: string;
}
/** A provider's API key, typed or pasted by the producer. */
export interface ApiKeyCredential {
  type: "api-key";
  key: string;
}
export type Credential = OAuthCredential | ApiKeyCredential;

export interface CredentialStore {
  readonly path: string;
  get(provider: string): Promise<Credential | undefined>;
  list(): Promise<Record<string, Credential>>;
  /** Read-modify-write under an exclusive cross-process lock; returning undefined removes the entry. */
  update(provider: string, change: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined>;
}

interface StoreFile { version: 1; credentials: Record<string, Credential> }

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

/** Owner-only JSON file. Credentials never leave it except as request headers. */
export function openCredentialStore(path: string): CredentialStore {
  async function read(): Promise<StoreFile> {
    let text: string;
    try {
      // POSIX mode bits say who may read the file. Windows doesn't keep them (every file reads as
      // 0o666); there the user's profile folder, where Kumi keeps this file, is private by default.
      if (process.platform !== "win32" && (await stat(path)).mode & 0o077) throw new KumiError("auth", `Credential file ${path} is readable by other users; run: chmod 600 ${path}`);
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, credentials: {} };
      throw error;
    }
    try {
      const data = JSON.parse(text) as Partial<StoreFile>;
      if (data.version !== 1 || !data.credentials || typeof data.credentials !== "object") throw new Error("shape");
      for (const credential of Object.values(data.credentials)) if (!isCredential(credential)) throw new Error("entry");
      return data as StoreFile;
    } catch {
      throw new KumiError("auth", `Credential file ${path} is malformed; remove it and sign in again.`);
    }
  }
  async function write(data: StoreFile) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  async function locked<T>(work: () => Promise<T>): Promise<T> {
    const lock = `${path}.lock`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const handle = await open(lock, "wx", 0o600);
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const age = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
        if (age > LOCK_STALE_MS) { await rm(lock, { force: true }); continue; }
        if (Date.now() > deadline) throw new KumiError("auth", "The credential store is locked by another Kumi process; try again.");
        await delay(50);
      }
    }
    try { return await work(); } finally { await rm(lock, { force: true }); }
  }
  return {
    path,
    async get(provider) { return (await read()).credentials[provider]; },
    async list() { return (await read()).credentials; },
    update(provider, change) {
      return locked(async () => {
        const data = await read();
        const next = await change(data.credentials[provider]);
        if (next === undefined) delete data.credentials[provider];
        else if (!isCredential(next)) throw new KumiError("auth", "Refusing to store a malformed credential.");
        else data.credentials[provider] = next;
        await write(data);
        return next;
      });
    },
  };
}

/** An API key as providers issue them: one word of printable characters. */
export function validApiKey(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{8,4096}$/.test(value);
}

function isCredential(value: unknown): value is Credential {
  if ((value as { type?: unknown } | null)?.type === "api-key") return validApiKey((value as ApiKeyCredential).key);
  const entry = value as Partial<OAuthCredential> | null;
  return Boolean(entry) && entry!.type === "oauth" && typeof entry!.access === "string" && entry!.access.length > 0
    && typeof entry!.refresh === "string" && entry!.refresh.length > 0 && typeof entry!.expires === "number" && Number.isFinite(entry!.expires)
    && typeof entry!.accountId === "string" && entry!.accountId.length > 0;
}
