/**
 * SES's answer for the operator surface — the frozen sibling read, INSIDE the
 * adapter at last.
 *
 * WHAT MOVED HERE AND WHY. `providerRoutes.listDeliverabilityRelayDomains` used
 * to point-read `sendingDomainSesIdentities` itself and shape its whole result
 * row around SES's bundle (dkim tokens, MAIL FROM, `spfProofState`), which made
 * one vendor's storage the shape of a surface every relay has to appear on: a
 * Mandrill row could not be reported through it, and a bundled plugin relay's
 * rows had nowhere to go at all. The read is unchanged; what changed is that it
 * now answers in the shared shape ({@link RelayDomainIdentityFacts}) behind
 * `describeRelayIdentity`, so the query asks the registry rather than a table.
 *
 * SES IS THE ONE KIND THAT MUST IMPLEMENT THIS. Every kind after it keeps its
 * rows in the generic `sendingDomainRelayIdentities` table, which the default
 * read in `../relayIdentityView.ts` covers; SES's live in the frozen sibling,
 * so without this arm SES would be the kind that vanished from its own panel.
 *
 * Its own file rather than a method body in `./index.ts` for the same reason
 * `./relayVerification.ts` is: everything else in that adapter is a provider API
 * call from a `'use node'` action, and this is indexed reads plus pure
 * derivation inside a query.
 */

import { SES_RELAY_PROOF_MAX_AGE_MS } from '@owlat/shared';
import type { Doc } from '../../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../../_generated/server';
import type { DnsRecord } from '../../domains';
import type { RelayDnsRecordView, RelayDomainIdentityFacts } from '../relayIdentityView';

/**
 * SES's remembered DNS bundle, flattened into the surface's labelled list.
 *
 * The three sets are what SES's registration published and are kept in the order
 * an operator works them (apex SPF, the per-domain DKIM CNAMEs, then the
 * dedicated MAIL FROM pair). `mailFrom` carries an MX, which is the reason the
 * flat record view has a `priority` at all.
 */
function sesRecordViews(records: {
	spf?: DnsRecord;
	dkim?: DnsRecord[];
	mailFrom?: DnsRecord[];
}): RelayDnsRecordView[] {
	// `host ?? hostname`: the record validator carries both spellings and rows
	// written by different generations use different ones — the shipped panel
	// read them the same way, and normalizing here is what lets the surface stop
	// knowing that.
	const labelled = (label: string, record: DnsRecord): RelayDnsRecordView => ({
		label,
		...(record.type !== undefined ? { type: record.type } : {}),
		...((record.host ?? record.hostname) ? { host: record.host ?? record.hostname } : {}),
		value: record.value,
		...(record.priority !== undefined ? { priority: record.priority } : {}),
	});
	return [
		...(records.spf ? [labelled('SPF', records.spf)] : []),
		...(records.dkim ?? []).map((record) => labelled('DKIM', record)),
		...(records.mailFrom ?? []).map((record) => labelled('MAIL FROM', record)),
	];
}

/**
 * What SES can say about `domain` right now, or null when no identity has been
 * registered for it yet.
 *
 * THE PROOF'S AGE IS DATED FROM `verifiedAt`, not from a check timestamp: SES's
 * evidence is our own DNS crawl plus Amazon's verification verdict, and
 * `verifiedAt` is the moment both last agreed. Reported alongside
 * {@link SES_RELAY_PROOF_MAX_AGE_MS} — the SAME bound `./relayVerification.ts`
 * refuses to relay past — so the surface can say "verified, re-checking" under
 * routing's rule instead of a second copy of it.
 *
 * NO OWNERSHIP FIELD, deliberately. SES verifies a domain FROM the records it
 * asks for; there is no console ceremony beyond them, so reporting
 * `isOwnershipVerified: false` for an identity that is merely waiting on DNS
 * would invent an outstanding step an operator cannot go and do.
 */
export async function sesRelayIdentityFacts(
	ctx: QueryCtx | MutationCtx,
	domain: Doc<'domains'>
): Promise<RelayDomainIdentityFacts | null> {
	const identity = await ctx.db
		.query('sendingDomainSesIdentities')
		.withIndex('by_domain', (q) => q.eq('domainId', domain._id))
		.first();
	if (!identity) return null;
	return {
		status: identity.verifiedAt ? 'verified' : 'pending',
		records: identity.dnsRecords ? sesRecordViews(identity.dnsRecords) : [],
		...(identity.verifiedAt !== undefined
			? { lastCheckedAt: identity.verifiedAt, proofMaxAgeMs: SES_RELAY_PROOF_MAX_AGE_MS }
			: {}),
		// The explicit relay-SPF contract, or the shape the row's own records
		// imply for the identities written before the column existed — the same
		// fallback `./relayVerification.ts` applies, so the screen and the routing
		// gate cannot disagree about whether an apex row is owed.
		spfProof:
			identity.spfProofState ??
			(identity.dnsRecords?.spf ? 'dns_required' : 'not_applicable_manual_primary'),
	};
}
