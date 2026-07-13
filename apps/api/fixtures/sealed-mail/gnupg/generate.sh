#!/usr/bin/env bash
#
# Offline, developer-only regenerator for the GENUINE GnuPG interop fixtures.
#
# Every byte of OpenPGP material in this group — the throwaway keys, the
# encryption, the signature — is produced by `gpg` itself (NOT openpgp.js), so
# the E4 interop test in `convex/e2ee/__tests__/open.test.ts` proves true
# cross-implementation interop: GnuPG writes, our `openpgp.js` ingest path opens.
# Only the PGP/MIME *wrapper* (RFC 3156 multipart/encrypted framing) is
# assembled by this script — that part is plain text, not crypto.
#
# Produces:
#   keys/sender.pub.asc / keys/sender.sec.asc         gpg-minted signer keypair
#   keys/recipient.pub.asc / keys/recipient.sec.asc   gpg-minted recipient keypair
#   inner-protected-headers.eml                       committed plaintext INPUT (D4:
#                                                     real Subject + text/html inside)
#   inner-no-protected-headers.eml                    committed plaintext INPUT (no
#                                                     protected headers — body only)
#   sealed-protected-headers.eml                      signed+encrypted PGP/MIME; outer
#                                                     Subject is the literal "..."
#   sealed-no-protected-headers.eml                   signed+encrypted PGP/MIME; outer
#                                                     Subject is the real one
#
# Why this group mints its OWN recipient keypair instead of encrypting to
# `fixtures/sealed-mail/pgp/inbound-recipient.public.asc`: that key is an
# openpgp.js v4 key using the RFC 9580 new-style algorithm IDs (Ed25519 = 27,
# X25519 = 25), which GnuPG rejects on v4 keys ("can't handle public key
# algorithm 27") — gpg cannot encrypt to it. The keys here are gpg-native
# ed25519/cv25519 (EdDSA 22 / ECDH 18), which openpgp.js reads fine, keeping the
# interop direction that matters for INBOUND: foreign implementation seals,
# our stack opens.
#
# The throwaway keys are committed (alice/bob precedent in pgp-mime/keys/) and
# protect nothing — regenerate freely. The secret keys are unprotected on
# purpose. CI NEVER runs gpg: the bytes are committed; this script is offline
# regeneration only. It self-verifies from the COMMITTED artifacts (fresh
# keyring, gpg --decrypt + signature check, byte-equal plaintext) and exits
# non-zero if the material is not genuine.
#
# Run:  bash apps/api/fixtures/sealed-mail/gnupg/generate.sh
# Needs gpg >= 2.4 (generated/verified with gpg (GnuPG) 2.5.21). Uses a
# temporary GNUPGHOME throughout — the operator keyring is never touched.
#
# All message bytes use CRLF (RFC 5322 / RFC 3156); .gitattributes exempts this
# corpus from EOL normalization so the committed bytes stay exact.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GPG="${GPG:-gpg}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/gen-home" "$WORK/verify-home"
chmod 700 "$WORK/gen-home" "$WORK/verify-home"

# Every gpg call gets an explicit --homedir; never the operator's ~/.gnupg.
gpg_gen()    { "$GPG" --homedir "$WORK/gen-home"    --batch --no-tty "$@"; }
gpg_verify() { "$GPG" --homedir "$WORK/verify-home" --batch --no-tty "$@"; }

# Emit each argument as a CRLF-terminated line.
crlf() { printf '%s\r\n' "$@"; }

"$GPG" --version | head -n 1

# --- 1. Mint the throwaway keypairs with gpg itself -------------------------
gen_key() {
	gpg_gen --gen-key <<-EOF
		%no-protection
		Key-Type: eddsa
		Key-Curve: ed25519
		Key-Usage: sign
		Subkey-Type: ecdh
		Subkey-Curve: cv25519
		Subkey-Usage: encrypt
		Name-Real: $1
		Name-Email: $2
		Expire-Date: 0
		%commit
	EOF
}
gen_key 'GnuPG Interop Sender' 'gnupg-sender@interop.example.org'
gen_key 'GnuPG Interop Recipient' 'gnupg-recipient@interop.example.net'

fpr_of() {
	gpg_gen --with-colons --list-keys "$1" | awk -F: '/^fpr:/ { print $10; exit }'
}
SENDER_FPR="$(fpr_of gnupg-sender@interop.example.org)"
RECIPIENT_FPR="$(fpr_of gnupg-recipient@interop.example.net)"
echo "sender:    $SENDER_FPR"
echo "recipient: $RECIPIENT_FPR"

mkdir -p "$HERE/keys"
gpg_gen --armor --export "$SENDER_FPR" >"$HERE/keys/sender.pub.asc"
gpg_gen --armor --export-secret-keys "$SENDER_FPR" >"$HERE/keys/sender.sec.asc"
gpg_gen --armor --export "$RECIPIENT_FPR" >"$HERE/keys/recipient.pub.asc"
gpg_gen --armor --export-secret-keys "$RECIPIENT_FPR" >"$HERE/keys/recipient.sec.asc"

# --- 2. The committed plaintext INPUTS (byte-equal assertion targets) --------
# (a) Protected headers per locked decision D4: the REAL Subject and both body
#     branches travel INSIDE the ciphertext.
crlf \
	'Message-ID: <gnupg-interop-0001@interop.example.org>' \
	'Date: Mon, 13 Jul 2026 10:00:00 +0000' \
	'From: gnupg-sender@interop.example.org' \
	'To: gnupg-recipient@interop.example.net' \
	'Subject: GnuPG sealed interop figures' \
	'MIME-Version: 1.0' \
	'Content-Type: multipart/alternative; boundary="=_gnupg_inner_alt"' \
	'' \
	'--=_gnupg_inner_alt' \
	'Content-Type: text/plain; charset=utf-8' \
	'' \
	'The CANARY_GNUPG_INTEROP_9f41aa figures, plain-text branch.' \
	'' \
	'--=_gnupg_inner_alt' \
	'Content-Type: text/html; charset=utf-8' \
	'' \
	'<p>HTML CANARY_GNUPG_INTEROP_9f41aa figures.</p>' \
	'' \
	'--=_gnupg_inner_alt--' \
	'' >"$HERE/inner-protected-headers.eml"

# (b) NO protected headers — a bare body entity, the way clients without the
#     protected-headers convention seal: the outer Subject stays authoritative.
crlf \
	'Content-Type: text/plain; charset=utf-8' \
	'' \
	'No protected headers in here - the outer Subject is the real one.' \
	'CANARY_GNUPG_PLAIN_2ee7c3' \
	'' >"$HERE/inner-no-protected-headers.eml"

# --- 3. Sign + encrypt with gpg (the actual cross-implementation crypto) ----
seal() { # seal <inner-file> <out-armor>
	gpg_gen --armor --sign --encrypt \
		--local-user "$SENDER_FPR" --recipient "$RECIPIENT_FPR" \
		--trust-model always --output "$2" "$1"
}
seal "$HERE/inner-protected-headers.eml" "$WORK/protected.asc"
seal "$HERE/inner-no-protected-headers.eml" "$WORK/plain.asc"

# --- 4. Assemble the PGP/MIME wrappers (RFC 3156) ----------------------------
armor_crlf() { awk '{ sub(/\r$/, ""); printf "%s\r\n", $0 }' "$1"; }

write_eml() { # write_eml <outer-subject> <message-id> <armor-file> <out-file>
	{
		crlf \
			'From: gnupg-sender@interop.example.org' \
			'To: gnupg-recipient@interop.example.net' \
			"Subject: $1" \
			'Date: Mon, 13 Jul 2026 10:00:00 +0000' \
			"Message-ID: <$2@interop.example.org>" \
			'MIME-Version: 1.0' \
			'Content-Type: multipart/encrypted;' \
			' protocol="application/pgp-encrypted"; boundary="=_gnupg_sealed_interop"' \
			'' \
			'--=_gnupg_sealed_interop' \
			'Content-Type: application/pgp-encrypted' \
			'Content-Description: PGP/MIME version identification' \
			'' \
			'Version: 1' \
			'' \
			'--=_gnupg_sealed_interop' \
			'Content-Type: application/octet-stream; name="encrypted.asc"' \
			'Content-Description: OpenPGP encrypted message' \
			'Content-Disposition: inline; filename="encrypted.asc"' \
			''
		armor_crlf "$3"
		crlf \
			'' \
			'--=_gnupg_sealed_interop--' \
			''
	} >"$4"
}
write_eml '...' 'gnupg-interop-0001' "$WORK/protected.asc" "$HERE/sealed-protected-headers.eml"
write_eml 'GnuPG interop without protected headers' 'gnupg-interop-0002' \
	"$WORK/plain.asc" "$HERE/sealed-no-protected-headers.eml"

# --- 5. Self-verify from the COMMITTED artifacts only ------------------------
# Fresh keyring, keys imported from the exported .asc files, ciphertext pulled
# back out of the .eml wrappers: proves the committed bytes are genuine,
# self-consistent GnuPG material (decrypts byte-equal, signature GOODSIG by the
# committed sender key). Exits non-zero on any mismatch.
gpg_verify --import \
	"$HERE/keys/sender.pub.asc" "$HERE/keys/recipient.pub.asc" \
	"$HERE/keys/recipient.sec.asc" 2>/dev/null

check() { # check <sealed-eml> <inner-file> <label>
	sed -n '/-----BEGIN PGP MESSAGE-----/,/-----END PGP MESSAGE-----/p' "$1" |
		tr -d '\r' >"$WORK/check.asc"
	local status decrypted="$WORK/check.out"
	rm -f "$decrypted"
	status="$(gpg_verify --status-fd 1 --trust-model always \
		--output "$decrypted" --decrypt "$WORK/check.asc" 2>/dev/null)"
	if ! grep -q "^\[GNUPG:\] VALIDSIG $SENDER_FPR " <<<"$status"; then
		echo "FAIL: $3: signature is not a VALIDSIG by the committed sender key" >&2
		exit 1
	fi
	if ! cmp -s "$decrypted" "$2"; then
		echo "FAIL: $3: decrypted plaintext is not byte-equal to $2" >&2
		exit 1
	fi
	echo "OK: $3 decrypts byte-equal with GOODSIG by $SENDER_FPR"
}
check "$HERE/sealed-protected-headers.eml" "$HERE/inner-protected-headers.eml" 'sealed-protected-headers.eml'
check "$HERE/sealed-no-protected-headers.eml" "$HERE/inner-no-protected-headers.eml" 'sealed-no-protected-headers.eml'

echo 'OK: all GnuPG interop fixtures are genuine and self-consistent'
