#!/usr/bin/env bash
#
# Packaging smoke for the amp CLI.
#
# Builds, packs, installs the resulting tarball into a throwaway global prefix,
# and asserts the `amp` bin loads (`amp --version`, `amp --help` exit 0). This
# catches packaging mistakes that unit tests cannot — missing `files` entries,
# a broken `bin`, or a lost executable bit — before they ship to npm.
#
# Unlike scripts/smoke.sh this does NOT hit the Amplitude API and needs no PAT.
# It is meant for PR CI (it only talks to the npm registry to resolve deps).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PACK_DIR="$(mktemp -d)"
PREFIX="$(mktemp -d)"
cleanup() { rm -rf "$PACK_DIR" "$PREFIX"; }
trap cleanup EXIT

echo "==> Building"
pnpm build

echo "==> Packing"
pnpm pack --pack-destination "$PACK_DIR" >/dev/null
TARBALL="$(ls "$PACK_DIR"/*.tgz | head -n 1)"
echo "    $TARBALL"

echo "==> Installing tarball into throwaway global prefix"
export npm_config_prefix="$PREFIX"
export PATH="$PREFIX/bin:$PATH"
# Validate the public consumer install path directly. CI configures npm to use
# CodeArtifact globally, but that proxy can briefly lag newly published public
# transitive versions and turn this packaging check into a registry-sync test.
npm install -g --registry=https://registry.npmjs.org "$TARBALL"

echo "==> amp --version"
amp --version

echo "==> amp --help"
amp --help >/dev/null

echo "==> Packaging smoke passed"
