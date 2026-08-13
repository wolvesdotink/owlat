#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# gen-release-compose.sh — Generate a version-pinned docker-compose template.
#
# Reads the checked-in docker-compose.yml and rewrites every
# `ghcr.io/wolvesdotink/<svc>:${OWLAT_VERSION:-dev}` reference to
# `ghcr.io/wolvesdotink/<svc>:<version>`, then writes the result to
# docker-compose-<version>.yml. This is what the release workflow uploads
# as a GitHub Release asset and what the in-app updater downloads and
# applies on upgrade.
#
# With a digests file (what the release workflow passes — one
# `<image-name> sha256:<64-hex>` pair per line, collected from the
# build-push-action outputs), every rewritten Owlat image is additionally
# pinned to `:<version>@sha256:<digest>`, and the script FAILS if any Owlat
# image in the template has no digest. Tag+digest pinning means the updater
# deploys the exact bytes the release pipeline built and signed, even if the
# `:<version>` tag is later moved on GHCR.
#
# Usage:
#   bash scripts/gen-release-compose.sh 1.2.3
#   bash scripts/gen-release-compose.sh 1.2.3 path/to/output.yml
#   bash scripts/gen-release-compose.sh 1.2.3 path/to/output.yml image-digests.txt
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

VERSION="${1:-}"
OUTPUT="${2:-}"
DIGESTS_FILE="${3:-}"

if [[ -z "$VERSION" ]]; then
	echo "Usage: $0 <version> [output-path] [digests-file]" >&2
	echo "Example: $0 1.2.3" >&2
	exit 2
fi

# Strip leading 'v' if present
VERSION="${VERSION#v}"

# Basic semver sanity (major.minor.patch[-prerelease])
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
	echo "Error: version '$VERSION' is not valid semver" >&2
	exit 2
fi

INPUT="docker-compose.yml"
OUTPUT="${OUTPUT:-docker-compose-${VERSION}.yml}"

if [[ ! -f "$INPUT" ]]; then
	echo "Error: $INPUT not found (run from repo root)" >&2
	exit 2
fi

if [[ -n "$DIGESTS_FILE" && ! -f "$DIGESTS_FILE" ]]; then
	echo "Error: digests file '$DIGESTS_FILE' not found" >&2
	exit 2
fi

# Rewrite (delimiter is `#` so the `(latest|dev)` alternation is safe):
#   ghcr.io/wolvesdotink/<svc>:${OWLAT_VERSION:-dev}      →  ghcr.io/wolvesdotink/<svc>:<version>
#   ghcr.io/wolvesdotink/<svc>:${OWLAT_VERSION:-latest}   →  ghcr.io/wolvesdotink/<svc>:<version>
#   ghcr.io/wolvesdotink/<svc>:${OWLAT_VERSION}           →  ghcr.io/wolvesdotink/<svc>:<version>
#   ghcr.io/wolvesdotink/<svc>:{latest,dev}               →  ghcr.io/wolvesdotink/<svc>:<version>
#
# (Other images like ghcr.io/get-convex/* and redis: are untouched.)
sed -E \
	-e "s#(ghcr\.io/wolvesdotink/[a-z0-9-]+):\\\$\\{OWLAT_VERSION:-[A-Za-z0-9._-]+\\}#\\1:${VERSION}#g" \
	-e "s#(ghcr\.io/wolvesdotink/[a-z0-9-]+):\\\$\\{OWLAT_VERSION\\}#\\1:${VERSION}#g" \
	-e "s#(ghcr\.io/wolvesdotink/[a-z0-9-]+):(latest|dev)#\\1:${VERSION}#g" \
	"$INPUT" > "$OUTPUT"

# Pin each Owlat image to its concrete manifest digest (:<version>@sha256:<hex>).
# The digests file has one `<image-name> sha256:<64-hex>` pair per line; extra
# entries for images the template does not reference (setup, code-worker) are
# fine, but an Owlat image left WITHOUT a digest fails the run — a half-pinned
# release artifact would silently defeat the point of pinning.
if [[ -n "$DIGESTS_FILE" ]]; then
	while read -r name digest; do
		[[ -z "$name" ]] && continue
		if [[ ! "$name" =~ ^[a-z0-9-]+$ || ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
			echo "Error: malformed digests line: '$name $digest' (want '<image-name> sha256:<64-hex>')" >&2
			exit 2
		fi
		sed -E -i.bak \
			"s#(ghcr\.io/wolvesdotink/${name}):${VERSION}([^@]|\$)#\\1:${VERSION}@${digest}\\2#g" \
			"$OUTPUT"
		rm -f "${OUTPUT}.bak"
	done < "$DIGESTS_FILE"

	unpinned=$(grep -E "^[[:space:]]+image:[[:space:]]+ghcr\.io/wolvesdotink/" "$OUTPUT" \
		| grep -vE "@sha256:[0-9a-f]{64}[[:space:]]*$" || true)
	if [[ -n "$unpinned" ]]; then
		echo "Error: Owlat image(s) without a digest pin — is the digests file missing an entry?" >&2
		printf '%s\n' "$unpinned" >&2
		exit 1
	fi
fi

# Prepend a header that makes the file self-identifying
PIN_DESCRIPTION=":${VERSION}"
if [[ -n "$DIGESTS_FILE" ]]; then
	PIN_DESCRIPTION=":${VERSION}@sha256:<digest> (tag + manifest digest)"
fi
TMP=$(mktemp)
cat > "$TMP" <<EOF
# ═══════════════════════════════════════════════════════════════════════════════
# Owlat v${VERSION} — pinned docker-compose template
#
# Auto-generated from docker-compose.yml by scripts/gen-release-compose.sh
# Every ghcr.io/wolvesdotink/* image is pinned to ${PIN_DESCRIPTION}.
#
# This is the file the in-app updater downloads and applies when you upgrade
# to v${VERSION}. You can also apply it manually:
#
#   curl -fsSL https://github.com/wolvesdotink/owlat/releases/download/v${VERSION}/docker-compose-${VERSION}.yml \\
#     -o docker-compose.yml
#   docker compose pull
#   docker compose up -d
#   docker compose --profile deploy run --rm convex-deploy
# ═══════════════════════════════════════════════════════════════════════════════

EOF
cat "$OUTPUT" >> "$TMP"
mv "$TMP" "$OUTPUT"

echo "Generated $OUTPUT"
echo ""
echo "Pinned images:"
grep -E "^[[:space:]]+image:[[:space:]]+ghcr\.io/wolvesdotink/" "$OUTPUT" | sed 's/^[[:space:]]*/  /'
