#!/usr/bin/env bash
#
# Docker workspace-manifest guard. Every image that runs `bun install
# --frozen-lockfile` first copies the workspace manifests with a
# `COPY --parents … package.json` line. Bun validates the frozen lockfile
# against the FULL workspace shape, so a manifest set that misses even one
# workspace fails the build with "lockfile had changes, but lockfile is frozen"
# — which is exactly what happened when `examples/conformance` was added to the
# root `workspaces` list and every image broke at once.
#
# `bun run ci:verify` does not build images, so nothing else in the verify path
# notices. This is a sibling of check-adr-numbers.sh and check-branding.sh: a
# hard-0 invariant with no baseline. It expands the root package.json
# `workspaces` globs to the workspaces that actually exist and asserts that each
# one's package.json is matched by a pattern on every Dockerfile's COPY line —
# and, so that an image cannot quietly opt itself out, that every Dockerfile
# installing from the frozen lockfile carries such a line at all.

set -uo pipefail
cd "$(dirname "$0")/.."

# Workspaces the root manifest declares, expanded to real directories. Negated
# globs ("!packages/sdk-java") drop their matches, mirroring bun's own
# resolution.
mapfile -t globs < <(node -e '
// `workspaces` is either the array form or bun catalog form ({ packages, … }).
const declared = require("./package.json").workspaces;
const globs = Array.isArray(declared) ? declared : declared?.packages;
if (!Array.isArray(globs) || globs.length === 0) {
	console.error("root package.json declares no workspaces globs");
	process.exit(1);
}
for (const glob of globs) console.log(glob);
') || exit 1

manifests=()
excluded=()
for glob in "${globs[@]}"; do
	if [[ $glob == !* ]]; then
		for dir in ${glob#!}; do excluded+=("$dir/package.json"); done
		continue
	fi
	for dir in $glob; do
		[ -f "$dir/package.json" ] && manifests+=("$dir/package.json")
	done
done

if [ ${#manifests[@]} -eq 0 ]; then
	echo "FAIL: no workspace package.json files matched the root workspaces globs" >&2
	exit 1
fi

# Drop the negated ones.
kept=()
for manifest in "${manifests[@]}"; do
	skip=""
	for drop in ${excluded[@]+"${excluded[@]}"}; do
		[ "$manifest" = "$drop" ] && skip=1
	done
	[ -n "$skip" ] || kept+=("$manifest")
done
manifests=("${kept[@]}")

# Does one Dockerfile COPY pattern cover one manifest path? `*` in a Docker glob
# does not cross a path separator, so it is translated to `[^/]*` rather than
# leaned on bash's `*`, which would let `examples/*/package.json` falsely claim
# `examples/plugins/x/package.json`.
matches_pattern() {
	local pattern="$1" path="$2" regex
	regex=$(printf '%s' "$pattern" | sed -e 's/[.[\()^$+?{}|]/\\&/g' -e 's/\*/[^\/]*/g')
	[[ $path =~ ^${regex}$ ]]
}

# A Dockerfile instruction may be wrapped across backslash continuations, so the
# file is read with those continuations folded away before anything is matched
# against it. Without this a purely cosmetic re-wrap of a COPY line would take
# its image out of the guard's sight.
join_continuations() {
	sed -e ':a' -e '/\\$/{N;s/\\\n//;ba' -e '}' "$1"
}

failures=0
checked=0
while IFS= read -r dockerfile; do
	joined=$(join_continuations "$dockerfile")
	patterns=$(
		printf '%s\n' "$joined" \
			| grep -E '^[[:space:]]*COPY --parents .*package\.json' \
			| sed -E 's/^[[:space:]]*COPY --parents[[:space:]]*//; s/[[:space:]]+\.\/$//' \
			| tr -s ' \t' '\n\n' \
			| grep -E 'package\.json$'
	)
	if [ -z "$patterns" ]; then
		# An image that installs from the frozen lockfile MUST declare the
		# manifests it copies; skipping it here is how the guard would go
		# quiet on exactly the image that needs it.
		if printf '%s\n' "$joined" | grep -qE 'bun install[^&|]*--frozen-lockfile'; then
			echo "FAIL: $dockerfile runs 'bun install --frozen-lockfile' but copies no workspace manifests"
			failures=$((failures + 1))
		fi
		continue
	fi
	checked=$((checked + 1))

	for manifest in "${manifests[@]}"; do
		covered=""
		while IFS= read -r pattern; do
			[ -n "$pattern" ] || continue
			if matches_pattern "$pattern" "$manifest"; then
				covered=1
				break
			fi
		done <<<"$patterns"
		if [ -z "$covered" ]; then
			echo "FAIL: $dockerfile does not copy $manifest"
			failures=$((failures + 1))
		fi
	done
done < <(git ls-files '*Dockerfile' '*.Dockerfile')

if [ "$checked" -eq 0 ]; then
	echo "FAIL: no Dockerfile copies workspace manifests; the guard is not looking at anything" >&2
	exit 1
fi

if [ "$failures" -gt 0 ]; then
	echo ""
	echo "Each image's 'COPY --parents … package.json' line must cover every"
	echo "workspace in the root package.json 'workspaces' globs, or bun's"
	echo "frozen-lockfile check refuses the partial workspace shape."
	exit 1
fi

echo "ok:   all $checked Dockerfiles copy every one of the ${#manifests[@]} workspace manifests"
