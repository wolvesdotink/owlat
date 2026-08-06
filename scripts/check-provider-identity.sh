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
# a listed site that no longer violates fails too, so a list can only shrink.
#
#   scripts/provider-identity-allowlist.txt — DEBT. Sites that predate the rule,
#     each under the family it belongs to and the piece that clears it. Drives to
#     zero; that count is what acceptance criterion A1 measures.
#   scripts/provider-identity-collisions.txt — NOT DEBT. Places where a kind's
#     spelling belongs to a different vocabulary (the MTA routing API's
#     'mta' | 'relay' | 'defer' answer, a docker compose profile name, the
#     contact-import source registry). Nothing clears these because there is no
#     coupling to remove; keeping them out of the debt list is what lets that
#     list reach zero.
#
# ENTRIES ARE `path` OR `path:literal`. A bare path licenses every kind literal
# in the file; `path:mta` licenses ONLY that spelling and leaves every other
# kind in the same file a violation. The collisions list is permanent, so a
# file-granular licence there would blind the gate forever — apply.post.ts is
# excused for one docker compose profile, and a real `kind === 'ses'` branch
# added to that same handler next year must still fail. Debt entries can be
# either: they are on their way out, so the coarse form costs nothing.
#
# WHAT IS SCANNED: every tracked .ts/.tsx/.vue under apps/, packages/ and
# examples/. The backend is where Inventory A lives, but it is not where the
# next leak will be: a sixth provider that needs no dispatch branch still gets a
# branch in the transport editor and one in the setup wizard unless something
# says no. examples/ is a workspace root (examples/plugins/*,
# examples/conformance) and the home of the plugin tier — the tier whose whole
# promise is that a provider ships without host edits, so a kind literal there
# is the loudest possible contradiction. Those are exactly the files the
# ecosystem goal has to keep clean, so they are in scope from the start, with
# today's UI branches carried as named debt rather than as silence.
#
# Deliberately NOT scanned:
#   * adapter bundles: a directory named after a catalog kind directly under one
#     of the ADAPTER_ROOTS below (lib/sendProviders/ses/**,
#     domains/providers/mandrill/**, integrationImports/providers/mandrill/**),
#     plus the file-per-kind layout of the same idea
#     (webhooks/adapters/ses.ts). Inside its own module an adapter IS that
#     vendor; naming it there is the whole point. The roots are listed rather
#     than "any path segment that spells a kind", because a kind-named directory
#     ANYWHERE would exempt exactly the thing this gate exists to stop — a
#     per-vendor UI bundle (apps/web/app/pages/setup/smtp/, a `ses/` folder of
#     dashboard panels) is a plausible next-provider shape and must fail. A new
#     adapter root therefore shows up as a false positive, which review fixes,
#     instead of as silence.
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
# The narrower sibling is `apps/api/convex/lib/sendProviders/__tests__/
# kindLiteralCustody.test.ts`: over apps/api/convex ONLY, it catches a kind
# DECLARATION (`const RELAY_IDENTITY_PROOF_KIND = 'ses'` — the same fact with one
# hop). Declarations are not a repo-wide rule (a catalog entry, an adapter, an
# event payload and a fixture all legitimately write their own name), which is
# why that half stays scoped to the backend. COMPARISONS ARE THIS SCRIPT'S RULE
# ALONE — that test used to restate them and no longer does, because two engines
# for one rule is two engines that disagree.
#
# WHAT IS MATCHED: a comparison against a kind LITERAL in code —
#   * `=== 'ses'`, `!== 'mta'`, `== 'resend'`, `'resend' === x`, `case 'smtp':`
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
# MATCHED OVER A THREE-LINE WINDOW, not per line. `bun run ox:fmt` breaks a long
# condition after the operator (`… .toLowerCase() ===` / `'resend'`) and prints a
# long membership test as an array over one line per element (`[` / `'ses',` /
# `'resend',` / `].includes(kind)`); a per-line grep calls all of that clean, so
# the gate would be one cosmetic reformat away from bypassable. The window is
# the stripped code of the previous two lines joined to the current one, and the
# hit is reported on the line that completes it.
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
SCAN_PATHS=(apps packages examples)
# The three per-kind bundle roots plus the file-per-kind webhook adapters. A
# directory named after a kind is an adapter only DIRECTLY under one of these.
ADAPTER_ROOTS=(lib/sendProviders domains/providers integrationImports/providers webhooks/adapters)

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
kind_words=$(printf '%s' "$kinds" | tr '\n' ' ')
root_alt=$(
	IFS='|'
	printf '%s' "${ADAPTER_ROOTS[*]}"
)

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
# `path  # note` keeps a per-entry note next to the entry rather than in a
# second copy of the list further up the file.
read_list() {
	{ grep -vE '^[[:space:]]*(#|$)' "$1" || true; } |
		sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]*$//' | sort -u
}

for list_file in "$allowlist_file" "$collisions_file"; do
	[ -f "$list_file" ] && continue
	echo "FAIL: $list_file is missing; the ratchet cannot tell a sanctioned site" >&2
	echo "from a new leak without it." >&2
	exit 1
done

allowed_debt=$(read_list "$allowlist_file")
allowed_collision=$(read_list "$collisions_file")

# `<list tag>\t<path>\t<literal or empty>`, the one form both halves below read.
split_entries() {
	awk -v tag="$1" '$0 != "" {
		path = $0
		literal = ""
		i = index(path, ":")
		if (i > 0) { literal = substr(path, i + 1); path = substr(path, 1, i - 1) }
		printf "%s\t%s\t%s\n", tag, path, literal
	}'
}
licences=$(
	printf '%s\n' "$allowed_debt" | split_entries allowlist
	printf '%s\n' "$allowed_collision" | split_entries collision
)

# A qualified entry whose literal is not a declared kind can never be used, so
# it would surface as a confusing "stale entry". Say what is actually wrong.
bad=$(printf '%s\n' "$licences" | awk -F'\t' -v kinds="$kind_words" '
	$3 != "" {
		n = split(kinds, k, " ")
		for (i = 1; i <= n; i++) if (k[i] == $3) next
		printf "  %s (in the %s list)\n", $2 ":" $3, $1
	}')
if [ -n "$bad" ]; then
	echo "FAIL: entr(y/ies) qualified by something that is not a declared kind:"
	echo ""
	echo "$bad"
	echo ""
	echo "The part after the colon must be one of: $kind_words"
	exit 1
fi

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
	# Adapter bundle: a kind-named directory directly under an adapter root…
	if [[ "$f" =~ (^|/)($root_alt)/($kind_alt)/ ]]; then continue; fi
	# …or the same bundle written one file per kind (webhooks/adapters/ses.ts).
	if [[ "$f" =~ (^|/)($root_alt)/($kind_alt)\.(ts|tsx|vue)$ ]]; then continue; fi
	# Comments are stripped by the state machine below, then the comparison is
	# tested over a three-line window, because the formatter breaks a long
	# condition after the operator and prints a long membership test one element
	# per line; a per-line grep would call both clean.
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
		function squeeze(s) {
			gsub(/[[:space:]]+/, " ", s)
			sub(/^ /, "", s)
			sub(/ $/, "", s)
			return s
		}
		# A match somewhere in the window is not a hit on THIS line: the two lines
		# of lookback also contain every comparison they made themselves, which is
		# reported where it happened. Only a match that ENDS inside the current
		# line is new, so walk the matches and keep the first one that does.
		function reaches(win, start,   off, s) {
			off = 0
			s = win
			while (match(s, pat)) {
				if (off + RSTART + RLENGTH - 1 >= start) return 1
				off += RSTART + RLENGTH - 1
				s = substr(s, RSTART + RLENGTH)
				if (s == "") return 0
			}
			return 0
		}
		{
			code = strip($0)
			win = two " " one " " code
			if (reaches(win, length(two) + length(one) + 3)) {
				if (code ~ pat) printf "%d:%s\n", NR, code
				else printf "%d:%s\n", NR, squeeze(win)
			}
			two = one
			one = code
		}
	' "$f")
	[ -n "$hits" ] && violations="$violations$(printf '%s' "$hits" | sed "s#^#$f:#")"$'\n'
done < <(printf '%s\n' "$candidates")

# Licensing is per LINE, not per file: a `path:literal` entry excuses only the
# lines whose kind literals it names, and any other kind on any other line of
# the same file is still a violation. `used` is the other direction — an entry
# that excused nothing has outlived its literal and has to go.
verdict=$(awk -F'\t' -v q="$q" -v kinds="$kind_words" '
	FNR == NR {
		if ($0 == "") next
		n++; tag[n] = $1; lpath[n] = $2; lit[n] = $3; used[n] = 0
		next
	}
	{
		if ($0 == "") next
		path = $0
		sub(/:.*/, "", path)
		nk = split(kinds, k, " ")
		delete present
		seen = 0
		for (i = 1; i <= nk; i++) {
			if ($0 ~ (q k[i] q)) { present[k[i]] = 1; seen++ }
		}
		full = 0
		for (e = 1; e <= n; e++) {
			if (lpath[e] != path) continue
			if (lit[e] == "") { full = 1; used[e] = 1; continue }
			if (lit[e] in present) { used[e] = 1; delete present[lit[e]] }
		}
		if (full) next
		left = 0
		for (x in present) left++
		if (seen == 0 || left > 0) printf "U\t%s\n", $0
	}
	END {
		for (e = 1; e <= n; e++) {
			if (used[e]) continue
			printf "S\t%s\t%s\n", tag[e], (lit[e] == "" ? lpath[e] : lpath[e] ":" lit[e])
		}
	}
' <(printf '%s\n' "$licences") <(printf '%s\n' "$violations"))

unlicensed=$(printf '%s\n' "$verdict" | { grep $'^U\t' || true; } | cut -f2-)
new=$(printf '%s\n' "$unlicensed" | grep . | cut -d: -f1 | sort -u)

fail=0
if [ -n "$new" ]; then
	count=$(printf '%s\n' "$new" | grep -c .)
	echo "FAIL: $count file(s) compare a provider kind against a literal:"
	echo ""
	printf '%s\n' "$new" | while IFS= read -r f; do
		[ -n "$f" ] || continue
		printf '%s\n' "$unlicensed" | grep -a "^$f:" | sed 's#^#  #'
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
	echo "$collisions_file as \`path:literal\`, with the vocabulary it actually"
	echo "speaks."
	fail=1
fi

# Both lists are strict in the other direction too: a licence that excused
# nothing has to go, or the next restatement inherits a pass it did not earn.
report_stale() {
	local label="$1" file="$2" tag="$3" stale count
	stale=$(printf '%s\n' "$verdict" | { grep $'^S\t'"$tag"$'\t' || true; } | cut -f3-)
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
report_stale "allowlist" "$allowlist_file" "allowlist"
report_stale "collision" "$collisions_file" "collision"

[ "$fail" -eq 1 ] && exit 1

debt_count=$(printf '%s\n' "$allowed_debt" | grep -c . || true)
collision_count=$(printf '%s\n' "$allowed_collision" | grep -c . || true)
echo "ok:   no provider-kind identity checks outside adapters ($debt_count allowlisted site(s) remain, $collision_count vocabulary collision(s))"
