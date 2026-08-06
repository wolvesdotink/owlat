#!/usr/bin/env bash
#
# Provider-identity ratchet — the SEAMS plan's D2 ("capabilities, not identity;
# enforced by a ratchet, not vigilance").
#
# A send provider is described by the capability catalog
# (apps/api/convex/lib/sendProviders/catalog.ts) and discovered from config; it
# is never recognised by name. Code that asks `providerKind === 'ses'` has
# hard-coded one vendor into a seam that is supposed to read a declaration —
# which is how the four incumbents each grew private special cases (Inventory A
# of the plan: fallback eligibility, dispatch extras, relay identities, DNS
# mirroring, system mail, the deployment checklist). Every one of those is now a
# catalog lookup. This gate is what keeps them gone once the sweep is over.
#
# Sibling of scripts/check-cross-package-imports.sh: one grep-shaped invariant,
# plus a small checked-in allowlist (scripts/provider-identity-allowlist.txt)
# that is strict in BOTH directions, exactly like the file-size and dead-code
# baselines — an unlisted violation fails, and a listed file that no longer
# violates fails too, so the list can only ever shrink.
#
# WHAT IS SCANNED: every tracked .ts/.tsx/.vue under apps/ and packages/. The
# backend is where Inventory A lives, but it is not where the next leak will be:
# a sixth provider that needs no dispatch branch still gets a branch in the
# transport editor and one in the setup wizard unless something says no. Those
# are exactly the files the ecosystem goal (a provider ships as a plugin, with
# zero host edits) has to keep clean, so they are in scope from the start, with
# today's UI branches carried as named debt rather than as silence.
#
# Deliberately NOT scanned:
#   * adapter folders: any path segment named after a catalog kind
#     (lib/sendProviders/ses/**, domains/providers/mandrill/**,
#     integrationImports/providers/mandrill/**, …). Inside its own folder an
#     adapter IS that vendor; naming it there is the whole point of the folder.
#   * apps/mta/**: our own MTA is not a consumer of the provider catalog, it is
#     the transport BEHIND one kind. Its `'mta' | 'relay' | 'defer'` routing
#     decisions and `'smtp'` delivery outcomes are its own alphabets that happen
#     to share two spellings, so a kind ratchet reading them reads noise.
#   * tests and fixtures (__tests__/**, *.test.ts, *.spec.ts): a test's job is
#     often to drive one named kind through a kind-agnostic seam.
#   * migrations/**: a migration is a frozen replay of the schema as it stood on
#     its date. It is pinned to the kinds that existed then and must NOT follow
#     the catalog as it grows, so the ratchet has nothing to say about it.
#   * Convex's _generated/**.
#
# The stricter sibling is `apps/api/convex/lib/sendProviders/__tests__/
# kindLiteralCustody.test.ts`: over apps/api/convex ONLY, it also catches a kind
# DECLARATION (`const RELAY_IDENTITY_PROOF_KIND = 'ses'` — the same fact with one
# hop), and it makes every survivor name a family and an owner. Declarations are
# not a repo-wide rule (a catalog entry, an adapter, an event payload and a
# fixture all legitimately write their own name), which is why that half stays
# scoped to the backend and this gate carries the comparison half everywhere.
#
# WHAT IS MATCHED: a comparison against a kind LITERAL — `=== 'ses'`,
# `!== 'mta'`, `'resend' ===`, `case 'smtp':` — in code. The kind list is
# derived from SEND_TRANSPORT_KINDS in packages/shared, so a provider added to
# the catalog is ratcheted the day it is declared rather than the day someone
# remembers to update this script.
#
# Comments are stripped before matching. House style quotes the literal a seam
# USED to be spelled with (`this used to read providerType === 'ses'`) in the
# comment that explains the capability replacing it; that prose is the record of
# the sweep and must not be what a ratchet punishes. Stripping is line-based —
# `//` to end of line, block-comment lines opening with `*`, `/*` or `*/`, and
# a single-line `<!-- … -->` in a template — which can only ever HIDE a match (a
# false negative on the one-in-a-thousand line that puts `//` inside a string
# ahead of real code, or on a kind named inside a multi-line HTML comment),
# never invent one.

set -uo pipefail
cd "$(dirname "$0")/.."
# `comm` compares bytes; without this `sort` would order the two lists by the
# caller's collation (which ignores punctuation) and the comparison would drift.
export LC_ALL=C

allowlist_file="scripts/provider-identity-allowlist.txt"
SCAN_PATHS=(apps packages)

# The kinds, from their single declaration. Parsed rather than restated so the
# ratchet cannot drift from the catalog.
kinds_source="packages/shared/src"
kinds=$(grep -rhoE "SEND_TRANSPORT_KINDS[[:space:]]*=[[:space:]]*\[[^]]*\]" "$kinds_source" 2>/dev/null |
	grep -oE "'[a-z0-9_-]+'" | tr -d "'" | sort -u)
if [ -z "$kinds" ]; then
	echo "FAIL: could not read SEND_TRANSPORT_KINDS out of $kinds_source." >&2
	echo "The kind declaration moved or stopped being a literal array; point this" >&2
	echo "script at its new home so the ratchet keeps following the catalog." >&2
	exit 1
fi
kind_alt=$(printf '%s' "$kinds" | tr '\n' '|' | sed 's/|$//')

# `x === 'ses'`, `'ses' !== x`, `case 'ses':` — quotes single or double.
comparison="(===|!==|==|!=)[[:space:]]*['\"]($kind_alt)['\"]"
comparison="$comparison|['\"]($kind_alt)['\"][[:space:]]*(===|!==|==|!=)"
comparison="$comparison|case[[:space:]]+['\"]($kind_alt)['\"][[:space:]]*:"

# Any mention of a kind, quoted — the cheap pre-filter below. Deliberately much
# looser than `$comparison`: it has to catch the line a formatter split after
# the operator, which no per-line comparison regex can see.
literal="['\"]($kind_alt)['\"]"

# Template comments, `//` tails, and whole lines that are block-comment body.
strip_comments='s#<!--.*-->##; s#//.*$##; s#^[[:space:]]*\*.*$##; s#^[[:space:]]*/\*.*$##'

if [ ! -f "$allowlist_file" ]; then
	echo "FAIL: $allowlist_file is missing; the ratchet cannot tell a sanctioned" >&2
	echo "definitional site from a new leak without it." >&2
	exit 1
fi
allowed=$(grep -vE '^[[:space:]]*(#|$)' "$allowlist_file" | sed 's/[[:space:]]*$//' | sort -u)

# One pass over the tree to find the files worth reading properly (~200 of
# ~4500), then the exact test on those.
candidates=$(git ls-files -- "${SCAN_PATHS[@]}" | grep -E '\.(ts|tsx|vue)$' |
	tr '\n' '\0' | xargs -0 grep -lasE "$literal" 2>/dev/null)

violations=""
while IFS= read -r f; do
	[ -f "$f" ] || continue
	case "$f" in
		*/_generated/*) continue ;;
		*/__tests__/*) continue ;;
		*.test.ts | *.spec.ts) continue ;;
		*/migrations/*) continue ;;
		apps/mta/*) continue ;;
	esac
	# Adapter folder: a path segment named after a catalog kind.
	if [[ "$f" =~ (^|/)($kind_alt)/ ]]; then continue; fi
	# One line of lookback, because a long condition is formatted with the
	# operator at the end of one line and the literal alone on the next; a
	# per-line grep would call that clean.
	hits=$(sed "$strip_comments" "$f" | awk -v pat="$comparison" '
		{
			probe = $0
			if (prev ~ /(===|!==|==|!=)[[:space:]]*$/) probe = "=== " probe
			if (probe ~ pat) printf "%d:%s\n", NR, $0
			prev = $0
		}')
	[ -n "$hits" ] && violations="$violations$(printf '%s' "$hits" | sed "s#^#$f:#")"$'\n'
done < <(printf '%s\n' "$candidates")

violating_files=$(printf '%s' "$violations" | grep . | cut -d: -f1 | sort -u)
new=$(comm -23 <(printf '%s\n' "$violating_files" | grep . || true) <(printf '%s\n' "$allowed" | grep . || true))
stale=$(comm -13 <(printf '%s\n' "$violating_files" | grep . || true) <(printf '%s\n' "$allowed" | grep . || true))

fail=0
if [ -n "$new" ]; then
	count=$(printf '%s\n' "$new" | grep -c .)
	echo "FAIL: $count file(s) compare a provider kind against a literal:"
	echo ""
	printf '%s\n' "$new" | while IFS= read -r f; do
		[ -n "$f" ] || continue
		printf '%s' "$violations" | grep -a "^$f:" | sed 's#^#  #'
	done
	echo ""
	echo "Ask the capability, not the name: declare what the seam needs on the"
	echo "catalog entry (lib/sendProviders/catalog.ts) or on the provider module,"
	echo "and read it back through the accessor. Do NOT add a line to"
	echo "$allowlist_file: it enumerates the sites that predate the rule, with"
	echo "the owner that clears each one, and it only ever shrinks."
	fail=1
fi
if [ -n "$stale" ]; then
	count=$(printf '%s\n' "$stale" | grep -c .)
	echo "FAIL: $count stale entr(y/ies) in $allowlist_file (no kind literal left,"
	echo "or the file is gone):"
	echo ""
	echo "$stale"
	echo ""
	echo "Delete these lines — the allowlist only ever moves down."
	fail=1
fi
[ "$fail" -eq 1 ] && exit 1

allowed_count=$(printf '%s\n' "$allowed" | grep -c . || true)
echo "ok:   no provider-kind identity checks outside adapters ($allowed_count allowlisted site(s) remain)"
