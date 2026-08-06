/**
 * Mandrill's answers to the two questions asked ABOUT an identity rather than
 * of Mandrill: "may we hand this From domain to the relay right now?" (the
 * enqueue-path proof, Mandrill plan D6) and "describe this domain's second
 * arm" (the dual-transport alignment pre-flight, Mandrill plan P3.1). Plan
 * numbers in this folder are the Mandrill plan's — qualified in `../index.ts`.
 *
 * Both read the same row and both are pure reads, which is why they live
 * together and away from `./index.ts`: everything there is an HTTP call made
 * from an action, while these two run inside a transaction — the first one
 * inside an ENQUEUE transaction, under the read-set discipline pinned by
 * `delivery/__tests__/sendAssignments.test.ts`: indexed point reads only — no
 * table scan, no by-id document read, no nested query call.
 *
 * Same split, and the same reasoning, as `../ses/relayVerification.ts`.
 */

import { MANDRILL_RELAY_PROOF_MAX_AGE_MS } from '@owlat/shared';
import { MANDRILL_DKIM_SELECTOR, MANDRILL_SPF_MECHANISM } from './records';
import type { ReferenceAlignmentArm } from '@owlat/shared/deliverabilityAlignment';
import type { Doc } from '../../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../../_generated/server';

/**
 * The identity row for one (domain, Mandrill), or null.
 *
 * ONE indexed point read on `by_domain_provider`. Not org-leading, and that is
 * a property of the index rather than of this call — see the rationale on the
 * index itself in `schema/relayIdentities.ts`: the enqueue transaction has no
 * session, and resolving the deployment's singleton org would cost the
 * `ctx.runQuery` this path bans.
 */
async function loadMandrillIdentity(
	ctx: QueryCtx | MutationCtx,
	domainName: string
): Promise<Doc<'sendingDomainRelayIdentities'> | null> {
	return await ctx.db
		.query('sendingDomainRelayIdentities')
		.withIndex('by_domain_provider', (q) =>
			q.eq('domain', domainName.toLowerCase()).eq('providerKind', 'mandrill')
		)
		.first();
}

/**
 * True iff `domainName` carries a fresh, complete Mandrill proof: an identity
 * Mandrill itself reports as verified, with BOTH published records valid, read
 * no longer ago than {@link MANDRILL_RELAY_PROOF_MAX_AGE_MS}.
 *
 * `status === 'verified'` already implies the two record verdicts (see
 * `identity.ts`), and they are re-asserted here anyway: the status is a DERIVED
 * column and this is the read that licenses handing a customer's From domain to
 * a third party. A row patched by a future writer that forgot one of them
 * should fail closed, not relay.
 *
 * The freshness bound is deliberately measured from `lastCheckedAt`, which the
 * writer advances ONLY on a call that produced a verdict — a Mandrill outage
 * cannot extend the life of a proof by being unable to re-confirm it.
 */
export async function mandrillRelayDomainVerified(
	ctx: QueryCtx | MutationCtx,
	domainName: string,
	now: number
): Promise<boolean> {
	const identity = await loadMandrillIdentity(ctx, domainName);
	if (!identity) return false;
	const age = now - identity.lastCheckedAt;
	return (
		identity.status === 'verified' &&
		identity.spf?.isValid === true &&
		identity.dkim?.isValid === true &&
		age >= 0 &&
		age <= MANDRILL_RELAY_PROOF_MAX_AGE_MS
	);
}

/**
 * The Mandrill reference arm for one sending domain, or null when we cannot
 * honestly describe one.
 *
 * VERIFIED-ONLY, and that is the difference from SES's arm (which is built from
 * the mere existence of an identity row). It costs nothing to be strict here:
 * Mandrill's selector and SPF include are constants, so an arm built for an
 * unverified domain would describe DNS that is not published — the pre-flight
 * would resolve it live, find nothing, and report a DKIM/SPF misalignment as if
 * the operator had published the records wrong. `null` instead reaches the
 * pre-flight as `unknown`, which HOLDS the ramp and says "verify the domain at
 * the relay" — the actionable sentence.
 *
 * Freshness is the proof's, not the arm's: this reuses
 * {@link mandrillRelayDomainVerified} rather than restating the rule, so the
 * arm the ramp is measured on and the domain the router is allowed to relay can
 * never be two different sets.
 */
export async function mandrillReferenceArm(
	ctx: QueryCtx | MutationCtx,
	domain: Doc<'domains'>,
	now: number
): Promise<ReferenceAlignmentArm | null> {
	const isVerified = await mandrillRelayDomainVerified(ctx, domain.domain, now);
	if (!isVerified) return null;
	return {
		label: 'Mandrill relay',
		fromDomain: domain.domain,
		// Mandrill signs with the customer's own domain as `d=` — which is what
		// makes it comparable to the own MTA at all (same From domain, same d=,
		// different selector: the alignment contract, D11).
		dkimDomain: domain.domain,
		dkimSelectors: [MANDRILL_DKIM_SELECTOR],
		spfMechanisms: [MANDRILL_SPF_MECHANISM],
		// Mandrill mints its own `bounce-md_*` return path and offers only a
		// return-path DOMAIN, so our signed VERP local part cannot survive (D5 —
		// the same fact that makes the send adapter decline the probe).
		supportsCustomReturnPath: false,
	};
}
