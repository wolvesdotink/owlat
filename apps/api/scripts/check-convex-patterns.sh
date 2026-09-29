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

# ── Pattern 5: `instanceSettings` singleton created outside its one helper ───
# `lib/instanceSettings.ts` `upsertInstanceSettings` is the only place allowed to
# insert the singleton row. A hand-rolled "patch if present, else insert" lets a
# cron or counter create the row with whatever columns it happens to carry, and
# the admin seed then mistook that row for a seeded one. Comment-only lines do
# not count; tests may seed the row directly.
INSTANCE_SETTINGS_INSERT_BASELINE=0
instance_settings_inserts=$(grep -rnE "insert\(['\"]instanceSettings['\"]" convex --include="*.ts" 2>/dev/null \
	| grep -v "/_generated/" \
	| grep -v "/__tests__/" \
	| grep -v "\.test\.ts:" \
	| grep -v "^convex/lib/instanceSettings\.ts:" \
	| grep -vE "^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)" || true)
instance_settings_insert_count=$(printf '%s' "$instance_settings_inserts" | grep -c . || true)
if [ "$instance_settings_insert_count" -gt 0 ]; then
	echo "$instance_settings_inserts" | sed 's/^/  raw instanceSettings insert: /'
fi

# ── Pattern 6: hand-rolled literal union instead of `literalUnion` ───────────
# `lib/literalUnion.ts` `literalUnion(LIST)` is the one way to turn a literal
# list into a Convex union: it keeps the inferred type closed without a cast and
# refuses an empty list. The hand-rolled `v.union(...LIST.map((x) => v.literal(x)))`
# loses that narrowing, so every copy grew an `as unknown as Validator<…>`. This
# flags a `.map(` whose callback is `v.literal`, whether `v.union(` sits on the
# same line or the formatter moved the spread onto the next one, and whether the
# arrow body wrapped onto the following line. The point-free `.map(v.literal)`
# counts too. Comment-only lines do not count; only the helper itself may do it.
LITERAL_MAP_BASELINE=0
# The regex travels through ENVIRON so awk applies no escape processing to it.
export LITERAL_MAP='\.map\([[:space:]]*(\([^()]*\)|[A-Za-z_$][A-Za-z0-9_$]*)?[[:space:]]*(=>)?[[:space:]]*v\.literal[[:space:]]*[(),]'
literal_map_sites=$(find convex -name "*.ts" -not -path "*/_generated/*" \
	-not -path "convex/lib/literalUnion.ts" -print0 \
	| xargs -0 -r awk '
		BEGIN { re = ENVIRON["LITERAL_MAP"] }
		FNR == 1 { prev = "" }
		{
			t = $0; sub(/^[[:space:]]+/, "", t)
			comment = (t ~ /^(\/\/|\*|\/\*)/)
			# the map opened on the previous line and its callback continues here
			if (prev != "" && !comment && (prev " " t) ~ re) print FILENAME ":" (FNR - 1) ": " prev
			prev = ""
			if (comment || $0 !~ /\.map\(/) next
			if ($0 ~ re) { print FILENAME ":" FNR ": " t; next }
			if ($0 ~ /(\.map\(|=>)[[:space:]]*$/) prev = t
		}')
literal_map_count=$(printf '%s' "$literal_map_sites" | grep -c . || true)
if [ "$literal_map_count" -gt 0 ]; then
	echo "$literal_map_sites" | sed 's/^/  hand-rolled literal union: /'
fi

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
report "instanceSettings insert   " "$instance_settings_insert_count" "$INSTANCE_SETTINGS_INSERT_BASELINE"
report "hand-rolled literal union " "$literal_map_count" "$LITERAL_MAP_BASELINE"

if [ "$fail" -ne 0 ]; then
	echo ""
	echo "One or more Convex anti-pattern counts grew. See https://docs.convex.dev/production/best-practices"
	echo "If the regression is justified (e.g. an intrinsically small table), raise the baseline"
	echo "in apps/api/scripts/check-convex-patterns.sh and explain why in the PR description."
	echo "For .collect(): prefer .take()/paginate, or trail the call with a '// bounded: reason' comment."
	echo "For instanceSettings: never raise that baseline; write through upsertInstanceSettings (lib/instanceSettings.ts)."
	echo "For a literal union: never raise that baseline; build it with literalUnion (lib/literalUnion.ts)."
	exit 1
fi
