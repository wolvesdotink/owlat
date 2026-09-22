#!/usr/bin/env bash
#
# Fail if an icon name cannot end up in the shipped client bundle. @nuxt/icon
# bundles the icons it finds by scanning source files (nuxt.config.ts →
# icon.clientBundle.scan); anything it misses is left to the runtime, which
# fetches it from api.iconify.design. The web app gets away with that, the
# DESKTOP app does not: it is a static bundle inside the Tauri webview with no
# Nitro server and, for most users, no route to the Iconify API — the icon
# simply renders as an empty box, with no build error and no console error.
# Two guards, matching the two ways a name goes missing:
#
#   1. RESOLVABLE — every `lucide:<name>` must exist in the installed
#      @iconify-json/lucide collection (as an icon or an alias). Typos never
#      surface at runtime, and upstream drops deprecated aliases between minor
#      versions, which would silently blank every screen using the old name.
#   2. REACHABLE — the file holding the name must have an extension the scan
#      globs read. A name that only ever appears in, say, a .js module is
#      invisible to the bundler however correct it is.
#
# Usage: check-icon-names.sh [root...]
# Roots are optional and exist so the rules can be self-tested against a fixture
# tree (`app/__tests__/iconNames.lint.test.ts`); pass them ABSOLUTE, because
# this script cd's to apps/web first.
set -euo pipefail
cd "$(dirname "$0")/.."

# Resolved through node rather than a hard-coded path: the collection is a
# workspace dependency and the package manager decides where it is hoisted to.
ICONS_JSON="$(node -p "require.resolve('@iconify-json/lucide/icons.json')" 2>/dev/null || true)"
if [ -z "$ICONS_JSON" ] || [ ! -f "$ICONS_JSON" ]; then
	echo "✗ @iconify-json/lucide is not installed — icon names cannot be verified" >&2
	exit 1
fi

# The app is not the only place an icon is named: the shared components in
# packages/ui render on the same screens, and that layer sits outside the Nuxt
# rootDir the scan globs — nuxt.config.ts reads its names separately, and this
# guard is what keeps that second path honest.
if [ "$#" -eq 0 ]; then
	roots=(app ../../packages/ui)
else
	roots=("$@")
fi

# A MISSING ROOT IS A FAILURE, NOT AN EMPTY SCAN — otherwise a renamed directory
# keeps being reported as covered while nothing under it is read.
for root in "${roots[@]}"; do
	if [ ! -d "$root" ]; then
		echo "✗ scan root does not exist: $root (roots: ${roots[*]})" >&2
		exit 1
	fi
done

# Extensions the bundle is built from: @nuxt/icon's scan globs for the app
# (nuxt.config.ts → clientBundle.scan) and `uiLayerIconNames()` for the layer.
# Keep in step with both.
SCANNED_EXT='vue|jsx|tsx|ts|md|mdc|mdx|yml|yaml'

# TESTS ARE NOT MARKUP. A name in a spec renders nothing, so it can neither
# reach a user as an empty box nor fail to — and the assertions that pin these
# very rules quote a deliberately broken name by construction.
mapfile -t hits < <(
	grep -rHnoE --binary-files=without-match \
		--exclude-dir=node_modules --exclude-dir=.nuxt --exclude-dir=dist --exclude-dir=coverage \
		--exclude-dir=__tests__ --exclude='*.test.ts' --exclude='*.spec.ts' \
		'\blucide:[a-z0-9-]+' "${roots[@]}" 2>/dev/null | sort -u
)

fail=0

# ── Guard 1: every name must resolve in the installed collection ──────────────
# Aliases count: `lucide:alert-triangle` is an alias of `triangle-alert` and
# renders fine — until upstream removes it, which is the case this catches.
unknown=$(
	printf '%s\n' "${hits[@]}" | ICONS_JSON="$ICONS_JSON" node -e '
		const fs = require("node:fs");
		const { icons, aliases } = JSON.parse(fs.readFileSync(process.env.ICONS_JSON, "utf8"));
		const known = new Set([...Object.keys(icons), ...Object.keys(aliases ?? {})]);
		let input = "";
		process.stdin.on("data", (c) => (input += c));
		process.stdin.on("end", () => {
			for (const line of input.split("\n").filter(Boolean)) {
				// grep -o output: path:line:lucide:<name>
				const name = line.slice(line.lastIndexOf("lucide:") + "lucide:".length);
				if (!known.has(name)) console.log(line);
			}
		});
	'
)
if [ -n "$unknown" ]; then
	echo "✗ icon names that do not exist in @iconify-json/lucide (render as an empty box):"
	echo "$unknown"
	echo "  Look the name up at https://lucide.dev/icons — the lucide names in iconify are"
	echo "  kebab-case and deprecated spellings are dropped between releases."
	fail=1
fi

# ── Guard 2: the file must be one the bundler scan reads ──────────────────────
unreachable=$(printf '%s\n' "${hits[@]}" | grep -vE "\.($SCANNED_EXT):[0-9]+:" || true)
if [ -n "$unreachable" ]; then
	echo "✗ icon names in files the client-bundle scan does not read (missing offline):"
	echo "$unreachable"
	echo "  Move the name into a scanned file (${SCANNED_EXT//|/, }) or widen the"
	echo "  icon.clientBundle globs in nuxt.config.ts."
	fail=1
fi

[ "$fail" -eq 1 ] && exit 1
# The scanned roots are named, so a passing run states what it actually covered.
echo "ok:   ${#hits[@]} icon references resolve and are bundleable in ${roots[*]}"
