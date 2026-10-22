#!/usr/bin/env bash
# Enforce: a workspace reads the process environment only in its config module.
# This is the lint rule that oxlint can't express directly (no-restricted-syntax
# is not supported). Run as part of each workspace's `bun run lint`.
#
# Usage: check-env.sh [<root> <allowed-path>...]
#
# With no arguments it checks the Convex backend: apps/api/convex, where only
# lib/env.ts may read. The Node services pass their own source root (relative
# to the directory they run in, or absolute) and the files allowed to read,
# each as an exact path relative to that root: the service's config module,
# plus its logger, which builds its level before any config has loaded.
#
# EVERY access form counts, so the pattern is the bare object: `process.env.FOO`,
# `process.env['FOO']`, `process.env?.FOO`, `const { FOO } = process.env` and
# `Object.entries(process.env)` are all the same read, and each one bypasses the
# config module. The bracket and destructuring forms are exactly the shapes a key
# computed at runtime takes. The other ways to get hold of the object itself
# (`process['env']`, `const { env } = process`, `import { env } from
# 'node:process'`) count too. Naming the access syntax at all would leave the
# next form to be discovered by an incident.
#
# Test files (`__tests__/`, `*.test.ts`, `*.spec.ts`) are exempt: they configure
# a test run rather than a deployment.

set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)

if [[ $# -eq 0 ]]; then
	root="${script_dir}/../convex"
	allowed=("lib/env.ts")
	hint="Use getRequired/getOptional/getWithDefault from convex/lib/env.ts and add new keys to the EnvKey union there."
else
	root="$1"
	shift
	allowed=("$@")
	if [[ ${#allowed[@]} -eq 0 ]]; then
		echo "check-env: name at least one file allowed to read the environment under ${root}" >&2
		exit 2
	fi
	hint="Read the variable in ${allowed[0]} and pass the value to the code that needs it."
fi

# A root that does not exist would scan nothing and pass: a renamed source
# directory must fail the gate instead of switching it off.
if [[ ! -d "$root" ]]; then
	echo "check-env: scan root ${root} is not a directory" >&2
	exit 2
fi
root="${root%/}"

# POSIX classes only, so BSD grep on macOS reads the pattern the same way.
ident='[:alnum:]_$'
pattern="process(\\?)?\\.env"
pattern+="|process[[:space:]]*\\[[[:space:]]*['\"\\\`]env"
pattern+="|\\{([^}]*[^${ident}])?env([^${ident}][^}]*)?\\}[[:space:]]*=[[:space:]]*(globalThis\\.)?process([^${ident}.]|$)"
pattern+="|import[[:space:]]*\\{([^}]*[^${ident}])?env([^${ident}][^}]*)?\\}[[:space:]]*from[[:space:]]*['\"](node:)?process['\"]"

matches=""
while IFS= read -r -d '' file; do
	relative="${file#"${root}"/}"
	case "/${relative}" in
		*/__tests__/* | *.test.ts | *.spec.ts) continue ;;
	esac
	for path in "${allowed[@]}"; do
		[[ "$relative" == "$path" ]] && continue 2
	done
	# grep exits 1 when nothing matches, which is the pass; 2 is an error.
	status=0
	hits=$(grep -nE "$pattern" "$file") || status=$?
	if [[ $status -gt 1 ]]; then
		echo "check-env: grep failed on ${file}" >&2
		exit 2
	fi
	if [[ -n "$hits" ]]; then
		matches+="$(awk -v path="$relative" '{ print path ":" $0 }' <<<"$hits")"$'\n'
	fi
done < <(find "$root" -type d -name node_modules -prune -o -type f -name '*.ts' -print0 | sort -z)

if [[ -n "$matches" ]]; then
	echo "ERROR: process.env read outside ${allowed[*]} (under ${root}):"
	echo ""
	printf '%s' "$matches"
	echo ""
	echo "$hint"
	exit 1
fi
