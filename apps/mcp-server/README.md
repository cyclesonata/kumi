# Ableton MCP Beyond

Standalone `@ableton-mcp/mcp-server`: a capability-negotiated MCP interface to
Ableton Live 12 through an authenticated, owner-controlled Remote Script.
It remains independent of the parent Kumi assistant and its inference dependency.

## Source checkout

Requires Node.js **22 or 24** (24 LTS recommended; Node 25 is end-of-life and
unsupported). From the repository root:

```sh
cd apps/mcp-server
npm ci
npm run build
npm test
npm run demo                 # no Live required
node dist/src/cli.js          # fail-closed: no Live access
```

To inspect Live, prepare a version-2 configuration and install the Remote Script
using the user guide. Then run:

```sh
node dist/src/cli.js --config /absolute/path/bridge-config.json
npm run diagnostics -- --config /absolute/path/bridge-config.json
```

Do not infer connectivity from an open port or running application. Require
fresh authenticated status and `real-live` provenance. Supported Node versions
are not a certification of every Live/platform combination.

## Safety and documentation

The broader bridge supports capability-negotiated discovery, guarded editing,
and audio analysis. **Kumi currently uses four of them: Live status, snapshot and discovery reads.**
Server confirmations are not independent human approval; do not auto-approve
playback, recording, routing, capture or realtime work. See:

- [User guide](https://github.com/user1303836/ableton-mcp-beyond/blob/main/docs/en/USER_GUIDE.md)
- [Live safety](https://github.com/user1303836/ableton-mcp-beyond/blob/main/docs/en/LIVE_SAFETY.md)
- [Operations](https://github.com/user1303836/ableton-mcp-beyond/blob/main/docs/en/OPERATIONS.md) and [recovery](https://github.com/user1303836/ableton-mcp-beyond/blob/main/docs/en/RECOVERY.md)
- [Capabilities](https://github.com/user1303836/ableton-mcp-beyond/blob/main/docs/en/CAPABILITY_MATRIX.md) and [support matrix](https://github.com/user1303836/ableton-mcp-beyond/blob/main/docs/en/SUPPORT_MATRIX.md)
- [Delivery lifecycle](https://github.com/user1303836/ableton-mcp-beyond/blob/main/docs/en/DELIVERY.md)

Installed tarballs include matching local guides under `release-docs/`; prefer
those over online `main` documentation when versions differ. The package keeps
its own lockfile, build, tests and CI; installing Kumi is not required.

MIT licensed; local artifacts are unpublished, unsigned and unnotarized.
Ableton Live is a trademark of Ableton AG. No affiliation or endorsement is implied.
