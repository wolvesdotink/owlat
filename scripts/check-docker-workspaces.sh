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
# hard-0 invariant with no baseline. It also verifies that every frozen-install
# stage copies the root patches/ directory whenever patchedDependencies is in
# use; otherwise Bun fails before dependency installation begins. The guard
# expands the root package.json
# `workspaces` globs to the workspaces that actually exist and asserts that each
# one's package.json is matched by a pattern on every Dockerfile's COPY line —
# and, so that an image cannot quietly opt itself out, that every Dockerfile
# installing from the frozen lockfile carries such a line at all.
#
# The same closure argument applies to the shared TypeScript config: a build
# context that copies a tsconfig.json which `extends` the repo base, but not the
# base itself, gives tsc a TS5083 and gives `bun build` a silently empty set of
# compiler options. That is checked here too.

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

# Every checked-in tsconfig.json that extends the repo base, as a set. One grep
# over the tree beats re-reading a config for each COPY token that names it.
declare -A extends_base=()
while IFS= read -r config; do
	extends_base["$config"]=1
done < <(git ls-files '*tsconfig.json' \
	| xargs -r grep -lE '"extends"[[:space:]]*:[[:space:]]*"[^"]*tsconfig\.base\.json"')

# Images that already copy the base, so the closure check can skip them.
declare -A copies_base_by_file=()
while IFS= read -r image; do
	copies_base_by_file["$image"]=1
done < <(git ls-files '*Dockerfile' '*.Dockerfile' \
	| xargs -r grep -lE '^[[:space:]]*COPY[[:space:]].*tsconfig\.base\.json')

has_patched_dependencies=$(
	node -e '
const patched = require("./package.json").patchedDependencies;
process.stdout.write(patched && Object.keys(patched).length > 0 ? "1" : "0");
'
) || exit 1
while IFS= read -r dockerfile; do
	joined=$(join_continuations "$dockerfile")

	# tsconfig closure: any tsconfig.json entering the build context — copied
	# directly or swept in with its directory — drags in whatever it `extends`.
	# Pure bash string work against the precomputed set: this runs once per COPY
	# token in every image, and a subprocess here costs seconds across the repo.
	if [ -z "${copies_base_by_file[$dockerfile]:-}" ]; then
		while IFS= read -r instruction; do
			[[ $instruction =~ ^[[:space:]]*COPY[[:space:]] ]] || continue
			read -ra tokens <<<"${instruction#*COPY }"
			# The last token is the destination; flags are not sources either.
			for ((i = 0; i < ${#tokens[@]} - 1; i++)); do
				token="${tokens[i]}"
				[[ $token == --* ]] && continue
				candidate="${token%/}"
				[[ ${candidate##*/} == tsconfig.json ]] || candidate="$candidate/tsconfig.json"
				[ -n "${extends_base[$candidate]:-}" ] || continue
				echo "FAIL: $dockerfile copies $candidate, which extends tsconfig.base.json, without copying tsconfig.base.json"
				failures=$((failures + 1))
			done
		done <<<"$joined"
	fi

	if [ "$has_patched_dependencies" = "1" ]; then
		stage_has_patches=""
		while IFS= read -r instruction; do
			if [[ $instruction =~ ^[[:space:]]*FROM[[:space:]] ]]; then
				stage_has_patches=""
			elif [[ $instruction =~ ^[[:space:]]*COPY[[:space:]]+patches/?[[:space:]]+patches/?[[:space:]]*$ ]]; then
				stage_has_patches=1
			elif [[ $instruction =~ ^[[:space:]]*RUN[[:space:]].*bun[[:space:]]+install.*--frozen-lockfile ]] \
				&& [ -z "$stage_has_patches" ]; then
				echo "FAIL: $dockerfile runs a frozen Bun install without copying patches/ in that stage"
				failures=$((failures + 1))
			fi
		done <<<"$joined"
	fi
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

	# plugin-kit re-exports provider-kit and its package entry points at dist/.
	# Any image that builds or ships plugin-kit must therefore build provider-kit
	# first and ship its dist beside it; a manifest-only guard cannot see this.
	if printf '%s\n' "$joined" | grep -q 'packages/plugin-kit'; then
		provider_build_line=$(
			printf '%s\n' "$joined" \
				| grep -nE 'RUN (bun run --cwd packages/provider-kit build|cd packages/provider-kit && bun run build)' \
				| head -1 \
				| cut -d: -f1
		)
		plugin_build_line=$(
			printf '%s\n' "$joined" \
				| grep -nE 'RUN (bun run --cwd packages/plugin-kit build|cd packages/plugin-kit && bun run build)' \
				| head -1 \
				| cut -d: -f1
		)
		if [ -z "$provider_build_line" ] || [ -z "$plugin_build_line" ]; then
			echo "FAIL: $dockerfile uses plugin-kit but does not build both provider-kit and plugin-kit"
			failures=$((failures + 1))
		elif [ "$provider_build_line" -ge "$plugin_build_line" ]; then
			echo "FAIL: $dockerfile must build provider-kit before plugin-kit"
			failures=$((failures + 1))
		fi

		if printf '%s\n' "$joined" | grep -qE 'COPY --from=.*packages/plugin-kit/dist' \
			&& ! printf '%s\n' "$joined" | grep -qE 'COPY --from=.*packages/provider-kit/dist'; then
			echo "FAIL: $dockerfile ships plugin-kit dist without provider-kit dist"
			failures=$((failures + 1))
		fi
	fi
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
	echo ""
	echo "An image whose context holds a tsconfig.json that extends the repo base"
	echo "must also COPY tsconfig.base.json: tsc fails with TS5083 without it, and"
	echo "bun build compiles with none of the options the config was meant to set."
	exit 1
fi

echo "ok:   all $checked Dockerfiles copy every one of the ${#manifests[@]} workspace manifests and required dependency patches, and every context that needs tsconfig.base.json copies it"
