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
#
# For the Convex backend (the no-argument form) the oxlint rule
# owlat/no-process-env (packages/oxlint-plugin-owlat) enforces this on the AST
# and runs beside this script until scripts/ast-gate-parity.ts
# (`bun run lint:ast-gate-parity`) shows the two agree; a change to what this
# script reports there needs the same change in the rule, or that gate fails.

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

# Each file is matched as one string, not line by line: a statement split over
# lines (`import {\n\tenv,\n} from 'node:process'`) is the same read as the
# one-line form, and a line-based grep never sees its two halves together. So
# grep reads the file with newlines turned into spaces, which keeps every byte
# offset, and a hit is reported at the line holding its first byte.
#
# POSIX classes and bracket expressions only (no backslash escapes), so BSD grep
# on macOS reads the pattern the same way. Not awk: mawk, the default awk on
# Debian and Ubuntu, misses the leftmost match of an alternation like this one.
ident='[:alnum:]_$'
ws='[[:space:]]*'
quote="['\"\`]"
# The body of a destructuring pattern, one nesting level deep, so a default
# (`{ env = {} }`) or a nested pattern (`{ env: { FOO } }`) does not end it early.
body="([^{}]|[{][^{}]*[}])*"
pattern="process${ws}[?]?${ws}[.]${ws}env"
pattern+="|process${ws}[[]${ws}${quote}env"
pattern+="|[{](${body}[^${ident}{}])?env([^${ident}{}]${body})?[}]${ws}=${ws}(globalThis${ws}[.]${ws})?process([^${ident}.]|$)"
pattern+="|import${ws}[{](${body}[^${ident}{}])?env([^${ident}{}]${body})?[}]${ws}from${ws}${quote}(node:)?process${quote}"

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
	offsets=$(tr '\n' ' ' <"$file" | LC_ALL=C grep -obE "$pattern") || status=$?
	if [[ $status -gt 1 ]]; then
		echo "check-env: grep failed on ${file}" >&2
		exit 2
	fi
	[[ -z "$offsets" ]] && continue
	reported=" "
	while IFS=: read -r offset _; do
		line=$(($(head -c "$offset" "$file" | wc -l) + 1))
		[[ "$reported" == *" ${line} "* ]] && continue
		reported+="${line} "
		matches+="${relative}:${line}:$(sed -n "${line}p" "$file")"$'\n'
	done <<<"$offsets"
done < <(find "$root" -type d -name node_modules -prune -o -type f -name '*.ts' -print0 | sort -z)

if [[ -n "$matches" ]]; then
	echo "ERROR: process.env read outside ${allowed[*]} (under ${root}):"
	echo ""
	printf '%s' "$matches"
	echo ""
	echo "$hint"
	exit 1
fi
