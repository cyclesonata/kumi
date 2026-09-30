import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where Live keeps the extensions it runs itself, and their data. Live starts every extension in its
 * Extensions folder when it opens, in an Extension Host of its own, unless Developer Mode is on
 * (Settings → Extensions); installing one (Settings → Extensions, or copying its folder there) needs a
 * restart of Live. Live names an extension's folder `<author>.<name>` in lower case, so Kumi's is
 * `kumi.kumi`, and gives it a data folder of the same name in "Extensions Data", where Kumi's extension
 * writes its endpoint and secret. macOS: seen on Live 12.4.15b5. Windows: beside Live's other
 * per-user folders in %APPDATA%\Ableton (to be confirmed there). `ABLETON_MCP_LIVE_EXTENSIONS_DIR`
 * names another Extensions folder; its data folder is then the "Extensions Data" beside it.
 */
export const KUMI_EXTENSION_ID = "kumi.kumi";

export interface KumiExtensionFolders {
  /** Kumi's extension as Live loads it: manifest.json, package.json, dist/extension.js. */
  code: string;
  /** Its data while Live runs it: endpoint.json and secret. */
  data: string;
}

export function kumiExtensionFolders(env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): KumiExtensionFolders | undefined {
  const extensions = env.ABLETON_MCP_LIVE_EXTENSIONS_DIR
    || (platform === "darwin" ? join(home, "Library", "Application Support", "Ableton", "Extensions")
      : platform === "win32" ? join(env.APPDATA || join(home, "AppData", "Roaming"), "Ableton", "Extensions")
        : undefined);
  if (!extensions) return undefined;
  return { code: join(extensions, KUMI_EXTENSION_ID), data: join(dirname(extensions), "Extensions Data", KUMI_EXTENSION_ID) };
}
