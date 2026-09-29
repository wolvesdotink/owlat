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
# One implementation per runtime keeps every compare and every HMAC behaving
# the same way. This gate reports, outside the modules listed in ALLOWED below:
#
#   importKey(HMAC)                a Web Crypto `importKey(…)` call whose algorithm
#                                  argument is 'HMAC' or `{ name: 'HMAC', … }`
#   importKey(variable algorithm)  an `importKey(…)` call whose algorithm is not a
#                                  literal (a variable, or an object whose `name`
#                                  is not a string literal), since it may be HMAC
#   sign(HMAC), verify(HMAC)       a Web Crypto `sign('HMAC', …)` / `verify('HMAC', …)`
#   timingSafeEqual                any reference to node:crypto's `timingSafeEqual`
#                                  in code: a call, an import (aliased or not), a
#                                  destructuring, or a property access
#   xor-compare                    a hand-written XOR-accumulate compare, the
#                                  `acc |= a ^ b` / `acc = acc | (a ^ b)` loop body
#
# across .ts, .tsx, .mts, .cts, .js, .jsx, .mjs, .cjs and .vue files under apps/
# and packages/, excluding tests (__tests__, *.test.*, *.spec.*, *.testlib.*),
# declaration files, generated code and build output. `examples/` is out of
# scope: those are standalone samples for plugin authors and cannot import
# workspace internals. Prose in comments that names a spelling is not reported.
#
# It is a pattern check, not a proof. It does not see Node's `createHmac`, an
# HMAC key reached through `deriveKey`/`generateKey`, a `sign`/`verify` whose
# algorithm is a variable, or a compare loop written some other way. Review new
# crypto code against the sanctioned modules too.
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
		-type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.cts' \
		-o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.vue' \) \
		! -name '*.test.*' ! -name '*.spec.*' ! -name '*.testlib.*' \
		! -name '*.d.ts' ! -name '*.d.mts' ! -name '*.d.cts' \
		-print0 |
		xargs -0 -r perl -0777 -ne '
			# Blank out comments (keeping newlines so line numbers stay right),
			# so a docblock that names a spelling is not reported.
			s{/\*.*?\*/}{ (my $c = $&) =~ s/[^\n]//g; $c }gse;
			s{(^|[^:\x27"])//[^\n]*}{$1}g;
			my @hits;
			# importKey: read the third argument (the algorithm), walking the call
			# with its brackets and string literals balanced.
			while (/\bimportKey\s*\(/g) {
				my ($start, $i) = ($-[0], $+[0]);
				my ($depth, $quote, $current, @args) = (0, "", "");
				while ($i < length) {
					my $c = substr($_, $i, 1);
					if ($quote ne "") {
						$current .= $c;
						if ($c eq "\\") { $current .= substr($_, $i + 1, 1); $i += 2; next }
						$quote = "" if $c eq $quote;
					} elsif ($c eq "\x27" || $c eq "\"" || $c eq "`") {
						$quote = $c; $current .= $c;
					} elsif ($c =~ /[(\[{]/) {
						$depth++; $current .= $c;
					} elsif ($c =~ /[)\]}]/) {
						if ($depth == 0) { push @args, $current; last }
						$depth--; $current .= $c;
					} elsif ($c eq "," && $depth == 0) {
						push @args, $current; $current = "";
					} else {
						$current .= $c;
					}
					$i++;
				}
				next if @args < 3;
				(my $algorithm = $args[2]) =~ s/^\s+|\s+$//g;
				my $name;
				if ($algorithm =~ /^[\x27"]([^\x27"]*)[\x27"]$/) { $name = $1 }
				elsif ($algorithm =~ /^\{/ && $algorithm =~ /\bname\s*:\s*[\x27"]([^\x27"]*)[\x27"]/) { $name = $1 }
				if (!defined $name) { push @hits, [$start, "importKey(variable algorithm)"] }
				elsif (uc $name eq "HMAC") { push @hits, [$start, "importKey(HMAC)"] }
			}
			while (/\b(sign|verify)\s*\(\s*[\x27"]HMAC[\x27"]/g) { push @hits, [$-[0], "$1(HMAC)"] }
			while (/\btimingSafeEqual\b/g) { push @hits, [$-[0], "timingSafeEqual"] }
			while (/\b[A-Za-z_\$][\w\$]*\s*\|=[^;\n]*\^/g) { push @hits, [$-[0], "xor-compare"] }
			while (/\b([A-Za-z_\$][\w\$]*)\s*=\s*\1\s*\|[^|][^;\n]*\^/g) { push @hits, [$-[0], "xor-compare"] }
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
