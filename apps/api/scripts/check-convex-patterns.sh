#!/usr/bin/env bash
# Audits apps/api/convex/ for Convex anti-patterns and fails if any count
# grows above its checked-in baseline. Lowering a baseline below the actual
# count is the signal that a migration phase landed; raising one needs
# justification in the PR description.
#
# Baselines reflect the state at the end of the Convex best-practices
# remediation work (Phases 1, 4, 6, 7, 8, 9 landed). Phases 2 (bound
# .collect()) and 3 (filter→withIndex) lower these counts over time.
#
# See https://docs.convex.dev/production/best-practices

cd "$(dirname "$0")/.."

# ── Pattern 1: `.filter(` calls in Convex source ─────────────────────────────
# Best practice: filter via `.withIndex(...)` rather than in-memory predicate.
# False positives exist (filter after withIndex on a non-leading field, which
# is fine) — the baseline absorbs them. The number should trend down only.
# Bumped 157 → 163 in Phase 3.4 (soft-delete filtering on contact queries
# composes with the by_email / by_created_at index, so .filter is correct here).
# Bumped 163 → 166 in ADR-0003 (webhook event modules): `webhooks/events/
# registry.ts` filters Object.values over a static 9-entry catalog to derive
# SUBSCRIBABLE_LITERALS, plus the existing `WEBHOOK_EVENT_CATALOG.filter` in
# events.ts — both are JS array filters, not Convex DB queries.
# Lowered 166 → 165 in the post-ADR-0003 cleanup: `WEBHOOK_EVENT_CATALOG`
# was removed from events.ts; the per-event description / isSubscribable
# fields now live only on each Webhook event module.
# Bumped 165 → 168 for the internal team chat module (apps/api/convex/chat/*):
# net 8 new in-memory JS array filters (after subtracting the two removed
# from the deleted chat.ts scaffold). Every chat .filter() narrows an already
# bounded result set (room members of one room, caller's memberships,
# unread mentions, etc.) — never a `ctx.db.query().filter()` antipattern.
# Bumped 168 → 170 to track an existing under-counted baseline surfaced
# during ADR-0018 (Sending domain lifecycle) — no new `.filter()` antipatterns
# were introduced by that work, but the previous baseline drifted two
# below the head count.
# Bumped 170 → 172 in ADR-0030 (Public token endpoint module): two new
# JS Array `.filter(Boolean)` calls in `lib/publicTokenEndpoint.ts`'s path
# matcher — they strip empty segments from `pattern.split('/')` and
# `pathname.split('/')`. Not Convex DB queries; intrinsically bounded.
# Lowered 172 → 167 in ADR-0037 (Resource listing engine): the ported list
# shells dropped their in-memory `.filter()` search/status narrowing — the
# Listing engine indexes instead of filtering.
# Bumped 167 → 168 for external mailbox sync (mail/externalDelivery.ts): the
# `ingestExternalMessage` dedup narrows `by_rfc822_message_id` by mailboxId via
# `.filter()` — the same Message-ID dedup pattern `deliverToMailbox` already
# uses (there is no compound rfc822+mailbox index; the row set is one Message-ID).
# Lowered 168 → 151 in the Convex performance-audit remediation: the A/B list
# moved its `isABTest` filter into an internal query and the dead
# forms.getSubmissionStats was deleted, net dropping the in-memory filter count.
# Raised 149 → 151 in the public-route security pass: two in-memory ARRAY
# `.filter()`s (not DB filters) — emailsQueries.getTestSendAllowedRecipients
# narrows the (bounded) member roster to non-empty emails for the test-send
# recipient allowlist, and security_scan builds its guard sample from the
# non-empty subject/text/stripped-HTML parts. Both operate on tiny in-memory
# arrays.
# Raised 151 → 153 for the Postbox snooze hide-from-inbox fix: mail.mailbox
# listMessages now drops still-snoozed rows (snoozedUntil > now) from each
# folder view and serves the virtual "Snoozed" view — two in-memory ARRAY
# `.filter()`s over the already-`.take()`-bounded recent-message window, not
# DB filters.
# Raised 153 → 154 for hybrid knowledge retrieval + dedup: in-memory ARRAY
# `.filter()`s — knowledge/retrieval drops TTL-expired entries from the already-
# bounded fused candidate set, and knowledge/maintenance dedup keeps only
# embeddable (non-null, non-empty-embedding) entries of one contact. Both are
# JS array filters over bounded in-memory sets, not `ctx.db.query().filter()`.
# Raised 154 → 155 for custom-folder listMessages: the new folderId branch drops
# snoozed messages from the already-`.take()`-bounded folder window — the same
# in-memory array `.filter((m) => !isSnoozed(m))` the sibling folderRole path uses.
# Raised 155 → 161 for the soft-delete-contract review fixes: six `deletedAt ===
# undefined` post-filters on equality-indexed access paths that have no
# `*_and_deleted_at` compound index — contacts.getByEmailForTeam + contacts
# update duplicate-email (×2) compose with `by_email`, and three transactionalSends
# reads (listByTransactionalEmail, listAll, getByEmail) compose with their
# template/email index. Each filters a row set already narrowed by an indexed
# equality (one email, or one template's bounded `.take()` page), so `.filter()`
# is correct and cheap; a GDPR-erased gravestone must not re-surface.
# Raised 161 → 162 for the inbox.listThreads pagination fix: when assignedToMe
# AND a status filter are both set, the query paginates the by_assigned_to index
# and post-filters status — a .filter() composed with .paginate() (filtered rows
# shrink the page but the cursor stays complete), no compound index exists.
# Raised 162 → 163 for the postbox filter-forward fix: deliverToMailbox selects
# the 'forward' actions from the in-memory evalResult.actions array and the
# post-delivery hook keeps only enabled account-forwarding rules — both JS array
# `.filter()`s over already-bounded in-memory sets, not `ctx.db.query().filter()`.
# Raised 163 → 164 for inbox.mutations.retryFailedMessage: it picks the most
# recent failed agentAction with a JS array `.filter()` over the per-message
# action rows (one row per pipeline step, ~5 max), not a `ctx.db.query().filter()`.
# Raised 164 → 165 for semanticFiles list/search pagination: applySourceFilter
# narrows one already-`.paginate()`-bounded page by `sourceType` — a JS array
# `.filter()` (mirroring mediaAssets.list's post-pagination filter), not a
# `ctx.db.query().filter()`. The client auto-loads pages so filtering spans the
# whole table rather than the old client-side filter over the newest 50 rows.
# Raised 165 → 169 for the SPF helpers (PR-68, domains/spf.ts + dnsVerification.ts
# + providers/mta/index.ts): four JS array `.filter()`s over tiny in-memory
# sets — countSpfRecords narrows the published TXT values to SPF records,
# insertIncludeIntoExisting strips empty tokens via `.filter(Boolean)`, the
# return-path SPF generator strips blank pool IPs via `.filter(Boolean)`, and
# the verifier filters the published TXT values down to the duplicate SPF
# records to join them for display. None are
# `ctx.db.query().filter()` — they operate on DNS-TXT arrays / split strings.
# Raised 169 → 170 for inbound attachment malware scanning (PR-39, mail/delivery.ts):
# scanInboundAttachments narrows the extracted MIME attachment leaves to the
# non-inline, non-empty parts worth scanning — a JS array `.filter()` over the
# in-memory `extractAttachments(...)` result, not a `ctx.db.query().filter()`.
# Raised 170 → 171 for graph-augmented retrieval (knowledge/retrieval.ts):
# expandAndRank narrows the vector/FTS id legs to the post-fusion VISIBLE pool
# before ranking — a JS array `.filter()` over the already-bounded in-memory id
# lists (and the SECURITY floor that keeps contact-scoped ids out of the ranker),
# not a `ctx.db.query().filter()`.
FILTER_BASELINE=171
filter_count=$(grep -rn "\.filter(" convex --include="*.ts" 2>/dev/null \
	| grep -v "/_generated/" \
	| grep -v "/__tests__/" \
	| wc -l | tr -d ' ')

# ── Pattern 2: `.collect()` without an obvious bound ─────────────────────────
# Best practice: bound reads via `.take(n)`, pagination, or document with a
# trailing `// bounded:` comment when the table is intrinsically small.
# Phase 3.4 added cascade .collect() scans of contactActivities / contactIdentities /
# contactRelationships (from + to) when permanently deleting a soft-deleted contact.
# Each child table is filtered by contactId, so the row set is intrinsically per-contact.
# Lowered 276 → 242 in ADR-0037 (Resource listing engine): the ported list/count
# shells (contacts, campaigns, emailTemplates, topics, segments, automations) no
# longer `.collect()` whole tables — the engine paginates / index-counts instead.
# Lowered 242 → 236 in ADR-0042 (Sending reputation module): the five copied
# window-sum loops collapsed into one summarizer and the reputation reads
# (reputationQueries, platformAdmin, reporter) stopped `.collect()`-ing the table
# per call; the module's own scans carry `// bounded:` (cleanup-pruned window).
# Lowered 236 → 234: getInboundStats no longer collects the open-thread set per
# subscriber — the count is denormalized onto instanceSettings.openThreads and
# maintained by the Conversation thread module (the sole status writer).
# Raised 234 → 236: the permanent-delete cascade now also scans automationRuns
# (owned, deleted) and the optional-FK clear tables (unifiedMessages /
# formSubmissions / inboundMessages / conversationThreads) by contactId, closing
# the dangling-FK orphan bug. Each is the same intrinsically per-contact child
# scan as the sibling cascade collects already counted above.
# Lowered 236 → 234: the postbox overdue-draft cron (mail/outboundCron) stopped
# `.collect()`-ing the whole pending_send / scheduled partitions and now
# range-scans the overdue tail via the compound index with `.take(BATCH_SIZE)`.
# Lowered 234 → 229: blockedEmails.listByTeam now `.order('desc').take(N)` the
# blocklist view instead of collecting every row (two collects removed), and
# auditLogs.list uses native `.paginate()` instead of collecting the whole
# filtered set to seek a cursor.
# Lowered 229 → 226: systemHealth.getHealthStats no longer collects all
# campaigns + all sends-per-campaign + all transactionalSends; it reads the
# bounded sendingReputation summary and a capped by_status queue probe.
# Lowered 226 → 189 in the Convex performance-audit remediation: the
# contact_property/topic_membership single-contact path point-reads instead of
# collecting whole columns; semanticFiles.listByContact, automation funnel
# analytics, getTimelineStats, blockedEmails counts, labels.remove, form +
# folder deletion, the pending-delay sweep, and the agent-metrics rollup all
# stopped collecting unbounded tables (paginated continuations / .take caps /
# denormalized counters / index-able junctions).
# Raised 185 → 186 in the public-route security pass: the test-send recipient
# allowlist (emailsQueries.getTestSendAllowedRecipients) collects `userProfiles`
# to enumerate org-member inboxes. On a single-org deployment that table is the
# member roster — intrinsically tiny (1 row per user).
# Raised 186 → 190 by the GDPR contact-erasure cascade (lib/contactMutations):
# four bounded-in-practice per-contact reads (threads + their messages,
# knowledge junction links, semantic-file links) following the file's
# existing cascade idiom — each is scoped by a by_contact/by_thread index.
# Raised 190 → 196 by auth/memberErasure: per-mailbox/per-account index-scoped
# reads inside the batched member-erasure walker (folders/labels/filters/
# signatures/passwords/aliases/sync-state of ONE mailbox per hop).
# Lowered 196 → 193: the review bounded three unbounded scans (mediaAssets
# getStats + listTags now .take(MEDIA_SCAN_LIMIT); codeWorkTasks.getReviewTasks
# now .take(200) — that orphaned query was later deleted entirely) and deleted
# the orphaned contacts.activities.deleteByContact.
# Lowered 193 → 191: deleted caller-less providerRoutes.listRoutesInternal and
# auth.apiAuth.validateApiKey, each of which held an unbounded collect/read.
# Raised 191 → 192 for inbox.mutations.retryFailedMessage: it collects ONE
# message's agentActions via the by_inbound_message index (one row per pipeline
# step, ~5 max) to pick the most recent failed one — same bounded idiom as
# inbox.queries.getMessageActions.
COLLECT_BASELINE=192
collect_count=$(grep -rn "\.collect()" convex --include="*.ts" 2>/dev/null \
	| grep -v "/_generated/" \
	| grep -v "/__tests__/" \
	| grep -v "// bounded:" \
	| wc -l | tr -d ' ')

# ── Pattern 3: Exported Convex function with no `args:` (`handler:` directly) ─
# `awk` walks each .ts file: when it sees `export const X = query({` (or any
# other Convex constructor) it watches the next non-blank line. If that line
# starts with `handler:` (not `args:`), it's a violation. Portable across
# macOS/Linux without depending on GNU grep `-P`.
ARGS_BASELINE=0
args_count=$(find convex -name "*.ts" \
	-not -path "*/_generated/*" \
	-not -path "*/__tests__/*" \
	-exec awk '
		/^export const [A-Za-z_][A-Za-z_0-9]* = (query|mutation|action|internalQuery|internalMutation|internalAction)\(\{[[:space:]]*$/ {
			watching = 1
			next
		}
		watching && /^[[:space:]]*$/ { next }
		watching {
			watching = 0
			if ($0 ~ /^[[:space:]]*handler:/) print FILENAME ":" NR
		}
	' {} \; 2>/dev/null | wc -l | tr -d ' ')

# ── Pattern 4: Debug `console.log` (use console.info/warn/error instead) ────
CONSOLE_LOG_BASELINE=0
console_log_count=$(grep -rn "console\.log(" convex --include="*.ts" 2>/dev/null \
	| grep -v "/_generated/" \
	| grep -v "/__tests__/" \
	| wc -l | tr -d ' ')

fail=0
report() {
	local name="$1"
	local count="$2"
	local baseline="$3"
	if [ "$count" -gt "$baseline" ]; then
		echo "FAIL: $name count=$count > baseline=$baseline"
		fail=1
	else
		echo "ok:   $name count=$count (baseline=$baseline)"
	fi
}

report ".filter() calls           " "$filter_count"      "$FILTER_BASELINE"
report ".collect() unbounded      " "$collect_count"     "$COLLECT_BASELINE"
report "missing args: validators  " "$args_count"        "$ARGS_BASELINE"
report "console.log debug calls   " "$console_log_count" "$CONSOLE_LOG_BASELINE"

if [ "$fail" -ne 0 ]; then
	echo ""
	echo "One or more Convex anti-pattern counts grew. See https://docs.convex.dev/production/best-practices"
	echo "If the regression is justified (e.g. an intrinsically small table), raise the baseline"
	echo "in apps/api/scripts/check-convex-patterns.sh and explain why in the PR description."
	exit 1
fi
