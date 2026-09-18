#!/usr/bin/env bash
#
# check-ramp-purity.sh
#
# The ramp decision core (convex/delivery/ramp and convex/delivery/signals) takes
# data and returns verdicts; the cron is the shell that loads, calls and writes.
# No module in either directory may contain a clock, a random source, an
# environment read, a database handle or a Convex function wrapper. A source
# grep rather than a mock, because a mock only proves the paths a test walked.
# The behavioural half (identical input, identical output; the injected clock
# is the only clock) lives in convex/delivery/ramp/__tests__/gates.purity.test.ts.
#
set -uo pipefail
cd "$(dirname "$0")/.." # apps/api

roots=(convex/delivery/ramp convex/delivery/signals)

# Landmarks: a renamed or moved root enumerates to nothing and passes vacuously.
for landmark in convex/delivery/ramp/gates.ts convex/delivery/signals/rampGateSources.ts; do
	if [ ! -f "$landmark" ]; then
		echo "check-ramp-purity: landmark $landmark missing — the decision core moved" >&2
		exit 1
	fi
done

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

rules=(
	"a clock|Date\.now|new Date\b|performance\.now"
	"randomness|Math\.random|crypto\."
	"an environment read|process\.env"
	"a database handle|\bctx\b|\bdb\."
	"a Convex function wrapper|\b(query|mutation|internalAction|action)\("
)

status=0
for root in "${roots[@]}"; do
	for file in "$root"/*.ts; do
		[ -f "$file" ] || continue
		code=$(strip_comments "$file")
		for rule in "${rules[@]}"; do
			name=${rule%%|*}
			pattern=${rule#*|}
			# Here-string, not a pipe: `grep -q` exits on the first match and a
			# producer still writing dies of SIGPIPE, which pipefail turns into a
			# silently skipped rule. See check-ramp-decision-path.sh.
			if grep -Eq "$pattern" <<<"$code"; then
				echo "FAIL: $file contains $name ($pattern) — the decision core is pure; inject it" >&2
				status=1
			fi
		done
	done
done

if [ "$status" -eq 0 ]; then
	echo "check-ramp-purity: OK"
fi
exit "$status"
