/**
 * The Mandrill sending-domain identity, as the operator screens read it.
 *
 * The READ sibling of `mandrillRelayQueries`' two write files: `mandrillRelay.ts`
 * (the network calls, `'use node'`) and `mandrillRelayMutations.ts` (the
 * transactional writes). Its own file for the same runtime reason, and because
 * everything here is a PROJECTION — it answers the domain screen's question
 * ("what do I publish, and what is Mandrill waiting on?") without exposing the
 * row shape the writers own.
 *
 * Two things it deliberately does rather than the browser:
 *
 *  - It DERIVES the DNS. Mandrill signs every account with one shared selector,
 *    so the records are a pure function of the domain name
 *    (`providers/mandrill/records.ts`) rather than something the row remembers.
 *    The web app cannot import that module — it lives inside the Convex
 *    backend — and re-spelling the SPF include and the DKIM key in a Vue file
 *    is exactly how a screen ends up telling an operator to publish records we
 *    never asked Mandrill about. Same helper, one place, same records.
 *  - It reads the versioned `providerDetails` blob through
 *    `parseMandrillProviderDetails`, so a row written by a future version is
 *    reported as "nothing known" instead of being reinterpreted under today's
 *    shape.
 *
 * FRESHNESS IS RETURNED AS FACTS, NOT AS A VERDICT: `lastCheckedAt`,
 * `nextCheckDueAt` and the bound itself. Routing already decides usability from
 * the same three numbers (`providers/mandrill/relayVerification.ts`); handing
 * the screen the numbers lets it say "verified, re-checking" without a second
 * copy of the rule drifting from the first.
 */

import { MANDRILL_RELAY_PROOF_MAX_AGE_MS } from '@owlat/shared';
import { authedQuery } from '../lib/authedFunctions';
import { getSingletonOrganizationId, requireOrgPermission } from '../lib/sessionOrganization';
import { parseMandrillProviderDetails } from './providers/mandrill/identity';
import { buildMandrillDnsRecords, buildMandrillVerifyRecord } from './providers/mandrill/records';

/**
 * Hard cap on the identity view. A deployment's sending domains are a handful,
 * not a growth table, but the read is still bounded rather than collected — the
 * table is shared by every future relay kind and has no reason to stay small.
 */
const MANDRILL_IDENTITY_VIEW_LIMIT = 200;

/**
 * Every Mandrill sending-domain identity this organization holds, with the DNS
 * to publish for each.
 *
 * Admin-gated (`organization:manage`), matching
 * `providerRoutes.listRelayDomainIdentities`: which third party a domain is
 * registered with, and why it has not verified, is operational configuration,
 * not a member-level read.
 */
export const listIdentities = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requireOrgPermission(ctx, 'organization:manage');
		const organizationId = await getSingletonOrganizationId(ctx);
		const rows = await ctx.db
			.query('sendingDomainRelayIdentities')
			.withIndex('by_org_provider_status', (q) =>
				q.eq('organizationId', organizationId).eq('providerKind', 'mandrill')
			)
			.take(MANDRILL_IDENTITY_VIEW_LIMIT);

		return rows.map((row) => {
			const details = parseMandrillProviderDetails(row.providerDetails, row.providerDetailsVersion);
			const records = buildMandrillDnsRecords(row.domain);
			return {
				domain: row.domain,
				status: row.status,
				// Mandrill's own verdicts, error text included and VERBATIM: it is the
				// authority on whether the published record is the one it wants, and
				// paraphrasing "no TXT record found at mandrill._domainkey" into a
				// house sentence loses the only actionable part.
				spf: row.spf ?? null,
				dkim: row.dkim ?? null,
				isValidSigning: details?.isValidSigning ?? false,
				/** Ownership. Absent ⇒ Mandrill still rejects this domain as `unsigned`. */
				verifiedAt: details?.verifiedAt ?? null,
				lastError: details?.lastError ?? null,
				lastCheckedAt: row.lastCheckedAt,
				nextCheckDueAt: row.nextCheckDueAt ?? null,
				proofMaxAgeMs: MANDRILL_RELAY_PROOF_MAX_AGE_MS,
				records: {
					spf: records.spf ?? null,
					dkim: records.dkim ?? [],
					/**
					 * The ownership TXT, only when Mandrill handed this account a key.
					 * An account without one verifies by mailbox in Mandrill's own
					 * dashboard, and inventing a token would send the operator to
					 * publish a record that can never clear.
					 */
					ownership:
						details?.verifyTxtKey !== undefined
							? buildMandrillVerifyRecord(details.verifyTxtKey)
							: null,
				},
			};
		});
	},
});
