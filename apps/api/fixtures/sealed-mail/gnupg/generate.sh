#!/usr/bin/env bash
#
# Offline, developer-only GnuPG interop regression for Sealed Mail key minting.
#
# CI NEVER runs this — it needs `gpg` on the machine (CI stays gpg-free; every
# committed fixture is read as bytes). This is the DIRECT regression check for
# the interop bug fixed in E1b: GnuPG (2.5.x), Thunderbird/RNP and older gpg all
# REJECT the RFC 9580 new-style ed25519/x25519 algorithm IDs (25/27) that
# openpgp.js `type: 'curve25519'` mints ("can't handle public key algorithm
# 27"), so a WKD/manifest key minted that way cannot be encrypted TO. The fix
# mints on the LEGACY curve25519 profile (EdDSA-legacy algo 22 + ECDH algo 18 —
# what Proton mints), which every OpenPGP implementation accepts.
#
# What this proves, end-to-end, against real GnuPG:
#   1. gpg CAN `--encrypt` to an Owlat-minted LEGACY-profile public key  → PASS
#   2. gpg CANNOT `--encrypt` to a new-style (pre-fix) public key         → the bug
#
# It mints both profiles with the checked-in `openpgp` dependency (the same
# library the backend uses), so it is reproducible without any external keys.
#
# Run (from any cwd — the script cd's into apps/api, where `openpgp` resolves):
#   bash apps/api/fixtures/sealed-mail/gnupg/generate.sh
# Optionally pass a path to an already-exported Owlat public key to test it
# directly instead of minting a fresh one:
#   bash fixtures/sealed-mail/gnupg/generate.sh /path/to/owlat-address.pub.asc
#
set -euo pipefail

command -v gpg >/dev/null 2>&1 || { echo "gpg not found — install GnuPG to run this offline check"; exit 127; }
command -v node >/dev/null 2>&1 || { echo "node not found"; exit 127; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve any caller-supplied key path against the original cwd BEFORE we move.
supplied_key=""
if [[ "${1:-}" != "" ]]; then
	supplied_key="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
fi

# openpgp resolves by a node_modules walk-up from the cwd (Node's ESM loader
# ignores NODE_PATH), so run from apps/api where the dependency is installed —
# this makes the script correct regardless of the caller's cwd.
apps_api="$(cd "$here/../../.." && pwd)"
cd "$apps_api"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A throwaway GnuPG homedir so we never touch the developer's real keyring.
export GNUPGHOME="$work/gnupg"
mkdir -p "$GNUPGHOME"
chmod 700 "$GNUPGHOME"

# ── Obtain the two public keys under test ────────────────────────────────────
legacy_pub="$work/legacy.pub.asc"
newstyle_pub="$work/newstyle.pub.asc"

if [[ "$supplied_key" != "" ]]; then
	# Caller supplied a real Owlat-exported public key — test it directly.
	cp "$supplied_key" "$legacy_pub"
	echo "Using supplied Owlat public key: $supplied_key"
else
	# Mint both profiles with the same openpgp.js the backend uses. The heredoc is
	# ESM (top-level `import` + `await`), so stdin MUST be flagged as a module —
	# `node -` defaults to CommonJS and would reject the `import`.
	node --input-type=module - "$legacy_pub" "$newstyle_pub" <<'NODE'
import * as openpgp from 'openpgp';
import { writeFileSync } from 'node:fs';
const [, , legacyOut, newStyleOut] = process.argv;
// LEGACY profile — exactly what apps/api/convex/e2ee/keysNode.ts now mints.
const legacy = await openpgp.generateKey({
	type: 'ecc',
	curve: 'curve25519Legacy',
	userIDs: [{ name: 'Owlat address', email: 'legacy@sealed.example.com' }],
	format: 'armored',
});
writeFileSync(legacyOut, legacy.publicKey);
// NEW-STYLE profile — the pre-fix shape GnuPG rejects.
const newStyle = await openpgp.generateKey({
	type: 'curve25519',
	userIDs: [{ name: 'Owlat address', email: 'newstyle@sealed.example.com' }],
	format: 'armored',
});
writeFileSync(newStyleOut, newStyle.publicKey);
NODE
fi

# ── 1. gpg MUST accept the legacy-profile key ────────────────────────────────
echo "== gpg encrypt to LEGACY-profile Owlat key (expect PASS) =="
gpg --batch --import "$legacy_pub"
legacy_fpr="$(gpg --batch --with-colons --import-options show-only --import "$legacy_pub" | awk -F: '/^fpr:/ {print $10; exit}')"
echo "hello sealed mail" | gpg --batch --yes --trust-model always --encrypt --recipient "$legacy_fpr" --armor --output "$work/legacy.gpg"
echo "OK — GnuPG encrypted to the legacy-profile key ($legacy_fpr)"

# ── 2. Demonstrate the bug: gpg REJECTS the new-style key ────────────────────
if [[ -f "$newstyle_pub" ]]; then
	echo "== gpg encrypt to NEW-STYLE key (expect FAIL — this is the bug) =="
	gpg --batch --import "$newstyle_pub" || true
	newstyle_fpr="$(gpg --batch --with-colons --import-options show-only --import "$newstyle_pub" | awk -F: '/^fpr:/ {print $10; exit}')"
	if echo "hello" | gpg --batch --yes --trust-model always --encrypt --recipient "$newstyle_fpr" --armor --output "$work/newstyle.gpg" 2>"$work/err"; then
		echo "UNEXPECTED — this gpg build encrypted to the new-style key; note its version:"
		gpg --version | head -1
	else
		echo "As expected, GnuPG refused the new-style key:"
		sed 's/^/  /' "$work/err" || true
	fi
fi

echo "Done. The legacy profile is GnuPG-encryptable; the new-style profile is not."
