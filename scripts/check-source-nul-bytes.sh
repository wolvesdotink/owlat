#!/usr/bin/env bash
#
# No raw NUL byte in a tracked source file. Git classifies any file holding a
# 0x00 byte as binary, so its diffs stop rendering ("Binary file not shown")
# and a review cannot see what changed. Inside a string the byte is always
# better written as an escape: `\0` (or `\u0000`) in TS/JS, `\0` in Rust.
#
# Hard-0 invariant with no baseline. Binary fixtures (.eml, images, fonts) are
# not source and are not scanned.

set -uo pipefail
cd "$(dirname "$0")/.."

hits="$(
	git ls-files -z -- \
		'*.ts' '*.tsx' '*.mts' '*.cts' '*.js' '*.mjs' '*.cjs' '*.vue' \
		'*.rs' '*.sh' '*.json' '*.md' '*.css' '*.html' '*.yml' '*.yaml' |
		xargs -0 perl -ne 'if (/\x00/) { print "  $ARGV:$.\n"; } close ARGV if eof'
)"

if [ -n "$hits" ]; then
	echo "FAIL: raw NUL byte(s) in source; write the escape (\\0 or \\u0000) instead:" >&2
	echo "$hits" >&2
	exit 1
fi
echo "ok:   no raw NUL byte in tracked source"
