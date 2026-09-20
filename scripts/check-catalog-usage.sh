#!/usr/bin/env bash
#
# Workspace manifest guard: catalog usage, and test/test:coverage parity.
#
# 1. Bun catalogs are the repository's single pin for the shared toolchain
#    (typescript, vitest, vue, convex, …). A workspace that writes a literal
#    range for a catalogued name silently opts out: before this guard existed
#    three apps sat on typescript ^7 while everything else resolved ^6, and
#    apps/code-worker ran a convex nine minors behind the backend it talks to.
#    Nothing failed — the tree just stopped being one toolchain.
#
# 2. `scripts/ci-select-affected.sh` builds the pull-request test matrix from
#    `turbo run test:coverage --affected`. A workspace with `test` but no
#    `test:coverage` is therefore unreachable on pull requests: its tests only
#    ever run on the full-run safety valve. That is the same class of silent
#    opt-out, so it is checked in the same place.
#
# Both are hard-0 invariants with no baseline, like check-docker-workspaces.sh.

set -uo pipefail
cd "$(dirname "$0")/.."

# Workspaces the root manifest declares, expanded to real directories, with
# negated globs ("!packages/sdk-java") dropping their matches — the same
# expansion check-docker-workspaces.sh performs, and the same one bun does.
mapfile -t globs < <(node -e '
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

kept=()
for manifest in ${manifests[@]+"${manifests[@]}"}; do
	skip=""
	for drop in ${excluded[@]+"${excluded[@]}"}; do
		[ "$manifest" = "$drop" ] && skip=1
	done
	[ -n "$skip" ] || kept+=("$manifest")
done
manifests=(${kept[@]+"${kept[@]}"})

if [ ${#manifests[@]} -eq 0 ]; then
	echo "FAIL: no workspace package.json files matched the root workspaces globs" >&2
	exit 1
fi

node -e '
const { readFileSync } = require("node:fs");

const declared = require("./package.json").workspaces;

// Dependency name -> the catalog references that would be valid for it.
const catalogued = new Map();
const add = (name, reference) => {
	const references = catalogued.get(name) ?? new Set();
	references.add(reference);
	catalogued.set(name, references);
};
for (const name of Object.keys(declared?.catalog ?? {})) add(name, "catalog:");
for (const [catalog, entries] of Object.entries(declared?.catalogs ?? {})) {
	for (const name of Object.keys(entries)) add(name, `catalog:${catalog}`);
}
if (catalogued.size === 0) {
	console.error("FAIL: root package.json declares no catalogs; the guard sees nothing");
	process.exit(1);
}

const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];

const manifests = process.argv.slice(1);
const failures = [];
for (const path of manifests) {
	const manifest = JSON.parse(readFileSync(path, "utf8"));

	for (const field of DEPENDENCY_FIELDS) {
		for (const [name, range] of Object.entries(manifest[field] ?? {})) {
			const references = catalogued.get(name);
			if (!references || references.has(range)) continue;
			failures.push(
				`${path}: ${field}.${name} is "${range}"; the root catalog owns this pin, use ` +
					[...references].join(" or ")
			);
		}
	}

	const scripts = manifest.scripts ?? {};
	if (scripts.test && !scripts["test:coverage"]) {
		failures.push(
			`${path}: has a "test" script but no "test:coverage"; the pull-request matrix is built ` +
				"from `turbo run test:coverage --affected`, so these tests would never run on a PR"
		);
	}
}

if (failures.length > 0) {
	for (const failure of failures) console.log(`FAIL: ${failure}`);
	process.exit(1);
}

console.log(
	`ok:   all ${manifests.length} workspaces take their ${catalogued.size} catalogued pins ` +
		"from the catalog and expose test:coverage"
);
' "${manifests[@]}" || exit 1
