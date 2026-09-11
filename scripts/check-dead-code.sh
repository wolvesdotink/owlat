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
# `dependencies` / `devDependencies` ARE included: a package.json entry nothing
# imports is dead weight in the install graph and, for a runtime `dependencies`
# entry, dead weight in every shipped image.
#
# DELIBERATELY EXCLUDED issue types: unlisted / unresolved / binaries. Measured
# on 2026-09-10: 46 unlisted + 20 unresolved, of which 62 are bun-catalog and
# workspace-hoisting artifacts (h3, vue-i18n, @vue/test-utils, vitest, tslib,
# `../../packages/ui`) that knip cannot model, so the categories are noise-
# dominated and a baseline over them would never be read. CSS files are ignored
# in knip.jsonc for the same reason (the Nuxt `css:` array and @import chains
# are not traced).
#
# The ratchet is strict in BOTH directions, exactly like query-authz:
#   * a NEW dead-code entry not present in the baseline FAILS (regression), and
#   * a STALE baseline entry that knip no longer reports FAILS — delete the line
#     so the debt count only ever goes down.
#
# Normalised line format (sorted, stable, no line/col so edits don't churn it):
#   file:<path>                       an entire unused file
#   export:<path>:<name>              an unused named export / type / member
#   dep:<path>:<name>                 an unused runtime dependency
#   devdep:<path>:<name>              an unused devDependency

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
#
# knip 6 note: the `classMembers` issue type was removed (knip no longer
# reports unused class members), and `namespaceMembers` was added. The JSON
# reporter also changed shape — there is no longer a top-level `files` array;
# an unused whole file is now an issue whose `files` field lists it. The
# normaliser below handles the v6 shape.
raw=$("$knip_bin" \
	--no-progress \
	--no-config-hints \
	--no-exit-code \
	--include files,exports,nsExports,types,nsTypes,enumMembers,namespaceMembers,duplicates,dependencies,devDependencies \
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
		const nameOf = (e) => (typeof e === "string" ? e : e && e.name);
		// knip 6 dropped the top-level `data.files` array; an unused whole file
		// is now reported as an issue whose `files` field lists it (as a string
		// or a {name} object). Older shapes are handled defensively.
		for (const f of data.files || []) {
			const p = nameOf(f);
			if (p) lines.add("file:" + p);
		}
		for (const issue of data.issues || []) {
			const file = issue.file;
			for (const f of issue.files || []) {
				const p = nameOf(f);
				if (p) lines.add("file:" + p);
			}
			const named = [
				...(issue.exports || []),
				...(issue.nsExports || []),
				...(issue.types || []),
				...(issue.nsTypes || []),
				...(issue.duplicates || []).flat(),
			];
			for (const e of named) {
				const name = nameOf(e);
				if (name) lines.add("export:" + file + ":" + name);
			}
			// dependency issue types: flat arrays of {name} hanging off the
			// package.json they were declared in.
			for (const [prefix, bag] of [
				["dep:", issue.dependencies],
				["devdep:", issue.devDependencies],
			]) {
				for (const d of bag || []) {
					const name = nameOf(d);
					if (name) lines.add(prefix + file + ":" + name);
				}
			}
			// enum/namespace members: knip 6 reports these as flat arrays of
			// {name} (name already carries any owner prefix); knip 5 used an
			// owner-keyed object ({ Owner: [members] }). Handle both.
			for (const bag of [issue.enumMembers, issue.namespaceMembers]) {
				if (Array.isArray(bag)) {
					for (const m of bag) {
						const name = nameOf(m);
						if (name) lines.add("export:" + file + ":" + name);
					}
				} else if (bag && typeof bag === "object") {
					for (const owner of Object.keys(bag)) {
						for (const m of bag[owner] || []) {
							const name = nameOf(m);
							if (name) lines.add("export:" + file + ":" + owner + "." + name);
						}
					}
				}
			}
		}
		process.stdout.write([...lines].join("\n"));
	});
' | LC_ALL=C sort)

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

# comm needs BOTH sides in the same collation; the normaliser above and the
# baseline are therefore both sorted with LC_ALL=C. Locale collation ignores
# punctuation, which reorders entries like `@faker-js/faker` vs `faker` and made
# comm report the same line as both new AND stale.
new=$(comm -23 <(printf '%s\n' "$current" | grep . || true) <(LC_ALL=C sort "$baseline_file"))
stale=$(comm -13 <(printf '%s\n' "$current" | grep . || true) <(LC_ALL=C sort "$baseline_file"))

fail=0
if [ -n "$new" ]; then
	count=$(printf '%s\n' "$new" | grep -c .)
	echo "FAIL: $count new dead-code entr(y/ies) not in $baseline_file:"
	echo ""
	echo "$new"
	echo ""
	echo "Either delete the dead file/export/dependency, or — if it is"
	echo "intentionally kept — tag it for knip (e.g. a JSDoc '@public' / add the"
	echo "file to an entry glob in knip.jsonc). Do NOT add new lines to"
	echo "$baseline_file; it is frozen debt."
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
