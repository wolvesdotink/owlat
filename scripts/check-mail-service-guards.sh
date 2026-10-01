#!/usr/bin/env bash
#
# Source guards for the long-running Node services that share the
# `@owlat/shared` node helpers: apps/mta, apps/imap, apps/mail-sync and
# apps/updater.
#
# Each rule bans a pattern the shared helpers replaced, so a copy cannot creep
# back in. Hard-0 invariants with no baseline. Tests (__tests__) are exempt.
#
#  1. Numeric environment variables go through `readIntEnv` from
#     `@owlat/shared/nodeEnv`. `parseInt(process.env.X ?? 'd', 10)` reads ''
#     as NaN (which turns a connection cap off) and '1e3' as 1, with no boot
#     error. Matched across line breaks, because the formatter wraps long calls.
#  2. SIGTERM and SIGINT go through `installShutdown` from
#     `@owlat/shared/nodeShutdown`, which ignores a duplicate signal, stops the
#     listener before draining, and holds a watchdog that is not unref'd. Each
#     hand-rolled copy got at least one of those wrong.

set -uo pipefail
cd "$(dirname "$0")/.."

roots=(apps/mta/src apps/imap/src apps/mail-sync/src apps/updater/src)
failed=0

# forbid <message> <perl regex>: report every match as file:line.
forbid() {
	local message="$1" pattern="$2" hits
	hits="$(
		find "${roots[@]}" -type f -name '*.ts' -not -path '*/__tests__/*' -print0 |
			xargs -0 perl -0777 -ne '
				while (/'"$pattern"'/g) {
					my $line = 1 + (substr($_, 0, $-[0]) =~ tr/\n//);
					print "  $ARGV:$line\n";
				}
			'
	)"
	if [ -n "$hits" ]; then
		echo "FAIL: $message" >&2
		echo "$hits" >&2
		failed=1
	fi
}

forbid "parse numeric env vars with readIntEnv from @owlat/shared/nodeEnv, not parseInt:" \
	'parseInt\(\s*(?:process\.env|optionalEnv\()'

forbid "handle SIGTERM/SIGINT with installShutdown from @owlat/shared/nodeShutdown, not process.on:" \
	'process\.on\(\s*[\x27"]SIG(?:TERM|INT)[\x27"]'

if [ "$failed" -ne 0 ]; then
	exit 1
fi
echo "ok:   node service source guards pass"
