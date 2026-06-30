#!/usr/bin/env bash
# Gates `authedIdentityMutation` behind a small allowlist.
#
# `authedIdentityMutation` only asserts "an authenticated identity exists" — NOT
# organization membership. It exists solely for the narrow pre-org signup
# bootstrap (creating the user's own profile before they're a member). Used
# anywhere else it is a privilege-escalation footgun: a logged-in non-member
# (e.g. a self-registered account) could reach a write that should require
# membership. The permissions lint (check-permissions.sh) does NOT catch this,
# so this guard makes any NEW call site fail CI until a human confirms it truly
# needs the looser floor (and isn't a mistaken `authedMutation`).
#
# To add a legitimate new use, append its file to ALLOWLIST below.

cd "$(dirname "$0")/.."

# Files permitted to call authedIdentityMutation (signup-bootstrap path only).
ALLOWLIST=(
	"convex/auth/userProfiles.ts"
)

# Call sites: `= authedIdentityMutation({` / `authedIdentityMutation(`. The
# wrapper *definition* in lib/authedFunctions.ts is `authedIdentityMutation = ((`
# (name followed by ` = `, not `(`) so it never matches; exclude it anyway.
PATTERN='authedIdentityMutation[[:space:]]*\('

violations=$(grep -rnE "$PATTERN" convex --include="*.ts" 2>/dev/null \
	| grep -v "/_generated/" \
	| grep -v "/__tests__/" \
	| grep -v "convex/lib/authedFunctions.ts" || true)

# Drop the allowlisted call sites.
for f in "${ALLOWLIST[@]}"; do
	violations=$(printf '%s\n' "$violations" | grep -v "$f" || true)
done

violations=$(printf '%s' "$violations" | grep . || true)
count=$(printf '%s' "$violations" | grep -c . | tr -d ' ')

if [ "$count" -gt 0 ]; then
	echo "FAIL: $count authedIdentityMutation use(s) outside the allowlist."
	echo ""
	echo "$violations"
	echo ""
	echo "authedIdentityMutation skips the org-membership floor (signup bootstrap only)."
	echo "Use authedMutation for member writes. If this use is genuinely pre-org, add"
	echo "its file to ALLOWLIST in scripts/check-identity-mutations.sh."
	exit 1
fi

echo "ok:   no authedIdentityMutation outside the signup-bootstrap allowlist"
