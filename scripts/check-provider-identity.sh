#!/usr/bin/env bash
#
# Provider-identity ratchet — the SEAMS plan's D2 ("capabilities, not identity;
# enforced by a ratchet, not vigilance").
#
# A send provider is described by the capability catalog
# (packages/shared/src/sendProviderCatalog.ts, joined to its adapters by
# apps/api/convex/lib/sendProviders/catalog.ts) and discovered from config; it
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
#   * tests: __tests__/**, *.test.{ts,tsx,vue}, *.spec.{ts,tsx,vue}, and the
#     Playwright tree */e2e/** — its page objects and seeded data are scaffolding
#     for specs that are already exempt, and exempting the spec but not the page
#     object it drives is a line nobody can act on. A test's job is often to drive
#     one named kind through a kind-agnostic seam. That list is exhaustive: a
#     module merely NAMED fixtures (packages/email-renderer/src/preview/
#     fixtures.ts) ships, so it is scanned like any other source file.
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
#     `kinds.indexOf('ses') !== -1`, `['ses', 'resend'].includes(kind)`,
#     `new Set(['ses']).has(kind)`, `['ses', 'resend'].some((k) => k === kind)`
# in single quotes, double quotes or backticks. KNOWN LIMIT: an array of kinds
# bound to a name first (`const RELAY_KINDS = ['ses', 'resend']` … elsewhere …
# `RELAY_KINDS.includes(kind)`) is a kind DECLARATION, and declarations are the
# custody test's half — inside apps/api/convex it is caught there; outside it,
# nothing sees it. Widening this gate to every array literal that names a kind
# would flag the catalog, the presets and every `<option>` list, which is the
# declaration the whole plan wants code to read.
#
# The kind list is parsed from the catalog entries in packages/shared, so a
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
# so prose in any shape is invisible to the match.
#
# IT TRACKS STRINGS TOO, because the alternative fails OPEN. A `//` inside a
# string is not a comment: a provider doc link on the same line as a branch
# (`href="https://docs.aws…"` next to `provider === 'ses'`) would hide it, and
# those links live in exactly the per-vendor panels this gate carries as debt. A
# `/*` inside a string is worse — `accept = "*/*"` would open a block comment
# that never closes, and every line below it in the file would go unread. So
# string content is kept and comment openers inside it are ignored, with `\`
# escapes honoured; quoted strings are forgotten at the newline (an unbalanced
# apostrophe in Vue prose is not an opener) and template literals are carried
# across lines. If the machine still ends a file inside a comment or a string —
# which no compiling source file does — the run FAILS rather than pretending the
# unread remainder was clean.

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

# The kinds, from their single declaration: the catalog entries themselves
# (P1.1 / D1 — SEND_TRANSPORT_KINDS is now `CATALOG.map(entry => entry.kind)`,
# so there is no literal array left to read). Parsed rather than restated so the
# ratchet cannot drift from the catalog.
#
# TWO ANCHORS, BOTH LOAD-BEARING. The region is bounded by the catalog literal's
# own delimiters, and inside it only a `kind:` at exactly TWO tabs counts — the
# indentation of an ENTRY. Credential-field descriptors nested one level deeper
# have a `kind:` too (`kind: 'secret'`, `kind: 'host-port'`), and reading those
# as transport kinds would turn `=== 'string'` anywhere in the repo into a
# provider-identity violation. The docs-lint over the same literal anchors on the
# same two tabs, for the same reason, and has exactly one parser for both suites
# that need it: apps/docs/__tests__/catalogSource.ts. This script cannot import
# it — it runs before any TypeScript does — so it is the ONE deliberate second
# reader, and the entry shape is a contract between these two places.
#
# A PARTIAL PARSE IS A FAILURE, NOT A SHORTER LIST. The array this replaced was
# read as ONE match, so a format change made the read EMPTY and tripped the
# fail-closed branch below. A per-line parser has a third outcome the array had
# not: it can read four kinds out of five, leave `kinds` non-empty, print `ok:`
# and un-ratchet every `=== '<the fifth>'` in the repo with no signal — the
# "vigilance, not a ratchet" failure D2 exists to prevent, made invisible by a
# green gate. So the entry OPENINGS inside the same region are counted too, and
# a disagreement between the two counts fails exactly like reading nothing.
kinds_source="packages/shared/src/sendProviderCatalog.ts"
catalog_block=$(sed -n "/^const CORE_SEND_PROVIDER_CATALOG = \[$/,/^\] as const satisfies/p" \
	"$kinds_source" 2>/dev/null)
# A trailing `//` note on the declaration line is tolerated: house style comments
# a new entry, and a gate that fails on a comment is a gate people route around.
kinds=$(printf '%s\n' "$catalog_block" |
	sed -nE "s|^		kind: '([a-z0-9_-]+)',([[:space:]]*//.*)?$|\1|p" | sort -u)
# `^\t{` UNANCHORED at the end on purpose: an entry written on ONE line
# (`\t{ kind: 'postmark', label: 'X' },`) opens the same way, carries a `kind:`
# the two-tab anchor cannot see, and would otherwise balance the counts by being
# invisible to both sides.
entry_count=$(printf '%s\n' "$catalog_block" | { grep -c "^	{" || true; })
kind_count=$(printf '%s\n' "$kinds" | { grep -c . || true; })
if [ -z "$kinds" ] || [ "$kind_count" -ne "$entry_count" ]; then
	echo "FAIL: could not read the send-provider kinds out of $kinds_source" >&2
	echo "(read $kind_count kind(s) out of $entry_count entr(y/ies))." >&2
	echo "The catalog moved, an entry's \`kind:\` is not a lone two-tab line with a" >&2
	echo "lowercase literal, or its entries stopped being a literal array. Fix the" >&2
	echo "entry or point this script at their new home — a kind the parser drops is a" >&2
	echo "kind nothing ratchets." >&2
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
# `kinds.includes('ses')`, `set.has('mta')`, `kind.startsWith('mta')`,
# `kinds.indexOf('ses') !== -1`. `lastIndexOf` is spelled out rather than left to
# fall out of `indexOf`: the capital I means it does not contain it.
comparison="$comparison|(includes|has|startsWith|endsWith|indexOf|lastIndexOf)[(][[:space:]]*$q($kind_alt)$q"
# `['ses', 'resend'].includes(kind)`, `new Set(['ses']).has(kind)`,
# `['ses', 'resend'].some((k) => k === kind)` — an inline array of kinds is the
# question whichever consultation follows it, so `some`/`find`/`filter` count.
comparison="$comparison|$q($kind_alt)$q[^]]*[]][[:space:]]*[)]?[[:space:]]*[.](includes|has|some|find|filter)[(]"

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
unterminated=""
while IFS= read -r f; do
	[ -f "$f" ] || continue
	case "$f" in
		*/_generated/*) continue ;;
		*/__tests__/*) continue ;;
		*.test.ts | *.test.tsx | *.test.vue) continue ;;
		*.spec.ts | *.spec.tsx | *.spec.vue) continue ;;
		*/e2e/*) continue ;;
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
		# Comment stripper. It tracks STRING state too, for one reason: a `//` or a
		# `/*` inside a string literal is not a comment opener, and reading it as
		# one is the fail-open direction. A doc link (`href="https://docs.aws…"`)
		# would swallow the rest of its line, and a glob (`accept = "*/*"`) would
		# open a block comment that never closes and blind the ratchet to the whole
		# rest of the file. String CONTENT is kept, not stripped: the literals this
		# gate matches ARE strings.
		function strip(s,   out, i, n, ch, pair) {
			out = ""
			i = 1
			n = length(s)
			while (i <= n) {
				ch = substr(s, i, 1)
				if (inblock) {
					if (substr(s, i, 2) == "*/") { inblock = 0; i += 2 } else i++
					continue
				}
				if (inhtml) {
					if (substr(s, i, 3) == "-->") { inhtml = 0; i += 3 } else i++
					continue
				}
				if (instr != "") {
					out = out ch
					# A backslash escapes the next character, so `it\047s` inside
					# single quotes does not end the string where it appears to.
					if (ch == "\\") { out = out substr(s, i + 1, 1); i += 2; continue }
					if (ch == instr) instr = ""
					i++
					continue
				}
				pair = substr(s, i, 2)
				if (pair == "//") break
				if (pair == "/*") { inblock = 1; i += 2; continue }
				if (substr(s, i, 4) == "<!--") { inhtml = 1; i += 4; continue }
				if (ch == "\047" || ch == "\"" || ch == "`") instr = ch
				out = out ch
				i++
			}
			# A quoted string cannot span lines in TS, so an unbalanced quote is
			# prose — an apostrophe in a Vue text node, a quote inside a regex
			# character class — and forgetting it at the newline keeps the blast
			# radius to that line. A template literal DOES span lines, so that state
			# is remembered across them; if it never closes, the END rule below
			# fails the file rather than letting the remainder go unread.
			if (instr == "\047" || instr == "\"") instr = ""
			return out
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
		# FAIL CLOSED ON A STRIPPER THAT LOST ITS PLACE. A source file cannot end
		# inside a block comment, an HTML comment or a template literal and still
		# compile, so if the state machine thinks it did, the machine is wrong —
		# and being wrong in that direction means every line after the mistake was
		# read as comment and never matched. That is the silent failure a ratchet
		# cannot afford, so it is reported instead of assumed harmless.
		END {
			if (inblock) printf "!unterminated\tblock comment\n"
			else if (inhtml) printf "!unterminated\tHTML comment\n"
			else if (instr != "") printf "!unterminated\ttemplate literal\n"
		}
	' "$f")
	case "$hits" in
		*'!unterminated'*)
			state=$(printf '%s\n' "$hits" | { grep -a '^!unterminated' || true; } | cut -f2-)
			unterminated="$unterminated  $f (inside a $state at end of file)"$'\n'
			hits=$(printf '%s\n' "$hits" | { grep -av '^!unterminated' || true; })
			;;
	esac
	[ -n "$hits" ] && violations="$violations$(printf '%s' "$hits" | sed "s#^#$f:#")"$'\n'
done < <(printf '%s\n' "$candidates")

if [ -n "$unterminated" ]; then
	echo "FAIL: the comment/string stripper reached the end of these file(s) still"
	echo "inside a comment or a string:"
	echo ""
	printf '%s' "$unterminated"
	echo ""
	echo "No compiling source file ends that way, so the stripper misread"
	echo "something — and everything after the point where it lost its place went"
	echo "unchecked. Fix the state machine in this script (or the file, if it"
	echo "really is malformed); do not leave the gate reading half a file."
	exit 1
fi

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
