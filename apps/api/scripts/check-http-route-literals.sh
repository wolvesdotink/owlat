#!/usr/bin/env bash
#
# check-http-route-literals.sh
#
# Every route path in convex/http.ts is a written-out string literal. The
# feedback webhook URLs are pasted into provider consoles we do not own, so a
# router built as `for (const kind of KINDS) http.route({ path: \`/webhooks/${kind}\` })`
# would make each URL a function of a kind's spelling: a rename moves the URL,
# silently on our side and totally on theirs. Comments are stripped first so a
# loop with the old literals left commented "for reference" still fails.
#
set -uo pipefail
cd "$(dirname "$0")/.." # apps/api

http=convex/http.ts

# Strip /* */ blocks and // comments (a URL scheme's `//` survives) so a loop
# with the old literals left commented out "for reference" still fails.
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

derived=$(strip_comments "$http" | grep -nE "\bpath(Prefix)?:[[:space:]]*[^[:space:]'\"]" || true)

if [ -n "$derived" ]; then
	echo "FAIL: $http derives a route path instead of writing it out as a literal:" >&2
	printf '%s\n' "$derived" >&2
	exit 1
fi
literal_count=$(grep -cE "\bpath(Prefix)?:[[:space:]]*'" "$http" || true)
if [ "$literal_count" -lt 10 ]; then
	echo "FAIL: only $literal_count literal route paths in $http — the router shape changed; update this check" >&2
	exit 1
fi
echo "check-http-route-literals: OK ($literal_count literal route paths)"
