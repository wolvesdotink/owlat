#!/usr/bin/env bash
# Audits apps/api/convex/ for Convex anti-patterns and fails if any count
# grows above its checked-in baseline. Lowering a baseline below the actual
# count is the signal that a migration phase landed; raising one needs
# justification in the PR description.
#
# See https://docs.convex.dev/production/best-practices
#
# Counting rules (both pattern 1 and 2):
#   - Lines whose content starts with a comment marker (`//`, `*`, `/*`) are
#     NOT counted. Doc comments that mention `.collect()`/`.filter()` in prose
#     (e.g. "the pre-deepening shape did `x.collect()`") are documentation,
#     not calls, and must not inflate the metric.
#   - `.collect()` is exempt when a `// bounded: <reason>` comment sits on the
#     SAME line or the line immediately AFTER it — so a multi-line query chain
#     (`.query(...).withIndex(...)\n  .collect();` with the justification on the
#     next line) keeps its exemption without cramming the comment inline.

cd "$(dirname "$0")/.."

# ── Pattern 1: `.filter(` calls in Convex source ─────────────────────────────
# Best practice: narrow with `.withIndex(...)` rather than an in-memory
# predicate. The count includes legitimate, unavoidable uses that the baseline
# absorbs and that should only trend DOWN:
#   - JS Array `.filter()` over already-bounded in-memory sets (the majority).
#   - DB `.filter()` composed AFTER a `.withIndex(...)` equality on a non-leading
#     field, where no compound index exists and the narrowed set is tiny — e.g.
#     the soft-delete `deletedAt === undefined` post-filter, Message-ID dedup by
#     mailboxId, per-parent `.first()` status filters, and the dynamic audit-log
#     viewer (optional date/action/resource/user filters over `by_created_at`).
# A NEW `ctx.db.query().filter()` full-table scan is the anti-pattern to avoid;
# add the index instead. Raising this baseline needs a per-call justification.
# Lowered 175 → 168 in the boundedness-audit pass: six DB `.filter()` scans moved
# onto (new) compound indexes — webhooks/cleanup ×2 (by_status_and_completed_at),
# agentHealth ×3 (by_metric_type_and_window_start), campaigns/analytics (by_is_ab_test)
# — plus the comment-line skip drops one prose mention of `.filter()`.
FILTER_BASELINE=168
filter_count=$(grep -rn "\.filter(" convex --include="*.ts" 2>/dev/null \
	| grep -v "/_generated/" \
	| grep -v "/__tests__/" \
	| grep -vE '^[^:]*:[0-9]+:[[:space:]]*(//|\*|/\*)' \
	| wc -l | tr -d ' ')

# ── Pattern 2: unbounded `.collect()` ────────────────────────────────────────
# Best practice: bound reads via `.take(n)`, pagination, or a per-parent /
# time-window / shard index that caps the row set, and document intentional
# scans of intrinsically-small tables with a trailing `// bounded: reason`.
#
# The baseline is the count of `.collect()` calls that are NEITHER take/paginate
# -bounded NOR carry a `// bounded:` justification. As of the boundedness-audit
# pass it is the following KNOWN-UNBOUNDED fan-out scans, each deliberately left
# uncommented pending a batched-delete / denormalized-counter follow-up:
#   1. topics/topics.ts               deleteTopic → all `contactTopics` by_topic
#   2. contacts/properties.ts         deleteProperty → all `contactPropertyValues` by_property
#   3. contacts/propertyValues.ts     getPropertyValueCount → `.collect().length` by_property
#   4. delivery/sends.ts              deleteByCampaign → all `emailSends` by_campaign
#   5. transactional/sends.ts         delete → all `transactionalSends` by_transactional_email
#   6. webhooks/endpoints.ts          deleteWebhook → all `webhookDeliveryLogs` by_webhook
#   7. conditions/topic_membership    segment eval preloads all members by_topic
#   8. conditions/contact_property    segment eval preloads all values by_property
# These fan out by a secondary key (per-campaign/topic/property/webhook), so
# they are genuinely unbounded — unlike the per-CONTACT cascade collects, which
# a single person's bounded fan-out keeps small and which carry `// bounded:`.
# Fixing them means batched self-rescheduling deletes and denormalized counts;
# tracked separately. Do NOT slap `// bounded:` on these — the baseline holds
# the line so no NEW unbounded scan slips in.
COLLECT_BASELINE=8
collect_count=0
while IFS= read -r f; do
	c=$(awk '
		{ lines[NR] = $0 }
		END {
			for (i = 1; i <= NR; i++) {
				if (lines[i] !~ /\.collect\(\)/) continue
				# skip comment-only lines (prose mentions of .collect())
				if (lines[i] ~ /^[[:space:]]*(\/\/|\*|\/\*)/) continue
				# exempt when justified on the same or the next line
				if (lines[i] ~ /\/\/ bounded:/) continue
				if (i < NR && lines[i + 1] ~ /\/\/ bounded:/) continue
				n++
			}
			print n + 0
		}' "$f")
	collect_count=$((collect_count + c))
done < <(find convex -name "*.ts" -not -path "*/_generated/*" -not -path "*/__tests__/*")

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
	echo "For .collect(): prefer .take()/paginate, or trail the call with a '// bounded: reason' comment."
	exit 1
fi
