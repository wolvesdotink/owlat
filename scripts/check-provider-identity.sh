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
# plus two small checked-in lists that are strict in BOTH directions, exactly
# like the file-size and dead-code baselines — an unlisted violation fails, and
# a listed file that no longer violates fails too, so a list can only shrink.
#
#   scripts/provider-identity-allowlist.txt — DEBT. Sites that predate the rule,
#     each with the family it belongs to and the piece that clears it. Drives to
#     zero; that count is what acceptance criterion A1 measures.
#   scripts/provider-identity-collisions.txt — NOT DEBT. Files where a kind's
#     spelling belongs to a different vocabulary (the MTA routing API's
#     'mta' | 'relay' | 'defer' answer, a docker compose profile name, the
#     contact-import source registry). Nothing clears these because there is no
#     coupling to remove; keeping them out of the debt list is what lets that
#     list reach zero.
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
#     integrationImports/providers/mandrill/**, …), plus the file-per-kind
#     layouts of the same idea (webhooks/adapters/ses.ts). Inside its own module
#     an adapter IS that vendor; naming it there is the whole point.
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
# kindLiteralCustody.test.ts`: over apps/api/convex ONLY, it catches a kind
# DECLARATION (`const RELAY_IDENTITY_PROOF_KIND = 'ses'` — the same fact with one
# hop). Declarations are not a repo-wide rule (a catalog entry, an adapter, an
# event payload and a fixture all legitimately write their own name), which is
# why that half stays scoped to the backend and this gate carries the comparison
# half everywhere. The two do not restate each other's lists: for comparisons
# inside apps/api/convex that test READS the two files above, so a swept file is
# de-licensed by exactly one deletion, here.
#
# WHAT IS MATCHED: a comparison against a kind LITERAL in code —
#   * `=== 'ses'`, `!== 'mta'`, `'resend' === x`, `case 'smtp':`
#   * membership, which is how a multi-kind question ("which kinds accept a
#     custom return path") gets written once `===` is blocked:
#     `x.includes('ses')`, `set.has('mta')`, `kind.startsWith('mta')`,
#     `['ses', 'resend'].includes(kind)`, `new Set(['ses']).has(kind)`
# in single quotes, double quotes or backticks. KNOWN LIMIT: an array of kinds
# bound to a name first (`const RELAY_KINDS = ['ses', 'resend']` … elsewhere …
# `RELAY_KINDS.includes(kind)`) is a kind DECLARATION, and declarations are the
# custody test's half — inside apps/api/convex it is caught there; outside it,
# nothing sees it. Widening this gate to every array literal that names a kind
# would flag the catalog, the presets and every `<option>` list, which is the
# declaration the whole plan wants code to read.
#
# The kind list is derived from SEND_TRANSPORT_KINDS in packages/shared, so a
# provider added to the catalog is ratcheted the day it is declared rather than
# the day someone remembers to update this script.
#
# Comments are stripped before matching. House style quotes the literal a seam
# USED to be spelled with (`this used to read providerType === 'ses'`) in the
# comment that explains the capability replacing it; that prose is the record of
# the sweep and must not be what a ratchet punishes. The stripper is a small
# state machine over `//` tails, `/* … */` (inline, trailing or spanning lines,
# with no assumption that continuation lines start with `*`) and `<!-- … -->`,
# so prose in any shape is invisible to the match. It does not parse strings, so
# a `//` or `/*` inside a string literal starts a comment as far as it is
# concerned: that direction only ever HIDES a match, never invents one.

set -uo pipefail
cd "$(dirname "$0")/.."
# `comm` compares bytes; without this `sort` would order the two lists by the
# caller's collation (which ignores punctuation) and the comparison would drift.
export LC_ALL=C

allowlist_file="scripts/provider-identity-allowlist.txt"
collisions_file="scripts/provider-identity-collisions.txt"
SCAN_PATHS=(apps packages)

# The kinds, from their single declaration. Parsed rather than restated so the
# ratchet cannot drift from the catalog. Each candidate file is flattened to one
# line first: the array is one line today, but a sixth kind pushes it past
# oxfmt's print width and the declaration wraps — a per-line grep would then
# report the declaration as missing and send the reader hunting for a move that
# never happened.
#
# NOTE FOR P1.1: when SEND_TRANSPORT_KINDS stops being a literal array and
# becomes a derivation from the catalog, this parser has to be repointed at the
# catalog's own declaration. It fails closed and says so, but the message below
# is the one to update alongside it.
kinds_source="packages/shared/src"
kinds=$(git ls-files -- "$kinds_source" | grep -E '\.ts$' |
	while IFS= read -r kf; do
		grep -q 'SEND_TRANSPORT_KINDS' "$kf" 2>/dev/null || continue
		tr '\n' ' ' <"$kf"
		printf '\n'
	done |
	grep -oE "SEND_TRANSPORT_KINDS[[:space:]]*=[[:space:]]*\[[^]]*\]" |
	grep -oE "'[a-z0-9_-]+'" | tr -d "'" | sort -u)
if [ -z "$kinds" ]; then
	echo "FAIL: could not read SEND_TRANSPORT_KINDS out of $kinds_source." >&2
	echo "The kind declaration moved or stopped being a literal array; point this" >&2
	echo "script at its new home so the ratchet keeps following the catalog." >&2
	exit 1
fi
kind_alt=$(printf '%s' "$kinds" | tr '\n' '|' | sed 's/|$//')

# Quotes: single, double or template.
q="['\"\`]"
# `x === 'ses'`, `'ses' !== x`, `case 'ses':`.
comparison="(===|!==|==|!=)[[:space:]]*$q($kind_alt)$q"
comparison="$comparison|$q($kind_alt)$q[[:space:]]*(===|!==|==|!=)"
comparison="$comparison|case[[:space:]]+$q($kind_alt)$q[[:space:]]*:"
# Membership: the shape the same question takes once `===` is blocked.
# `kinds.includes('ses')`, `set.has('mta')`, `kind.startsWith('mta')`.
comparison="$comparison|(includes|has|startsWith|endsWith)[(][[:space:]]*$q($kind_alt)$q"
# `['ses', 'resend'].includes(kind)`, `new Set(['ses']).has(kind)`.
comparison="$comparison|$q($kind_alt)$q[^]]*[]][[:space:]]*[)]?[[:space:]]*[.](includes|has)[(]"

# Any mention of a kind, quoted — the cheap pre-filter below. Deliberately much
# looser than `$comparison`: it has to catch the line a formatter split after
# the operator, which no per-line comparison regex can see.
literal="$q($kind_alt)$q"

# An empty list is a legitimate end state (that is what A1 asks for), so the
# no-match exit of the filter must not read as an error under `pipefail`.
read_list() {
	{ grep -vE '^[[:space:]]*(#|$)' "$1" || true; } | sed 's/[[:space:]]*$//' | sort -u
}

for list_file in "$allowlist_file" "$collisions_file"; do
	[ -f "$list_file" ] && continue
	echo "FAIL: $list_file is missing; the ratchet cannot tell a sanctioned site" >&2
	echo "from a new leak without it." >&2
	exit 1
done

allowed_debt=$(read_list "$allowlist_file")
allowed_collision=$(read_list "$collisions_file")
allowed=$(printf '%s\n%s\n' "$allowed_debt" "$allowed_collision" | grep . | sort -u)

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
	# The same bundle written one-file-per-kind (webhooks/adapters/ses.ts).
	if [[ "$f" =~ /(adapters|providers)/($kind_alt)\.(ts|tsx|vue)$ ]]; then continue; fi
	# Comments are stripped by the state machine below, then the comparison is
	# tested with one line of lookback, because a long condition is formatted
	# with the operator at the end of one line and the literal alone on the
	# next; a per-line grep would call that clean.
	hits=$(awk -v pat="$comparison" '
		function strip(s,   out, i, j, h, k) {
			out = ""
			while (1) {
				if (inblock) {
					k = index(s, "*/")
					if (k == 0) return out
					s = substr(s, k + 2)
					inblock = 0
					continue
				}
				if (inhtml) {
					k = index(s, "-->")
					if (k == 0) return out
					s = substr(s, k + 3)
					inhtml = 0
					continue
				}
				i = index(s, "//")
				j = index(s, "/*")
				h = index(s, "<!--")
				k = 0
				if (i > 0) k = i
				if (j > 0 && (k == 0 || j < k)) k = j
				if (h > 0 && (k == 0 || h < k)) k = h
				if (k == 0) return out s
				if (k == i) return out substr(s, 1, i - 1)
				out = out substr(s, 1, k - 1)
				if (k == j) {
					s = substr(s, k + 2)
					inblock = 1
				} else {
					s = substr(s, k + 4)
					inhtml = 1
				}
			}
		}
		{
			code = strip($0)
			probe = code
			if (prev ~ /(===|!==|==|!=)[[:space:]]*$/) probe = "=== " probe
			if (probe ~ pat) printf "%d:%s\n", NR, code
			prev = code
		}
	' "$f")
	[ -n "$hits" ] && violations="$violations$(printf '%s' "$hits" | sed "s#^#$f:#")"$'\n'
done < <(printf '%s\n' "$candidates")

violating_files=$(printf '%s' "$violations" | grep . | cut -d: -f1 | sort -u)
new=$(comm -23 <(printf '%s\n' "$violating_files" | grep . || true) <(printf '%s\n' "$allowed" | grep . || true))

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
	echo ""
	echo "If the literal is NOT a provider kind — the MTA routing API's answer, a"
	echo "docker compose profile, a contact-import source — it belongs in"
	echo "$collisions_file with the vocabulary it actually speaks."
	fail=1
fi

# Both lists are strict in the other direction too: a licence whose file no
# longer violates has to go, or the next restatement inherits a pass it did not
# earn.
check_stale() {
	local label="$1" file="$2" list="$3" stale count
	stale=$(comm -13 <(printf '%s\n' "$violating_files" | grep . || true) <(printf '%s\n' "$list" | grep . || true))
	[ -n "$stale" ] || return 0
	count=$(printf '%s\n' "$stale" | grep -c .)
	echo "FAIL: $count stale $label entr(y/ies) in $file (no kind literal left,"
	echo "or the file is gone):"
	echo ""
	echo "$stale"
	echo ""
	echo "Delete these lines — the list only ever moves down."
	fail=1
}
check_stale "allowlist" "$allowlist_file" "$allowed_debt"
check_stale "collision" "$collisions_file" "$allowed_collision"

[ "$fail" -eq 1 ] && exit 1

debt_count=$(printf '%s\n' "$allowed_debt" | grep -c . || true)
collision_count=$(printf '%s\n' "$allowed_collision" | grep -c . || true)
echo "ok:   no provider-kind identity checks outside adapters ($debt_count allowlisted site(s) remain, $collision_count vocabulary collision(s))"
