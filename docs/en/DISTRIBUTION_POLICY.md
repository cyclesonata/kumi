# Releases and distribution

English · [简体中文](../zh-CN/DISTRIBUTION_POLICY.md) · [日本語](../ja/DISTRIBUTION_POLICY.md)

How Kumi and its bridge reach people, what that does and doesn't prove, and
what the bridge's package may contain. The steps for cutting a release are in
[the developer guide](DEVELOPER_GUIDE.md#releasing).

## Channels

| What | Where | How people get it |
| --- | --- | --- |
| Kumi | GitHub Releases of `user1303836/kumi`: `kumi.tar.gz`, `kumi-release.json` and `SHA256SUMS`, attached to each `vX.Y.Z` tag by the Installer workflow | `install.sh` or `install.ps1`, then `kumi update` |
| The bridge (`@ableton-mcp/mcp-server`) | Inside each Kumi bundle, as the `npm pack` tarball and that tarball already installed | `kumi bridge`, which installs it through the bridge's lifecycle ([delivery](DELIVERY.md)) |
| The bridge on its own | No release of its own. Build it with `npm pack`, or take the `exact-local-candidate` artifact a CI run keeps for 90 days | The lifecycle CLI ([delivery](DELIVERY.md#the-standalone-bridge)) |

The installer scripts are read from the `main` branch; the bundle they install
comes from the latest published release (or the one `KUMI_VERSION` names). A
release is a draft until the maintainer publishes it, and only a published
release is "latest". Nothing is published to npm: every package is
`private: true`, so `npm publish` refuses.

## Integrity, not identity

Nothing is signed or notarized, and there are no native installers (`.pkg`,
`.msi`). The installer checks the bundle against the sha256 in
`kumi-release.json`, and Node against nodejs.org's `SHASUMS256.txt`; `kumi update`
checks the bundle the same way, and `kumi bridge` checks the bridge's tarball
against the hash recorded when the bundle was built. A checksum from the same
place as the download proves the bytes arrived intact, not who made them.

The software is [MIT licensed](../../LICENSE.md). The licence grants no rights
to Ableton's trademarks, and Kumi isn't affiliated with or endorsed by Ableton.

## What the bridge's package may contain

- compiled runtime JavaScript and type declarations (no source maps, no tests);
- the Remote Script, its README, the operation registry and their hash
  manifest;
- Kumi's Live extension: its manifest, `package.json`, built `extension.js` and
  that file's sha256;
- the bridge's guides (`README.md` and `release-docs/`);
- `release-manifest.json`, `package.json` and `LICENSE.md`.

Nothing else: no scripts, test fixtures, `node_modules`, credentials,
configuration, local state, logs, captured media or evidence. `npm run
package:verify` refuses any path outside its own explicit list, and
`release-manifest.json` is the source of truth for the exact payload. CI packs
the bridge twice, the second time from a fresh clone with a fresh `npm ci`, and
requires identical bytes.

## The release manifest

`release-manifest.json` (schema `ableton-mcp-release/v2`) records the package
name and version, the source commit and whether the tree was dirty, the Node
range and majors, the Node, npm and TypeScript versions and runner image that
built it, the SHA-256 of `package-lock.json` and of the CI workflow, the build
recipe, the protocol versions and registry hash, each payload file's role and
SHA-256, and the distribution fields.

The distribution fields say `channel: "local-npm-tarball"`, `published: false`,
`signed: false` and `notarized: false`, and `package:verify` and the lifecycle
require exactly those values. Here "local" and "unpublished" describe the
tarball itself, built with `npm pack` and installed from a local path by its
hash: never published to a registry. It does reach people inside the Kumi
bundle on GitHub Releases. The lifecycle still accepts the older
`ableton-mcp-private-release/v1` manifest so an existing installation can be
upgraded or rolled back.

## Merge gate

The `main` branch has one ruleset:

- changes arrive by pull request; no approving review is required;
- required checks, which must pass on the branch as it is up to date with
  `main`: `Required CI`, `Kumi / Node 22`, `Kumi / Node 24`,
  `Kumi / Windows / Node 24` and `Kumi / macOS / Node 24`;
- `main` can't be deleted or force-pushed;
- the repository admin role can bypass these rules for pull requests.

The Installer workflow isn't a required check, but on a tag its `publish` job
runs only after the bundle has installed on macOS, Linux and Windows.
[Testing](TESTING.md#ci) describes every job.

## Open owner decisions

- **Signing and notarization** of Kumi's bundle and installers on macOS and
  Windows.
- **Redistributing the Extensions SDK.** Kumi's Live extension is built from a
  locally supplied pre-release Ableton Extensions SDK, which the repository
  never commits because its licence restricts redistributing the SDK. The built
  `extension.js` bundles the extension with the SDK code it uses, and it is
  committed and shipped in the bridge's package and the Kumi bundle. Whether
  that is allowed is for the owner to settle.
- **The admin bypass** on the `main` ruleset: keep it, or remove it.
