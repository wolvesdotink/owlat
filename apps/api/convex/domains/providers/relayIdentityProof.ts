/**
 * THE RELAY PROOF RULE, STATED ONCE — the read that licenses handing a
 * customer's From domain to a third party.
 *
 * Every kind that keeps rows in the generic `sendingDomainRelayIdentities`
 * table answers "may we relay this domain right now?" the same way, and it must
 * stay that way: two kinds writing one table and being read back under two
 * definitions of "proven" is how one relay ends up handed a From domain another
 * would refuse, with both suites green. Mandrill and the bundled plugin tier
 * both call this; what each keeps of its own is the BOUND (see below), not the
 * rule.
 *
 * WHY THE BOUND IS STILL PER KIND. It is a statement about how expensive the
 * evidence is to renew, not about what counts as evidence: SES's proof is
 * assembled from our own DNS crawl and carries 30 days, Mandrill's is one HTTP
 * call a daily sweep refreshes and carries 7. Passing it in keeps that judgement
 * where the adapter's other cadences are while the five conditions stay here.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';

/**
 * The identity row for one (domain, kind), or null.
 *
 * ONE indexed point read on `by_domain_provider`. Not org-leading, and that is a
 * property of the index rather than of this call — see the rationale on the
 * index itself in `schema/relayIdentities.ts`: the enqueue transaction has no
 * session, and resolving the deployment's singleton org would cost the
 * `ctx.runQuery` that path bans.
 */
export async function loadRelayIdentityForDomain(
	ctx: QueryCtx | MutationCtx,
	kind: string,
	domainName: string
): Promise<Doc<'sendingDomainRelayIdentities'> | null> {
	return await ctx.db
		.query('sendingDomainRelayIdentities')
		.withIndex('by_domain_provider', (q) =>
			q.eq('domain', domainName.toLowerCase()).eq('providerKind', kind)
		)
		.first();
}

/**
 * True iff this row is a fresh, complete proof: an identity the provider itself
 * reported verified, with BOTH published records valid, observed no longer ago
 * than `maxAgeMs`.
 *
 * `status === 'verified'` already implies the two record verdicts (every writer
 * derives the status from them), and they are re-asserted anyway: the status is
 * a DERIVED column and this is the read that licenses a third-party relay. A row
 * patched by a future writer that forgot one of them should fail closed rather
 * than relay.
 *
 * Age is measured from `lastCheckedAt`, which every writer advances ONLY on a
 * call that produced a verdict — a provider outage cannot extend the life of a
 * proof by being unable to re-confirm it. A NEGATIVE age (a row dated in the
 * future, which only a clock problem or a hand edit produces) is refused for the
 * same reason: it would otherwise be permanently fresh.
 */
export function isFreshRelayProof(
	identity: Doc<'sendingDomainRelayIdentities'>,
	now: number,
	maxAgeMs: number
): boolean {
	const age = now - identity.lastCheckedAt;
	return (
		identity.status === 'verified' &&
		identity.spf?.isValid === true &&
		identity.dkim?.isValid === true &&
		age >= 0 &&
		age <= maxAgeMs
	);
}
