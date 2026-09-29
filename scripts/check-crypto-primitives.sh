#!/usr/bin/env bash
#
# HMAC signing and constant-time comparison each have one home per runtime:
#
#   apps/api/convex/lib/crypto.ts          Convex (V8 isolate and 'use node'):
#                                          constantTimeEqual, secretMatches,
#                                          hmacSignature and the named helpers
#   packages/shared/src/constantTimeEqual.ts  Node services: constantTimeEqual,
#                                          secretMatches (@owlat/shared/constantTimeEqual)
#
# The MTA -> API request signature is signed by `@owlat/mta-protocol/signer`
# and verified by `apps/api/convex/webhooks/mtaSignature.ts` through lib/crypto.
#
# Private copies drifted: some compares returned early on a length mismatch,
# and each open-coded HMAC picked its own key import and encoding. This gate
# reports, outside the modules listed in ALLOWED below:
#
#   importKey(HMAC)   a Web Crypto `importKey(…)` call whose arguments name HMAC
#   sign(HMAC)        a Web Crypto `sign('HMAC', …)` call
#   timingSafeEqual   a `timingSafeEqual(` call from node:crypto
#
# across apps/ and packages/, excluding tests (__tests__, *.test.*, *.spec.*,
# *.testlib.*), generated code and build output. `examples/` is out of scope:
# those are standalone samples for plugin authors and cannot import workspace
# internals. Prose that names a spelling is not code and is not reported.
#
# Hard-0 with no baseline. A new entry in ALLOWED needs a reason a shared helper
# cannot serve; importing one of the helpers above is the fix in every other case.
#
#   bash scripts/check-crypto-primitives.sh              check, exit 1 on a hit
#   bash scripts/check-crypto-primitives.sh --generate   print hits, exit 0

set -uo pipefail
cd "$(dirname "$0")/.."

declare -A ALLOWED=(
	['apps/api/convex/lib/crypto.ts']='the Convex compare and HMAC'
	['packages/shared/src/constantTimeEqual.ts']='the Node compare'
	['apps/convex-fn-proxy/src/allowlist.ts']='hash-then-compare copy; the proxy has no workspace dependencies'
)

ROOTS=()
for root in apps packages; do
	[ -d "$root" ] && ROOTS+=("$root")
done
if [ ${#ROOTS[@]} -eq 0 ]; then
	echo "check-crypto-primitives: no apps/ or packages/ — run from the repository root" >&2
	exit 2
fi

generate() {
	find "${ROOTS[@]}" \
		\( -name node_modules -o -name dist -o -name .output -o -name .nuxt -o -name _generated \
		-o -name __tests__ -o -name target \) -prune -o \
		-type f \( -name '*.ts' -o -name '*.mts' -o -name '*.js' -o -name '*.mjs' -o -name '*.vue' \) \
		! -name '*.test.*' ! -name '*.spec.*' ! -name '*.testlib.*' ! -name '*.d.ts' \
		-print0 |
		xargs -0 -r perl -0777 -ne '
			# Blank out comments (keeping newlines so line numbers stay right),
			# so a docblock that names a spelling is not reported.
			s{/\*.*?\*/}{ (my $c = $&) =~ s/[^\n]//g; $c }gse;
			s{(^|[^:\x27"])//[^\n]*}{$1}g;
			my @hits;
			while (/\bimportKey\s*\([^;]*?[\x27"]HMAC[\x27"]/gs) { push @hits, [$-[0], "importKey(HMAC)"] }
			while (/\bsign\s*\(\s*[\x27"]HMAC[\x27"]/g) { push @hits, [$-[0], "sign(HMAC)"] }
			while (/\btimingSafeEqual\s*\(/g) { push @hits, [$-[0], "timingSafeEqual"] }
			for my $h (@hits) {
				my $line = 1 + (substr($_, 0, $h->[0]) =~ tr/\n//);
				print "$ARGV:$line:$h->[1]\n";
			}
		' | LC_ALL=C sort -t: -k1,1 -k2,2n
}

hits="$(generate)" || exit 2

if [ "${1:-}" = "--generate" ]; then
	[ -n "$hits" ] && printf '%s\n' "$hits"
	exit 0
fi

violations=""
while IFS= read -r hit; do
	[ -n "$hit" ] || continue
	file="${hit%%:*}"
	[ -n "${ALLOWED[$file]:-}" ] && continue
	violations+="  $hit"$'\n'
done <<<"$hits"

stale=""
for file in "${!ALLOWED[@]}"; do
	[ -f "$file" ] || stale+="  $file"$'\n'
done

status=0
if [ -n "$violations" ]; then
	echo "FAIL: HMAC or constant-time comparison outside the sanctioned modules:"
	printf '%s' "$violations"
	echo ""
	echo "Use the shared helper for the runtime instead of a private copy:"
	echo "  Convex:        import { constantTimeEqual, secretMatches, hmacSignature } from '<…>/lib/crypto'"
	echo "  Node services: import { constantTimeEqual, secretMatches } from '@owlat/shared/constantTimeEqual'"
	echo "  MTA -> API:    import { signMtaRequest } from '@owlat/mta-protocol/signer'"
	status=1
fi
if [ -n "$stale" ]; then
	echo "FAIL: ALLOWED in scripts/check-crypto-primitives.sh names file(s) that no longer exist:"
	printf '%s' "$stale"
	status=1
fi
[ "$status" -eq 0 ] && echo "ok:   HMAC signing and constant-time comparison stay in their sanctioned modules"
exit "$status"
