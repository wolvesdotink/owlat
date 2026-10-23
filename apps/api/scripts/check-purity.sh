#!/usr/bin/env bash
#
# check-purity.sh
#
# A decision core takes data and returns a verdict; the shell around it loads,
# calls and writes. The cores are listed in scripts/purity-roots.txt: the ramp
# and its signal sources, the decision plane's contracts and rules, and the
# lifecycle reducers. No guarded module may contain a clock, a random source,
# an environment read, a timer, a network call, a database handle or a Convex
# function wrapper; whatever it needs of those is injected by its caller. A
# source grep rather than a mock, because a mock only proves the paths a test
# walked. The behavioural halves (identical input, identical output) live with
# each core's tests, e.g. convex/delivery/ramp/__tests__/gates.purity.test.ts.
#
# Manifest lines (paths relative to apps/api, `#` starts a comment):
#   <path>              a guarded file, or a directory guarded recursively
#                       (tests, `__tests__/` and `_generated/` are skipped)
#   !<path> [name...]   a shell inside a guarded directory: not checked, and a
#                       guarded module may value-import from it only the names
#                       listed after it (pure helpers that live with the shell);
#                       loading it without a name (`import './x'`, `import()`,
#                       `require()`) is refused. A directory root must keep at
#                       least one module that is not a shell.
#
# `--list` prints the guarded modules after validating the manifest.
#
# The check is per file: a guarded module that calls an impure helper from an
# unlisted module outside the manifest is not caught. The shell boundary is
# what keeps a reducer from reaching into its own runner.
#
set -uo pipefail
cd "$(dirname "$0")/.." # apps/api

manifest=scripts/purity-roots.txt
mode=${1:-check}
status=0

fail() {
	echo "FAIL: $*" >&2
	status=1
}

if [ ! -f "$manifest" ]; then
	echo "check-purity: $manifest missing" >&2
	exit 1
fi

# Collapse `.` and `..` segments of a relative path.
normalize() {
	local part out=() parts
	IFS=/ read -r -a parts <<<"$1"
	for part in "${parts[@]}"; do
		case $part in
		'' | .) ;;
		..) [ "${#out[@]}" -gt 0 ] && unset "out[$((${#out[@]} - 1))]" && out=("${out[@]}") ;;
		*) out+=("$part") ;;
		esac
	done
	local IFS=/
	echo "${out[*]}"
}

production_files() {
	find "$1" -type f -name '*.ts' \
		-not -path '*/__tests__/*' -not -path '*/_generated/*' \
		! -name '*.test.ts' ! -name '*.d.ts' | LC_ALL=C sort
}

is_production_file() {
	case $1 in
	*/__tests__/* | */_generated/* | *.test.ts | *.d.ts) return 1 ;;
	*.ts) return 0 ;;
	*) return 1 ;;
	esac
}

# ─── Manifest ────────────────────────────────────────────────────────────────

roots=()
shells=()
declare -A shell_names=()
declare -A is_shell=()
lineno=0
while IFS= read -r raw || [ -n "$raw" ]; do
	lineno=$((lineno + 1))
	line=${raw%%#*}
	read -r -a fields <<<"$line"
	[ "${#fields[@]}" -eq 0 ] && continue
	entry=${fields[0]}
	if [[ $entry == '!'* ]]; then
		path=$(normalize "${entry#!}")
		if [ -n "${is_shell[$path]:-}" ]; then
			fail "$manifest:$lineno lists the shell $path twice"
			continue
		fi
		shells+=("$path")
		is_shell[$path]=1
		shell_names[$path]=" ${fields[*]:1} "
	else
		[ "${#fields[@]}" -gt 1 ] && fail "$manifest:$lineno: a root takes no names ($line)"
		roots+=("$(normalize "$entry")")
	fi
done <"$manifest"

if [ "${#roots[@]}" -eq 0 ]; then
	echo "check-purity: $manifest lists no roots" >&2
	exit 1
fi

# A renamed or moved root enumerates to nothing and would pass vacuously.
declare -A is_guarded=()
guarded=()
for root in "${roots[@]}"; do
	if [ -d "$root" ]; then
		found=$(production_files "$root")
		if [ -z "$found" ]; then
			fail "root $root holds no production module — the decision core moved"
			continue
		fi
		cores=0
		while IFS= read -r file; do
			[ -n "${is_shell[$file]:-}" ] && continue
			cores=$((cores + 1))
			[ -n "${is_guarded[$file]:-}" ] && continue
			is_guarded[$file]=1
			guarded+=("$file")
		done <<<"$found"
		# Shells are not checked, so a root left holding only shells guards nothing.
		[ "$cores" -eq 0 ] && fail "root $root holds only shells — the decision core moved"
	elif [ -f "$root" ]; then
		if ! is_production_file "$root"; then
			fail "root $root is not a production TypeScript module"
			continue
		fi
		[ -n "${is_guarded[$root]:-}" ] && continue
		is_guarded[$root]=1
		guarded+=("$root")
	else
		fail "root $root missing — the decision core moved"
	fi
done

# A shell must sit inside a guarded directory: anywhere else it excludes nothing.
for shell in "${shells[@]}"; do
	if [ ! -f "$shell" ]; then
		fail "shell $shell missing — delete its line from $manifest"
		continue
	fi
	inside=""
	for root in "${roots[@]}"; do
		[ -d "$root" ] && [[ $shell == "$root"/* ]] && inside=1
	done
	[ -z "$inside" ] && fail "shell $shell is not inside a guarded directory — delete its line from $manifest"
done

if [ "$mode" = "--list" ]; then
	printf '%s\n' "${guarded[@]}"
	exit "$status"
fi

# ─── Per-file rules ──────────────────────────────────────────────────────────

# Strip /* */ blocks and // comments: prose may talk about clocks and
# databases, code may not use them.
strip_comments() {
	awk '
		{
			line = $0; out = ""
			while (length(line) > 0) {
				if (inblock) {
					i = index(line, "*/")
					if (i == 0) { line = ""; break }
					line = substr(line, i + 2); inblock = 0
				} else {
					b = index(line, "/*"); c = index(line, "//")
					# A `//` before any `/*`, and not the `//` of a URL scheme, ends the
					# code on this line — so `// see /api/x/*` cannot open a block.
					if (c > 0 && (b == 0 || c < b) && (c == 1 || substr(line, c - 1, 1) != ":")) {
						out = out substr(line, 1, c - 1); line = ""
					} else if (b == 0) {
						out = out line; line = ""
					} else {
						out = out substr(line, 1, b - 1); line = substr(line, b + 2); inblock = 1
					}
				}
			}
			print out
		}' "$1"
}

# Environment reads go through lib/env.ts everywhere else, so importing it is
# the environment read a guarded module could still make.
rules=(
	"a clock|Date\.now|new Date\b|performance\.now"
	"randomness|Math\.random|crypto\."
	"an environment read|process\.env|from ['\"](\./|(\.\./)+)(lib/)?env['\"]"
	"a timer|\b(setTimeout|setInterval|setImmediate)\("
	"a network call|\bfetch\("
	"a database handle|\bctx\b|\bdb\."
	"a Convex function wrapper|\b(query|mutation|internalAction|action)\("
)

# `spec<TAB>name` for every value a module imports or re-exports from a
# relative path; `import type` / `export type` and `type` members are erased at
# compile time and skipped. A default import is `default`, a namespace `*`. A
# statement that loads a module without binding a name (`import './x'`,
# `import {} from './x'`) is `<side-effect import>`: it runs the module's
# top-level code, which is what the shell boundary exists to keep out.
value_imports() {
	awk '
		function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
		function flush(stmt,   spec, clause, inner, rest, parts, n, i, name, braces) {
			if (stmt ~ /^(import|export)[ \t]+type[ \t{]/) return
			if (match(stmt, /^import[ \t]*["\047][^"\047]+["\047]/)) {
				spec = substr(stmt, RSTART, RLENGTH)
				sub(/^import[ \t]*["\047]/, "", spec); sub(/["\047]$/, "", spec)
				if (spec ~ /^\./) print spec "\t<side-effect import>"
				return
			}
			if (!match(stmt, /from[ \t]*["\047][^"\047]+["\047]/)) return
			spec = substr(stmt, RSTART, RLENGTH)
			sub(/^from[ \t]*["\047]/, "", spec); sub(/["\047]$/, "", spec)
			if (spec !~ /^\./) return
			clause = substr(stmt, 1, RSTART - 1)
			sub(/^(import|export)[ \t]*/, "", clause)
			rest = clause
			braces = 0
			if (match(clause, /\{[^}]*\}/)) {
				inner = substr(clause, RSTART + 1, RLENGTH - 2)
				rest = substr(clause, 1, RSTART - 1) substr(clause, RSTART + RLENGTH)
				n = split(inner, parts, ",")
				for (i = 1; i <= n; i++) {
					name = trim(parts[i])
					if (name == "") continue
					braces = 1
					if (name ~ /^type[ \t]/) continue
					sub(/[ \t]+as[ \t].*$/, "", name)
					print spec "\t" name
				}
			}
			if (rest ~ /\*/) print spec "\t*"
			gsub(/\*[ \t]*as[ \t]+[A-Za-z_$][A-Za-z0-9_$]*/, "", rest)
			gsub(/[ \t,*]/, "", rest)
			if (rest != "") print spec "\tdefault"
			else if (!braces && clause !~ /\*/) print spec "\t<side-effect import>"
		}
		{
			if (!collecting) {
				if ($0 !~ /^[ \t]*import[ \t{*"\047]/ && $0 !~ /^[ \t]*export[ \t]*(type[ \t]*)?[{*]/) next
				collecting = 1; stmt = ""
			}
			stmt = stmt " " $0
			if (stmt ~ /from[ \t]*["\047][^"\047]+["\047]/ || stmt ~ /;[ \t]*$/ || trim(stmt) ~ /^import[ \t]*["\047][^"\047]+["\047]/) {
				flush(trim(stmt)); collecting = 0
			}
		}'
}

# `spec<TAB><kind>` for every `import(...)` or `require(...)` of a string
# literal, wherever it sits (a call may span lines, so the module is read as
# one line). Type queries such as `import('./x').T` are reported too: a
# guarded module names a shell's types with `import type`.
runtime_loads() {
	tr '\n' ' ' | { grep -oE "(^|[^A-Za-z0-9_$.])(import|require)[[:space:]]*\([[:space:]]*[\"'\`][^\"'\`]+[\"'\`]" || true; } |
		sed -E "s/^[^a-z]*(import|require)[[:space:]]*\([[:space:]]*[\"'\`]([^\"'\`]+)[\"'\`]$/\2	<\1()>/" |
		{ grep -E '^\.' || true; }
}

# The module a relative specifier resolves to, the way TypeScript's bundler
# resolution finds it: `./x.js` names `x.ts`, `./x` tries `x.ts` then
# `x/index.ts`.
resolve_import() {
	local target stem candidate candidates=()
	target=$(normalize "${1%/*}/$2")
	stem=${target%.*}
	case $2 in
	*/) candidates=("$target/index.ts" "$target/index.tsx" "$target/index.d.ts") ;;
	*.js | *.jsx) candidates=("$stem.ts" "$stem.tsx" "$stem.d.ts" "$target") ;;
	*.mjs) candidates=("$stem.mts" "$stem.d.mts" "$target") ;;
	*.cjs) candidates=("$stem.cts" "$stem.d.cts" "$target") ;;
	*.ts | *.tsx | *.mts | *.cts) candidates=("$target") ;;
	*) candidates=("$target.ts" "$target.tsx" "$target.d.ts" "$target/index.ts" "$target/index.tsx" "$target/index.d.ts") ;;
	esac
	for candidate in "${candidates[@]}"; do
		if [ -f "$candidate" ]; then
			echo "$candidate"
			return
		fi
	done
}

declare -A shell_name_used=()
for file in "${guarded[@]}"; do
	code=$(strip_comments "$file")
	for rule in "${rules[@]}"; do
		name=${rule%%|*}
		pattern=${rule#*|}
		# Here-string, not a pipe: `grep -q` exits on the first match and a
		# producer still writing dies of SIGPIPE, which pipefail turns into a
		# silently skipped rule. See check-ramp-decision-path.sh.
		if grep -Eq "$pattern" <<<"$code"; then
			fail "$file contains $name ($pattern) — the decision core is pure; inject it"
		fi
	done
	while IFS=$'\t' read -r spec imported; do
		[ -z "$spec" ] && continue
		target=$(resolve_import "$file" "$spec")
		[ -z "$target" ] && continue
		[ -z "${is_shell[$target]:-}" ] && continue
		if [[ $imported == '<'* ]]; then
			# The allowlist names bindings; a load that binds none is never allowed.
			fail "$file loads the shell $target with $imported — import the pure names it needs, or name its types with import type"
		elif [[ ${shell_names[$target]} == *" $imported "* ]]; then
			shell_name_used["$target $imported"]=1
		else
			fail "$file imports $imported from the shell $target — move it into a guarded module, or list it after the shell in $manifest if it is pure"
		fi
	done < <(
		value_imports <<<"$code"
		runtime_loads <<<"$code"
	)
done

for shell in "${shells[@]}"; do
	read -r -a names <<<"${shell_names[$shell]}"
	for imported in "${names[@]}"; do
		if [ -z "${shell_name_used["$shell $imported"]:-}" ]; then
			fail "$manifest allows $imported from $shell but no guarded module imports it — delete the name"
		fi
	done
done

if [ "$status" -eq 0 ]; then
	echo "check-purity: OK (${#guarded[@]} modules)"
fi
exit "$status"
