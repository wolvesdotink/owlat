#!/usr/bin/env bash
#
# Guard against stale committed Convex codegen.
#
# Verifies that _generated/api.d.ts imports and maps exactly the modules
# `convex codegen` would list: no module missing, no entry for a file that is
# not a module. `bun run codegen` needs this checkout's local backend
# (`bun run dev:stack`); this static check needs nothing, so CI runs it.
#
# The module rules below are the Convex CLI's entry-point rules (the
# `entryPoints` walk in convex/dist/esm/bundler/index.js) applied to the tree
# `bun run codegen` hands the CLI, which leaves out every `__tests__`
# directory (scripts/dev-stack/stage.ts). If the CLI changes them, change
# them here.
#
set -euo pipefail
cd "$(dirname "$0")/.." # apps/api

CONVEX_ROOT="${CODEGEN_SOURCE_DIR:-convex}"
GEN="${CODEGEN_DECLARATION_FILE:-convex/_generated/api.d.ts}"

# A directory below the root with its own convex.config.ts is a component; its
# modules are generated into its own _generated/, not into the root api.
component_dirs=()
while IFS= read -r config; do
	dir="$(dirname "$config")"
	[ "$dir" = "$CONVEX_ROOT" ] || component_dirs+=("$dir/")
done < <(find "$CONVEX_ROOT" -name convex.config.ts -not -path '*/node_modules/*')

in_component() {
	local file="$1" dir
	for dir in ${component_dirs[@]+"${component_dirs[@]}"}; do
		[[ "$file" == "$dir"* ]] && return 0
	done
	return 1
}

is_module() {
	local file="$1" base
	base="$(basename "$file")"
	case "$base" in
	.* | '#'* | schema.ts | schema.js) return 1 ;;
	esac
	# More than one dot: *.test.ts, *.d.ts, *.config.ts, *.generated.ts.
	[[ "$base" == *.*.* ]] && return 1
	[[ "$file" == *' '* ]] && return 1
	case "$base" in
	*.ts | *.tsx) grep -Eq '^[[:space:]]{0,100}(import|export)' "$file" || return 1 ;;
	esac
	return 0
}

expected=()
while IFS= read -r file; do
	in_component "$file" && continue
	is_module "$file" || continue
	key="${file#"$CONVEX_ROOT"/}"
	expected+=("${key%.*}")
done < <(find "$CONVEX_ROOT" -type f \
	\( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.cts' \
	-o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' -o -name '*.cjs' \) \
	-not -path "$CONVEX_ROOT/_generated/*" \
	-not -path '*/__tests__/*' \
	-not -path '*/node_modules/*' | LC_ALL=C sort)

missing=0
for key in ${expected[@]+"${expected[@]}"}; do
	import_line="$(
		grep -F "../$key.js" "$GEN" |
			grep -E '^import type \* as [A-Za-z0-9_]+ from ' || true
	)"
	if [[ -z "$import_line" ]]; then
		echo "  missing import from _generated/api.d.ts: $key"
		missing=$((missing + 1))
		continue
	fi
	module_alias="${import_line#import type * as }"
	module_alias="${module_alias%% from *}"
	if ! grep -Fq "'$key': typeof $module_alias;" "$GEN" &&
		! grep -Fq "\"$key\": typeof $module_alias;" "$GEN" &&
		! grep -Fq "$key: typeof $module_alias;" "$GEN"; then
		echo "  missing fullApi mapping from _generated/api.d.ts: $key"
		missing=$((missing + 1))
	fi
done

# An entry for a file the CLI does not treat as a module types a function that
# is never deployed.
extra=0
while IFS= read -r key; do
	echo "  _generated/api.d.ts imports a file that is not a Convex module: $key"
	extra=$((extra + 1))
done < <(
	LC_ALL=C comm -13 \
		<(printf '%s\n' ${expected[@]+"${expected[@]}"} | LC_ALL=C sort -u) \
		<(sed -nE "s#^import type \\* as [A-Za-z0-9_]+ from ['\"]\\.\\./(.+)\\.js['\"];?\$#\\1#p" "$GEN" |
			LC_ALL=C sort -u)
)

if [ "$missing" -gt 0 ] || [ "$extra" -gt 0 ]; then
	echo "FAIL: _generated/api.d.ts does not list the Convex modules in convex/."
	echo "      Start this checkout's backend with 'bun run dev:stack', run"
	echo "      'bun run --cwd apps/api codegen', and commit the result."
	exit 1
fi

echo "ok:   _generated/api.d.ts imports and maps every Convex module"

# `convex codegen` declares fullApi as one ApiFromModules over every module,
# which TypeScript cannot type at this size (api/internal silently become
# never); the declaration must stay split into the per-directory chunks that
# scripts/apiDeclarationChunks.ts writes.
bun scripts/codegen-api-chunks.ts --check "$GEN"
