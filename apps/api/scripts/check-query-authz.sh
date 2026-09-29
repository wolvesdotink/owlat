#!/usr/bin/env bash
# Requires every public **read** Convex function to make an explicit
# authorization decision — the query-side sibling of check-permissions.sh.
#
# `authedQuery` only enforces the *floor* — an authenticated org member (any
# role, including `editor`). Most reads are legitimately member-visible, but a
# read that should be owner/admin-only (shared-inbox content, audit data,
# credential envelopes) and forgets its gate silently exposes that data to
# every member. check-permissions.sh deliberately covers only state-changing
# functions, so query-side authorization had NO ci gate — this script closes
# that gap (the `unifiedMessages.listRecent` escalation slipped through it).
#
# A site passes when it does ONE of:
#
#   * calls a recognized authorization gate inside the handler (the shared
#     CONVEX_AUTHZ_GATES list in scripts/lib/convex-builders.sh, the same one
#     check-permissions.sh accepts), or one of the soft-fail read predicates
#     below (CONVEX_AUTHZ_READ_PREDICATES, same file);
#   * carries an explicit opt-out comment — inside the handler body, or on the
#     line directly above the `export const`:
#       // authz: <why this needs no role check / where the gate actually lives>
#       // all-members: <why every org member may legitimately read this>
#   * is listed in scripts/query-authz-baseline.txt — the frozen pre-existing
#     debt (file:name pairs). Unlike the mutation gate this is a RATCHET, not a
#     baseline-0 hard gate: 160 queries predate the rule and annotating them
#     wholesale would rubber-stamp real authorization questions. New queries
#     must decide; baseline queries should lose their entry as they're reviewed.
#
# The comparison lives in scripts/ratchet.sh and is strict in both directions:
# an unlisted violation fails (new query without a decision), and a stale
# baseline entry fails (the query was fixed/removed — delete its line so the
# debt count only goes down).
#
# `publicQuery` / `publicAction` are covered too, and are the reason this gate
# was nearly blind: they are the dominant shape for authenticated reads in
# postbox/inbox/knowledge (90-odd exports), where the auth floor is deliberately
# absent so the read can soft-fail — return empty/null for an anonymous or
# non-member caller — instead of throwing. The decision then lives entirely in
# the handler, which is exactly the thing that can be forgotten. The
# `// public: <reason>` note check-public-functions.sh requires is NOT accepted
# as the decision here: it says the endpoint is public on purpose, not who may
# read the data, and taking it would make this gate a no-op for every one of
# them.
#
# The soft-fail predicates below are recognized as gates alongside the throwing
# ones, because each one answers "may this caller read this?" and its callers
# return empty on `false`:
#
#   isActiveOrgMember      lib/sessionOrganization.ts — authenticated ACTIVE member
#   isSharedInboxReader    inbox/access.ts — owner/admin, the shared-inbox reader rule
#   resolveKnowledgeViewer knowledge/graph.ts — `ai.knowledge` on and an active
#                          member; carries the reader rule for inbox-derived entries
#   loadReadableMailbox    mail/permissions.ts — requireMailboxAccess collapsed to a doc|null
#   loadReadableMessage    mail/mailbox/messages.ts — the same, keyed by message id
#   loadAccessibleMailboxes mail/permissions.ts — the caller's own + shared-member mailboxes
#
# Two of those are weaker than they look, and a REVIEWER still has to check the
# call site — the token only proves the handler asked the question:
#
#   loadAccessibleMailboxes (mail/permissions.ts:181) is a SCOPING helper, not
#   an authorization check. It takes `userId` / `organizationId` as plain
#   arguments and lists that user's mailboxes; it counts as a decision only
#   when both come from the caller's resolved session. Fed from `args`, it
#   would enumerate someone else's inbox and still satisfy this grep.
#
#   isSharedInboxReader (inbox/access.ts) type-guards a session OBJECT handed
#   to it, so it is only as good as where that object came from — the same
#   caveat, weaker, because every current caller resolves it via
#   getBetterAuthSessionWithRole one line above.
#
# A soft-auth read whose gate lives one hop away (an internal query run with the
# inherited identity, or a handler extracted to another module) is invisible
# here by construction, so it carries the `// authz: <where the gate lives>`
# opt-out instead.
#
# The scanned builders are every query builder with a MEMBER floor plus
# `publicQuery` / `publicAction`, derived from source by
# scripts/lib/convex-builders.sh. That takes in every `featureGated(Any)`
# composition of `authedQuery` (`chatQuery`, `assistantQuery`, `postboxQuery`,
# and the next one): a FEATURE flag is NOT an authorization decision, so they
# stay SUBJECT to this ratchet exactly like a bare `authedQuery`. The
# pre-existing chat reads keep their baseline entries until each is
# individually reviewed. `adminQuery` has a role floor and is not scanned.
#
# A second, file-level rule covers the Team Inbox tables. `inboundMessages` and
# `conversationThreads` hold shared-inbox mail, and who may read it is decided
# in one place: inbox/access.ts (`isSharedInboxReader`). A file outside
# `inbox/` and `agent/` that defines a public function (member, identity or
# public floor, any kind) AND touches those tables — a `.query('<table>')` or a
# `v.id('<table>')` argument — outside its internal functions must use that
# gate: import inbox/access, or (an action) call
# `internal.inbox.access.assertSharedInboxReader`. Touches inside an
# `internalQuery` / `internalMutation` / `internalAction` do not count, since no
# client can reach them — unless the file defines a public action or a public
# function calls `internal.<this module>.…` (see touches_inbox_from_public). A
# module-level helper always counts, since a public function may call it. Such
# a file is reported as `<file>:#inbox-tables`, and rides the same ratchet and
# baseline. This is a presence check, like the gate tokens above: a reviewer
# still confirms the gate is actually used on the path that reads the rows.

set -uo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."

# shellcheck source=lib/convex-builders.sh
. scripts/lib/convex-builders.sh

generate() {
	local member_queries public_reads builders program
	member_queries=$(convex_builder_regex 'query' 'member') || exit 1
	public_reads=$(convex_builder_regex 'query|action' 'public') || exit 1
	builders="$member_queries|$public_reads"
	# The span scanner (scripts/lib/convex-defs.awk) opens a span on each
	# `export const X = <builder>(` and closes it on the column-0 `})`; this
	# fragment reports a span with neither a gate token nor an opt-out comment.
	program=$(convex_defs_program '
		function on_start() { gate = 0 }
		function on_line() { if ($0 ~ gates) gate = 1 }
		function on_end() { if (!gate && !def_optout) print FILENAME ":" def_name }
	') || exit 1
	find convex -name "*.ts" \
		-not -path "*/_generated/*" \
		-not -path "*/__tests__/*" \
		-print0 \
		| xargs -0 -r awk -v builders="$builders" -v optout='authz|all-members' \
			-v gates="($CONVEX_AUTHZ_GATES|$CONVEX_AUTHZ_READ_PREDICATES)" "$program" \
		| sort
	inbox_table_files || exit 1
}

# Files outside inbox/ and agent/ that define a public function, touch a Team
# Inbox table outside their internal functions, and do not use the
# shared-inbox reader gate (an import of inbox/access, or an action's call to
# its internal assert through `internal.inbox.access`).
inbox_table_files() {
	local public_builders public_actions candidates file
	public_builders=$(convex_builder_regex 'query|mutation|action' 'member|identity|public') || return 1
	public_actions=$(convex_builder_regex 'action' 'member|identity|public') || return 1
	# grep exits 1 on no match; an empty candidate list is a clean result.
	candidates=$(grep -rlE --include='*.ts' \
		"\.query\(\s*['\"](inboundMessages|conversationThreads)['\"]|v\.id\(\s*['\"](inboundMessages|conversationThreads)['\"]" \
		convex \
		| grep -vE '^convex/(inbox|agent|schema|_generated)/|/__tests__/|\.test\.ts$' || true)
	while IFS= read -r file; do
		[ -n "$file" ] || continue
		grep -qE "^export const [A-Za-z0-9_]+ = ($public_builders)\(" "$file" || continue
		grep -qE "from '(\./|(\.\./)+)inbox/access'|internal\.inbox\.access\." "$file" && continue
		touches_inbox_from_public "$file" "$public_builders" "$public_actions" || continue
		printf '%s:#inbox-tables\n' "$file"
	done <<<"$candidates" | sort
}

# True when a client can reach `file`'s Team Inbox table touches. Touches
# inside an `internalQuery` / `internalMutation` / `internalAction` span do not
# count on their own, since no client can call one — with two exceptions that
# put the whole file back in scope:
#   * the file defines a public action, which reaches its internal functions
#     through `ctx.runQuery` / `ctx.runMutation` by construction;
#   * a public function in the file calls `internal.<this module>.…`.
# A module-level helper always counts: a public function may call it. A span
# opens on its `export const` line and closes on the column-0 `})` or on the
# next `export const`, so an internal function whose closing brace is not at
# column 0 cannot hide the public function after it.
touches_inbox_from_public() {
	local file="$1" public_builders="$2" public_actions="$3" module
	grep -qE "^export const [A-Za-z0-9_]+ = ($public_actions)\(" "$file" && return 0
	module="${file#convex/}"
	module="internal.${module%.ts}."
	module="${module//\//.}"
	awk -v q="'" -v pub="^export const [A-Za-z0-9_]+ = (${public_builders})\\(" -v self="$module" '
		BEGIN {
			tables = "(inboundMessages|conversationThreads)"
			touch = "\\.query\\([[:space:]]*[" q "\"]" tables "[" q "\"]|v\\.id\\([[:space:]]*[" q "\"]" tables "[" q "\"]"
		}
		/^export const [A-Za-z0-9_]+ = / {
			internal = ($0 ~ /^export const [A-Za-z0-9_]+ = internal(Query|Mutation|Action)\(/)
			public = ($0 ~ pub)
		}
		!internal && $0 ~ touch { found = 1 }
		public && index($0, self) { found = 1 }
		/^}\)/ { internal = 0; public = 0 }
		END { exit found ? 0 : 1 }
	' "$file"
}

if [ "${1:-}" = "--generate" ]; then
	generate
	exit 0
fi

exec "$repo_root/scripts/ratchet.sh" \
	--baseline scripts/query-authz-baseline.txt \
	--seed "bash apps/api/scripts/check-query-authz.sh --write-baseline" \
	--ok "no new authedQuery without an authorization decision, no Team Inbox read outside the reader gate" \
	--new-header "FAIL: {n} new authedQuery definition(s) with no authorization decision." \
	--new-advice "authedQuery only requires an authenticated org member (any role). A read
must also decide WHO may see the data:
  - call requireOrgPermission / requireAdminContext / requireMailboxAccess / etc., or
  - add a '// authz: <reason>' (gate lives elsewhere) or
    '// all-members: <reason>' (intentionally member-visible) comment.
A '<file>:#inbox-tables' entry reads inboundMessages / conversationThreads
outside inbox/ and agent/: gate those reads on isSharedInboxReader from
inbox/access.ts (and the 'inbox' feature flag) instead of an inline role check.
Do NOT add new entries to {baseline} — it is frozen debt." \
	--stale-header "FAIL: {n} stale entr(y/ies) in {baseline} (query fixed or removed):" \
	"$@" \
	-- bash "$self" --generate
