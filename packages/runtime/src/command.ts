/**
 * How the producer runs Kumi, for every message that says what to type: "kumi bridge" once Kumi is
 * installed (its launcher sets KUMI_INSTALLED), "npm run kumi -- bridge" from a checkout of the
 * repository. KUMI_HOME is where the installer put it.
 */
export const INSTALLED = process.env.KUMI_INSTALLED === "1";

/** The command before a subcommand: "kumi" or "npm run kumi --". */
export const KUMI = INSTALLED ? "kumi" : "npm run kumi --";

/** The command that starts Kumi: "kumi" or "npm run kumi". */
export const KUMI_START = INSTALLED ? "kumi" : "npm run kumi";

/** What puts a missing or broken Kumi back: the installer again, or a rebuild of the checkout. */
export const KUMI_REPAIR = INSTALLED ? "the Kumi installer again (github.com/user1303836/kumi)" : "npm run setup";
