#!/usr/bin/env bash
#
# The one list of public Convex function builders, derived from source.
#
# Five lint gates (check-permissions, check-query-authz, check-session-threading,
# check-token-redaction, check-errors) each need "which `export const X =
# <builder>(` lines are public functions, and what floor does <builder>
# enforce?". Each used to type its own builder list by hand, and the lists
# drifted: check-errors missed postboxQuery/postboxMutation (111 definitions
# outside the gate), check-token-redaction missed chatQuery/assistantQuery/
# adminQuery. A new `featureGated(authedMutation, 'x')` builder, which
# CONVENTIONS.md encourages, had to be added to five regexes, and missing
# check-permissions let a state-changing mutation with no authorization
# decision pass CI.
#
# Sourced by those gates (after they `cd` to apps/api). It derives:
#
#   * the base builders: every `export const <name> =` in
#     convex/lib/authedFunctions.ts, classified by CONVEX_BASE_BUILDERS below.
#     An export that the table does not classify, or a table row that is no
#     longer exported, fails the derivation (and so every gate) loudly;
#   * the compositions: every `(export )?const <name> = featureGated(Any)?(<base>,`
#     under convex/ (non-exported ones too: assistantQuery/assistantMutation in
#     assistant/conversations.ts are file-local). A composition inherits its
#     base's kind and floor, because a feature flag is not an authorization
#     decision.
#
# Each row is `name<TAB>kind<TAB>floor`:
#   kind   query | mutation | action
#   floor  member    authenticated org member, any role (the floor alone is NOT
#                    an authorization decision)
#          role      owner/admin baked into the wrapper
#          identity  authenticated identity, no org membership
#          public    no floor at all
#
# Run it directly to print the table: `bash scripts/lib/convex-builders.sh`.
# scripts/__tests__/convex-builders.test.ts pins the table against the source.

# name kind floor, one row per base builder exported by lib/authedFunctions.ts.
# featureGated / featureGatedAny are `export function`s, not builders, so they
# never appear here.
CONVEX_BASE_BUILDERS='authedQuery query member
authedMutation mutation member
authedAction action member
authedIdentityMutation mutation identity
adminQuery query role
adminMutation mutation role
ownerMutation mutation role
publicQuery query public
publicMutation mutation public
publicAction action public'

# The recognized in-handler authorization gates: each throws unless the caller
# may run the function. check-permissions and check-query-authz accept any of
# them as the definition's authorization decision. Add a new gate helper here.
#   requirePermission / requireAdminContext / requireOwnerContext /
#   requireOrgPermission          org-role RBAC, lib/sessionOrganization.ts
#   requireCampaignSendersManage  campaigns/guards.ts
#   requireContactsManage         contacts/guards.ts
#   requireMailboxAccess / requireMessageAccess
#                                 per-user mail access, mail/*
#   assertCanReadRoom / assertCanWriteRoom / assertCanAdministerRoom
#                                 team-chat membership, chat/_helpers.ts
#   requirePlatformAdmin          platform operator, platformAdmin/platformAdmin.ts
CONVEX_AUTHZ_GATES='requirePermission|requireAdminContext|requireOwnerContext|requireOrgPermission|requireCampaignSendersManage|requireContactsManage|requireMailboxAccess|requireMessageAccess|assertCanReadRoom|assertCanWriteRoom|assertCanAdministerRoom|requirePlatformAdmin'

# Soft-fail read predicates: each answers "may this caller read this?" and its
# callers return empty on `false`. Accepted by check-query-authz only (see the
# caveats there); a write must throw.
CONVEX_AUTHZ_READ_PREDICATES='isActiveOrgMember|isSharedInboxReader|loadReadableMailbox|loadReadableMessage|loadAccessibleMailboxes'

# convex_builders [convex_root]
# Print one `name<TAB>kind<TAB>floor` row per public builder: the base builders
# in table order, then the compositions in path order. Exits 1 with a message
# on stderr when the source and the table disagree or a composition's base is
# unknown, so a gate never runs against a silently shrunken builder set.
convex_builders() {
	local root="${1:-convex}"
	local source="$root/lib/authedFunctions.ts"
	if [[ ! -f "$source" ]]; then
		echo "convex-builders: $source not found; cannot derive the builder list." >&2
		return 1
	fi

	local compositions
	compositions=$(grep -rlE --include='*.ts' 'featureGated(Any)?\(' "$root" \
		| grep -v '/_generated/' \
		| grep -v '/__tests__/' \
		| grep -v '\.test\.ts$' \
		| grep -vxF "$source" \
		| LC_ALL=C sort || true)

	# shellcheck disable=SC2086 # file paths under convex/ carry no whitespace
	awk -v bases="$CONVEX_BASE_BUILDERS" -v src="$source" '
		function fail(msg) { print "convex-builders: " msg > "/dev/stderr"; bad = 1 }
		function compose(file, line, name, base) {
			if ((name in comp_base) && comp_base[name] != base) {
				fail(file ":" line ": " name " is composed from " base " here and from " comp_base[name] " in " comp_at[name])
				return
			}
			if (!(name in comp_base)) comp_names[++ncomp] = name
			comp_base[name] = base
			comp_at[name] = file ":" line
		}
		BEGIN {
			nbase = split(bases, rows, "\n")
			for (i = 1; i <= nbase; i++) {
				split(rows[i], f, " ")
				base_names[i] = f[1]; kind[f[1]] = f[2]; floor[f[1]] = f[3]
			}
		}
		FILENAME == src {
			if ($0 ~ /^export const [A-Za-z0-9_]+ =/) {
				exported[$3] = 1
				if (!($3 in kind)) fail(FILENAME ":" FNR ": export " $3 " is not classified; add it to CONVEX_BASE_BUILDERS in scripts/lib/convex-builders.sh")
			}
			next
		}
		# `const x = featureGated(` wrapped by the formatter: the base is the first
		# identifier on the next line.
		pending != "" {
			base = $0; sub(/^[[:space:]]*/, "", base); sub(/[^A-Za-z0-9_].*$/, "", base)
			compose(FILENAME, pending_line, pending, base)
			pending = ""
		}
		/^(export )?const [A-Za-z0-9_]+ = featureGated(Any)?\(/ {
			line = $0; sub(/^export /, "", line); sub(/^const /, "", line)
			name = line; sub(/[^A-Za-z0-9_].*$/, "", name)
			base = line; sub(/^[^(]*\(/, "", base); sub(/^[[:space:]]*/, "", base); sub(/[^A-Za-z0-9_].*$/, "", base)
			if (base == "") { pending = name; pending_line = FNR } else compose(FILENAME, FNR, name, base)
		}
		END {
			for (i = 1; i <= nbase; i++)
				if (!(base_names[i] in exported))
					fail(src ": CONVEX_BASE_BUILDERS lists " base_names[i] ", which is no longer exported; delete its row")
			# A composition may wrap another composition: resolve until stable.
			do {
				changed = 0
				for (i = 1; i <= ncomp; i++) {
					n = comp_names[i]
					if (!(n in kind) && (comp_base[n] in kind)) {
						kind[n] = kind[comp_base[n]]; floor[n] = floor[comp_base[n]]; changed = 1
					}
				}
			} while (changed)
			for (i = 1; i <= ncomp; i++)
				if (!(comp_names[i] in kind))
					fail(comp_at[comp_names[i]] ": " comp_names[i] " composes unknown builder " comp_base[comp_names[i]])
			if (bad) exit 1
			for (i = 1; i <= nbase; i++) printf "%s\t%s\t%s\n", base_names[i], kind[base_names[i]], floor[base_names[i]]
			for (i = 1; i <= ncomp; i++) printf "%s\t%s\t%s\n", comp_names[i], kind[comp_names[i]], floor[comp_names[i]]
		}
	' "$source" $compositions
}

# convex_builder_regex <kinds> <floors> [convex_root]
# Print the builders whose kind matches <kinds> and floor matches <floors>
# (each an ERE alternation such as 'mutation|action', or '.*' for any) as one
# `a|b|c` alternation, ready for `^export const [A-Za-z0-9_]+ = (<regex>)\(`.
# Exits 1 when the derivation fails or selects nothing.
convex_builder_regex() {
	local kinds="$1" floors="$2" root="${3:-convex}" table regex
	table=$(convex_builders "$root") || return 1
	regex=$(printf '%s\n' "$table" \
		| awk -F '\t' -v kinds="^(${kinds})\$" -v floors="^(${floors})\$" \
			'$2 ~ kinds && $3 ~ floors { printf "%s%s", sep, $1; sep = "|" }')
	if [[ -z "$regex" ]]; then
		echo "convex-builders: no builder has kind '$kinds' and floor '$floors'." >&2
		return 1
	fi
	printf '%s\n' "$regex"
}

# convex_defs_program <fragment>
# Print the shared span scanner (scripts/lib/convex-defs.awk) followed by a
# check's hook fragment, as one awk program text.
CONVEX_DEFS_AWK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/convex-defs.awk"
convex_defs_program() {
	cat "$CONVEX_DEFS_AWK" || return 1
	printf '\n%s\n' "$1"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	set -uo pipefail
	cd "$(dirname "$0")/../.." || exit 1
	convex_builders "${1:-convex}"
fi
