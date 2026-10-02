#!/usr/bin/env bash
# Feature-flag floors belong in the builder, not in each handler
# (CONVENTIONS.md → "Feature-flag floors"). A gated family exports builders
# composed with `featureGated` (e.g. `externalMailMutation` in
# convex/mail/external/externalFeature.ts), so a handler that repeats
# `await assertFeatureEnabled(ctx, '<flag>')` by hand is a floor someone has to
# remember — and the next handler in the file forgets it.
#
# The generator prints `path:exportName` for
#   (a) every `assertFeatureEnabled(ctx, '<flag>')` inside a file that belongs
#       to that flag's gated family (FAMILIES below: mail.external, and the
#       transactional, campaigns, automations, forms and knowledge folders), and
#   (b) every `export const X = authedQuery(` / `= authedMutation(` under
#       convex/mail/ — Postbox handlers use `postboxQuery`/`postboxMutation`
#       (mail/_helpers.ts), the external-mailbox family the `externalMail*`
#       builders, so a bare org-member builder there has skipped its floor.
#
# RATCHET on scripts/ratchet.sh, strict in both directions. The baseline
# (scripts/feature-floor-baseline.txt) is NOT debt to pay down: it lists the
# justified sites only — soft-auth `publicQuery` reads that must keep an inline
# assert (a gated publicQuery would slip past check-public-functions and its
# `// public:` rule; each carries a `// flag-inline:` comment), and the mail/
# modules `mail/_helpers.ts` exempts because they serve another surface. A new
# entry means a new handler skipped the gated builder: use the builder. A
# stale entry means a justified site went away: delete its line.

set -uo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."

# One `<flag> <path prefix>` pair per gated family. Add a pair when a folder
# gains its gated builders; a file under the prefix may then no longer assert
# that flag inline.
FAMILIES='
mail.external convex/mail/
transactional convex/transactional/
campaigns convex/campaigns/
automations convex/automations/
forms convex/forms/
ai.knowledge convex/knowledge/
'

generate() {
	{
		# (a) inline asserts of a family's own flag inside that family.
		printf '%s\n' "$FAMILIES" | while read -r flag prefix; do
			[ -n "$flag" ] || continue
			[ -d "$prefix" ] || continue
			find "$prefix" -name "*.ts" \
				-not -path "*/_generated/*" \
				-not -path "*/__tests__/*" \
				! -name "*.test.ts" \
				-exec awk -v flag="$flag" '
					BEGIN {
						gsub(/\./, "\\.", flag)
						pattern = "assertFeatureEnabled\\(ctx, *(\x27|\")" flag "(\x27|\")\\)"
						name = "<module>"
					}
					FNR == 1 { name = "<module>" }
					/^export const [A-Za-z0-9_]+ = / { name = $3 }
					/^(export )?(async )?function [A-Za-z0-9_]+/ {
						line = $0
						sub(/^(export )?(async )?function /, "", line)
						sub(/[^A-Za-z0-9_].*$/, "", line)
						name = line
					}
					$0 ~ pattern && $0 !~ /^[[:space:]]*(\/\/|\*)/ { print FILENAME ":" name }
				' {} +
		done

		# (b) bare org-member builders under convex/mail/.
		[ -d convex/mail ] || return 0
		find convex/mail -name "*.ts" \
			-not -path "*/_generated/*" \
			-not -path "*/__tests__/*" \
			! -name "*.test.ts" \
			-exec awk '
				/^export const [A-Za-z0-9_]+ = (authedQuery|authedMutation)\(/ { print FILENAME ":" $3 }
			' {} +
	} | LC_ALL=C sort -u
}

if [ "${1:-}" = "--generate" ]; then
	generate
	exit $?
fi

exec "$repo_root/scripts/ratchet.sh" \
	--baseline scripts/feature-floor-baseline.txt \
	--seed "bash apps/api/scripts/check-feature-floors.sh --write-baseline" \
	--ok "no handler hand-rolls a feature floor its family's builder owns" \
	--new-header "FAIL: {n} handler(s) hand-roll a feature floor instead of using the gated builder:" \
	--new-advice "Use the family's featureGated builder instead of an inline assert or a
bare authedQuery/authedMutation (CONVENTIONS.md → Feature-flag floors):
  mail/**                        postboxQuery / postboxMutation (mail/_helpers.ts)
  mail.external family           externalMailQuery / externalMailMutation /
                                 externalMailAdminMutation (mail/external/externalFeature.ts)
  transactional/**               transactionalQuery / transactionalMutation (transactional/_helpers.ts)
  campaigns/**                   campaignsQuery / campaignsMutation (campaigns/_helpers.ts);
                                 actions call assertCampaignsEnabledInAction
  automations/**                 automationsQuery / automationsMutation (automations/_helpers.ts)
  forms/**                       formsQuery / formsMutation (forms/_helpers.ts)
Only a soft-auth publicQuery (marked '// flag-inline:') or a module that
serves another surface (see mail/_helpers.ts) may be listed in {baseline},
with its reason." \
	--stale-header "FAIL: {n} stale entr(y/ies) in {baseline} (handler converted, renamed or removed):" \
	"$@" \
	-- bash "$self" --generate
