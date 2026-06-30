#!/usr/bin/env bash
#
# Dead-code ratchet. Runs knip (config: knip.jsonc) over the whole monorepo,
# restricted to the dead-CODE issue types — unused files, exports, types,
# enum/class members and duplicate exports — and compares the result against a
# frozen baseline (scripts/dead-code-baseline.txt). This is the file-and-export
# sibling of apps/api/scripts/check-query-authz.sh: it exists because the repo
# has a documented history of orphaned exports / zero-caller modules accreting
# silently (speculative seams: authProviders/, repositories/, dead providers)
# with no tooling to notice.
#
# DELIBERATELY EXCLUDED issue types: dependencies / unlisted / unresolved /
# binaries. knip does not model bun catalogs, Nuxt aliases (#imports,
# ../../packages/ui) or transitive deps (zod, vite, h3, tslib), so those
# categories are pure noise here. CSS files are ignored in knip.jsonc for the
# same reason (the Nuxt `css:` array and @import chains are not traced).
#
# The ratchet is strict in BOTH directions, exactly like query-authz:
#   * a NEW dead-code entry not present in the baseline FAILS (regression), and
#   * a STALE baseline entry that knip no longer reports FAILS — delete the line
#     so the debt count only ever goes down.
#
# Normalised line format (sorted, stable, no line/col so edits don't churn it):
#   file:<path>                       an entire unused file
#   export:<path>:<name>              an unused named export / type / member

set -uo pipefail
cd "$(dirname "$0")/.."

baseline_file="scripts/dead-code-baseline.txt"
knip_bin="node_modules/.bin/knip"

if [ ! -x "$knip_bin" ]; then
	echo "FAIL: knip not installed ($knip_bin missing). Run 'bun install' first." >&2
	exit 1
fi

# Run knip in a stable, deterministic reporter mode. --no-exit-code so a
# non-empty report does not abort the pipe; we do the ratchet comparison
# ourselves. --include limits the report to dead-code issue types.
raw=$("$knip_bin" \
	--no-progress \
	--no-config-hints \
	--no-exit-code \
	--include files,exports,nsExports,classMembers,types,nsTypes,enumMembers,duplicates \
	--reporter json 2>/dev/null)

if [ -z "$raw" ]; then
	echo "FAIL: knip produced no output (run failed). Re-run: $knip_bin --include files,exports" >&2
	exit 1
fi

# Normalise the JSON into the sorted line format described above.
current=$(printf '%s' "$raw" | node -e '
	let input = "";
	process.stdin.on("data", (c) => (input += c));
	process.stdin.on("end", () => {
		const data = JSON.parse(input);
		const lines = new Set();
		for (const f of data.files || []) lines.add("file:" + f);
		for (const issue of data.issues || []) {
			const file = issue.file;
			const named = [
				...(issue.exports || []),
				...(issue.nsExports || []),
				...(issue.types || []),
				...(issue.nsTypes || []),
				...(issue.duplicates || []).flat(),
			];
			for (const e of named) {
				const name = typeof e === "string" ? e : e.name;
				if (name) lines.add("export:" + file + ":" + name);
			}
			for (const bag of [issue.enumMembers, issue.classMembers]) {
				for (const owner of Object.keys(bag || {})) {
					for (const m of bag[owner] || []) {
						const name = typeof m === "string" ? m : m.name;
						if (name) lines.add("export:" + file + ":" + owner + "." + name);
					}
				}
			}
		}
		process.stdout.write([...lines].sort().join("\n"));
	});
')

if [ ! -f "$baseline_file" ]; then
	echo "FAIL: $baseline_file missing. Seed it with the current output:" >&2
	echo "  bash scripts/check-dead-code.sh --write-baseline" >&2
	exit 1
fi

# --write-baseline: (re)seed the frozen baseline with the current knip output.
if [ "${1:-}" = "--write-baseline" ]; then
	printf '%s\n' "$current" | grep . >"$baseline_file" || true
	count=$(grep -c . "$baseline_file" || true)
	echo "wrote $baseline_file ($count entries)"
	exit 0
fi

new=$(comm -23 <(printf '%s\n' "$current" | grep . || true) <(sort "$baseline_file"))
stale=$(comm -13 <(printf '%s\n' "$current" | grep . || true) <(sort "$baseline_file"))

fail=0
if [ -n "$new" ]; then
	count=$(printf '%s\n' "$new" | grep -c .)
	echo "FAIL: $count new dead-code entr(y/ies) not in $baseline_file:"
	echo ""
	echo "$new"
	echo ""
	echo "Either delete the dead file/export, or — if it is intentionally kept —"
	echo "tag it for knip (e.g. a JSDoc '@public' / add the file to an entry glob"
	echo "in knip.jsonc). Do NOT add new lines to $baseline_file; it is frozen debt."
	fail=1
fi
if [ -n "$stale" ]; then
	count=$(printf '%s\n' "$stale" | grep -c .)
	echo "FAIL: $count stale entr(y/ies) in $baseline_file (no longer dead):"
	echo ""
	echo "$stale"
	echo ""
	echo "Delete these lines so the ratchet only moves down."
	fail=1
fi
[ "$fail" -eq 1 ] && exit 1

baseline_count=$(grep -c . "$baseline_file" || true)
echo "ok:   no new dead code ($baseline_count baseline entries remain)"
