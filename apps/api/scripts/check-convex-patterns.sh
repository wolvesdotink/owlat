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

# ── Pattern 1: full-table `ctx.db.query().filter()` scans ────────────────────
# Best practice: narrow with `.withIndex(...)` rather than an in-memory predicate.
# This flags ONLY the real anti-pattern — a `.filter(...)` on a `ctx.db.query()`
# chain that has NO `.withIndex()`/`.withSearchIndex()` before it — and ignores
# the two harmless cases the old blanket count kept churning the baseline for:
#   - JS Array `.filter()` over an in-memory set (`arr.filter(...)`), and
#   - a DB `.filter()` composed AFTER an index (soft-delete `deletedAt`, Message-ID
#     dedup, per-parent `.first()` status filters, the dynamic audit-log viewer).
# Detection (awk, statement-aware): for each `.filter(`, if it opens a fluent
# continuation line, walk back through the chain to the `.query(`; if that chain
# carries no index it is a full scan. An inline `.query(...).filter(...)` with no
# index counts too. A trailing `;` (± line comment) marks a statement boundary so
# a JS filter after a query statement is not misattributed.
#
# Baseline is 1: transactional/sends.ts listAll pages `transactionalSends` newest-
# first and post-filters the soft-delete `deletedAt` (GDPR-erased sends are rare,
# the read is `.take()`-bounded, and no index preserves creation-desc order while
# filtering deletedAt). A NEW full-table filter must add the index instead.
FILTER_BASELINE=1
filter_count=0
while IFS= read -r f; do
	c=$(awk '
		{ lines[NR] = $0 }
		END {
			for (i = 1; i <= NR; i++) {
				line = lines[i]
				if (line !~ /\.filter\(/) continue
				t = line; sub(/^[[:space:]]+/, "", t)
				if (t ~ /^(\/\/|\*|\/\*)/) continue           # comment-only line
				isDb = 0; hasIndex = 0
				if (t ~ /^\.filter\(/) {
					# fluent continuation: walk back through the chain to its query
					for (k = i - 1; k >= 1 && k >= i - 20; k--) {
						if (lines[k] ~ /\.withIndex\(|\.withSearchIndex\(/) hasIndex = 1
						ends = (lines[k] ~ /;[[:space:]]*(\/\/.*)?$/)   # statement boundary
						if (lines[k] ~ /\.query\(/ && !ends) { isDb = 1; break }
						if (ends) break
					}
				} else if (line ~ /\.query\(/ && line !~ /\.withIndex\(|\.withSearchIndex\(/) {
					isDb = 1                                   # inline query().filter(), no index
				}
				if (isDb && !hasIndex) n++
			}
			print n + 0
		}' "$f")
	filter_count=$((filter_count + c))
done < <(find convex -name "*.ts" -not -path "*/_generated/*" -not -path "*/__tests__/*")

# ── Pattern 2: unbounded `.collect()` ────────────────────────────────────────
# Best practice: bound reads via `.take(n)`, pagination, or a per-parent /
# time-window / shard index that caps the row set, and document intentional
# scans of intrinsically-small tables with a trailing `// bounded: reason`.
#
# The baseline is the count of `.collect()` calls that are NEITHER take/paginate
# -bounded NOR carry a `// bounded:` justification. It is now 0: every remaining
# `.collect()` is either take/paginate-bounded, per-parent/window/shard-indexed,
# or carries a `// bounded:` reason. The last 8 KNOWN-UNBOUNDED fan-out scans
# (per-campaign/topic/property/webhook) were fixed in the cascade-bounding pass:
#   - deleteByCampaign / deleteByTransactionalEmail — deleted (dead code).
#   - webhooks/topics/properties `remove` — batched, self-rescheduling cascade
#     deletes (drain a `.take(BATCH)` page, reschedule until drained).
#   - getPropertyValueCount — bounded usage probe (`.take(CAP)`, reported "N+").
#   - conditions/{topic_membership,contact_property} preloads — streamed via
#     `for await` instead of an unbounded `.collect()`.
# Keep it at 0: a NEW `.collect()` must be take/paginate-bounded or carry a
# `// bounded:` reason, else it fails this gate.
COLLECT_BASELINE=0
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

report "query().filter() full-scans" "$filter_count"      "$FILTER_BASELINE"
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
