#!/usr/bin/env bash
#
# Mail-service source guards for apps/mta, apps/imap and apps/mail-sync.
#
# Each rule bans a pattern the shared helpers replaced, so a copy cannot creep
# back in. Hard-0 invariants with no baseline. Tests (__tests__) are exempt.
#
#  1. Numeric environment variables go through `readIntEnv` from
#     `@owlat/shared/nodeEnv`. `parseInt(process.env.X ?? 'd', 10)` reads ''
#     as NaN (which turns a connection cap off) and '1e3' as 1, with no boot
#     error. Matched across line breaks, because the formatter wraps long calls.

set -uo pipefail
cd "$(dirname "$0")/.."

roots=(apps/mta/src apps/imap/src apps/mail-sync/src)
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

if [ "$failed" -ne 0 ]; then
	exit 1
fi
echo "ok:   mail-service source guards pass"
