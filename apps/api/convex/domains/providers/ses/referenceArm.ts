/**
 * SES's REFERENCE ARM — the second arm the dual-transport alignment pre-flight
 * compares the own MTA against.
 *
 * Lifted verbatim out of `delivery/alignmentPreflight.ts`, which used to build
 * this arm inline behind `relayKinds[0] === 'ses' && sesIdentity !== null`. That
 * test made "describable second arm" mean "is SES", so a deployment relaying
 * through anything else could never resolve an arm however well verified it was.
 * The pre-flight now asks the sending-domain provider registry (Mandrill plan
 * P3.1) and this
 * module is SES's registered answer; the LOGIC below is unchanged, so SES's
 * verdicts are byte-identical to the ones it produced before the move.
 *
 * Its own file for the same reason `./relayVerification.ts` is: everything in
 * `./index.ts` is an SES API call made from a `'use node'` action, while this is
 * an indexed read made from inside a query.
 */

import type { ReferenceAlignmentArm } from '@owlat/shared/deliverabilityAlignment';
import { parseSpfMechanisms } from '@owlat/shared/spf';
import type { Doc } from '../../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../../_generated/server';

/** SES's SPF include, used when the relay identity carries no generated record. */
const SES_DEFAULT_SPF_MECHANISM = 'include:amazonses.com';

/** Relay SPF mechanisms from the identity's generated record, else SES's default. */
function relaySpfMechanisms(record: string | undefined): string[] {
	const mechanisms = parseSpfMechanisms(record ?? '');
	return mechanisms.length > 0 ? mechanisms : [SES_DEFAULT_SPF_MECHANISM];
}

/**
 * The SES arm for one sending domain, or null when this domain has no SES
 * identity at all (which the pre-flight reports as `unknown` — a HOLD).
 *
 * Deliberately NOT gated on the identity being verified: unchanged behaviour
 * from before the registry move, and the pre-flight is itself the check — it
 * resolves the arm's selectors against LIVE DNS, so an identity whose records
 * are not published yet is reported as a concrete, actionable misalignment
 * rather than as an undescribable relay.
 */
export async function sesReferenceArm(
	ctx: QueryCtx | MutationCtx,
	domain: Doc<'domains'>
): Promise<ReferenceAlignmentArm | null> {
	const identity = await ctx.db
		.query('sendingDomainSesIdentities')
		.withIndex('by_domain', (q) => q.eq('domainId', domain._id))
		.unique();
	if (identity === null) return null;
	return {
		label: 'SES relay',
		fromDomain: domain.domain,
		dkimDomain: domain.domain,
		dkimSelectors: identity.dkimTokens,
		spfMechanisms: relaySpfMechanisms(identity.dnsRecords?.spf?.value),
		// A verified custom MAIL FROM is what lets the relay carry our own return
		// path; without it bounce attribution on that arm is coarser (P2-3).
		supportsCustomReturnPath: (identity.dnsRecords?.mailFrom?.length ?? 0) > 0,
	};
}
