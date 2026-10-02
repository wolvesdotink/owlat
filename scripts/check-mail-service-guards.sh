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
#
# apps/code-worker cannot import `@owlat/shared` (its image compiles a filtered
# workspace install), so it gets one rule of its own:
#
#  3. Numeric environment variables go through the worker's local `readIntEnv`
#     in apps/code-worker/src/env.ts. `Number(process.env.X ?? d)` turned `10s`
#     into NaN and accepted `0`, and a timer with either delay fires after 1 ms.

set -uo pipefail
cd "$(dirname "$0")/.."

mail_roots=(apps/mta/src apps/imap/src apps/mail-sync/src apps/updater/src)
failed=0

# forbid <message> <perl regex> <root>...: report every match as file:line.
forbid() {
	local message="$1" pattern="$2" hits
	shift 2
	local roots=("$@")
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
	'parseInt\(\s*(?:process\.env|optionalEnv\()' "${mail_roots[@]}"

forbid "handle SIGTERM/SIGINT with installShutdown from @owlat/shared/nodeShutdown, not process.on:" \
	'process\.on\(\s*[\x27"]SIG(?:TERM|INT)[\x27"]' "${mail_roots[@]}"

forbid "parse numeric env vars in the code worker with readIntEnv from apps/code-worker/src/env.ts:" \
	'(?:Number|parseInt|parseFloat)\(\s*process\.env' apps/code-worker/src

if [ "$failed" -ne 0 ]; then
	exit 1
fi
echo "ok:   node service source guards pass"
