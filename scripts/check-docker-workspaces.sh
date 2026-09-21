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
has_patched_dependencies=$(
	node -e '
const patched = require("./package.json").patchedDependencies;
process.stdout.write(patched && Object.keys(patched).length > 0 ? "1" : "0");
'
) || exit 1
while IFS= read -r dockerfile; do
	joined=$(join_continuations "$dockerfile")
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

# ── Source closure: copying a workspace means copying what it depends on ──
#
# The manifest check above is about what a frozen `bun install` needs. It says
# nothing about the SOURCE tree a bundle actually reads, and the two are not the
# same: `packages/*/package.json` being present is exactly what makes the
# failure confusing, because the workspace symlink resolves and only the files
# behind it are missing.
#
# That is how PR #733 broke the updater and setup images. `@owlat/shared`'s
# barrel gained a re-export of `./address`, which parses through
# `@owlat/mail-message` — a real workspace edge — and the two images that copy
# `packages/shared` without `packages/mail-message` stopped building, while the
# four that already copied both kept working. Nothing in `bun run ci:verify`
# builds images, so CI found it and local verification did not.
#
# The rule, per BUILD STAGE: if a stage copies a workspace's source out of the
# build context, every in-repo workspace that workspace DECLARES as a runtime
# dependency must be present in that stage too, transitively. Declared, not
# reached: the updater's bundle tree-shakes `address.ts` away entirely (the
# string does not appear in dist/index.js) yet the build still fails without the
# source, because the bundler resolves the whole re-export graph before it
# shakes. A gate keyed on what survives into the image would have missed this.
#
# Two asymmetries keep the false-positive rate at zero on this tree:
#   - `COPY --from=<stage>` SATISFIES a dependency without TRIGGERING one. That
#     is how `docker/convex-deploy.Dockerfile` legitimately brings plugin-kit and
#     provider-kit in as built `dist/`, with only their manifests from context.
#   - A `package.json`-only copy is a manifest copy, not a source copy, so the
#     `COPY --parents … package.json` line above never trips this.
#
# Hard-0 with no baseline, like the manifest check it extends.
closure_failures=$(
	node -e '
const fs = require("node:fs");
const cp = require("node:child_process");

const manifests = cp
	.execSync("git ls-files \"packages/*/package.json\" \"apps/*/package.json\" \"examples/*/package.json\" \"examples/plugins/*/package.json\"", { encoding: "utf8" })
	.trim()
	.split("\n")
	.filter(Boolean);

const byName = {};
const byDir = {};
for (const manifestPath of manifests) {
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	const dir = manifestPath.replace(/\/package\.json$/, "");
	// Runtime `dependencies` only: devDependencies are not bundled, and a
	// peerDependency is the consumer’s to provide.
	byName[manifest.name] = { dir, deps: Object.keys(manifest.dependencies ?? {}) };
	byDir[dir] = manifest.name;
}
const dirs = Object.keys(byDir);

function closure(name, seen = new Set()) {
	for (const dep of byName[name]?.deps ?? []) {
		if (byName[dep] && !seen.has(dep)) {
			seen.add(dep);
			closure(dep, seen);
		}
	}
	return seen;
}

// Same continuation folding as join_continuations(), for the same reason: a
// cosmetic re-wrap must not take an image out of the guard’s sight.
const fold = (text) => text.replace(/\\\r?\n/g, " ");

const dockerfiles = cp
	.execSync("git ls-files \"*Dockerfile\" \"*.Dockerfile\"", { encoding: "utf8" })
	.trim()
	.split("\n")
	.filter(Boolean);

for (const file of dockerfiles) {
	const stages = fold(fs.readFileSync(file, "utf8")).split(/^\s*FROM\s/mi).slice(1);
	stages.forEach((stage, index) => {
		const fromContext = new Set();
		const present = new Set();
		for (const line of stage.split("\n")) {
			const copy = line.match(/^\s*COPY\s+(.*)$/i);
			if (!copy) continue;
			let args = copy[1].trim().split(/\s+/);
			const stageScoped = args.some((arg) => arg.startsWith("--from="));
			args = args.filter((arg) => !arg.startsWith("--"));
			for (const source of args.slice(0, -1)) {
				if (source.split("/").pop() === "package.json") continue;
				// A --from= source is an absolute path inside the earlier stage
				// (/app/packages/x, /build/packages/x); map it back to the repo path.
				const path = source.replace(/\/+$/, "").replace(/^\/(app|build)\//, "");
				for (const dir of dirs) {
					if (path !== dir && !path.startsWith(dir + "/")) continue;
					present.add(byDir[dir]);
					if (!stageScoped) fromContext.add(byDir[dir]);
				}
			}
		}
		for (const name of fromContext) {
			for (const needed of closure(name)) {
				if (present.has(needed)) continue;
				console.log(
					`FAIL: ${file} (stage ${index + 1}) copies ${name} source but not its dependency ${needed} (${byName[needed].dir})`
				);
			}
		}
	});
}
'
) || exit 1

if [ -n "$closure_failures" ]; then
	printf '%s\n' "$closure_failures"
	echo ""
	echo "An image that copies a workspace's SOURCE must also copy the source of"
	echo "every in-repo workspace it depends on, transitively — the manifest alone"
	echo "makes the symlink resolve and the files behind it missing."
	exit 1
fi

if [ "$failures" -gt 0 ]; then
	echo ""
	echo "Each image's 'COPY --parents … package.json' line must cover every"
	echo "workspace in the root package.json 'workspaces' globs, or bun's"
	echo "frozen-lockfile check refuses the partial workspace shape."
	exit 1
fi

echo "ok:   all $checked Dockerfiles copy every one of the ${#manifests[@]} workspace manifests and required dependency patches"
echo "ok:   every Dockerfile that copies a workspace's source copies its dependency closure"
