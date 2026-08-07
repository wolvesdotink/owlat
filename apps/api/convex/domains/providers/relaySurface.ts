/**
 * From a PRIMARY sending-domain adapter to its relay surface — the structural
 * test that decides core membership of the relay-identity registry, and the
 * refusal that keeps that test from silently narrowing.
 *
 * Its own file so the rule is unit-testable against a fixture adapter: composing
 * it inside `./index.ts` would only be reachable through the module-scope
 * registry, where the failing case cannot be constructed at all.
 */

import type {
	RelayIdentityProviderModule,
	SendingDomainProviderKind,
	SendingDomainProviderModule,
} from './types';

/**
 * This adapter's relay surface, or `null` when it has none.
 *
 * MEMBERSHIP IS STRUCTURAL, not a second list: an adapter joins the relay
 * registry iff it implements all three relay seams, which is exactly what the
 * three callers used to check for themselves
 * (`provider.relayDomainVerified ? … : false`). Our own MTA implements none of
 * them and is correctly absent.
 *
 * A PARTIAL IMPLEMENTATION THROWS rather than being dropped quietly, and that is
 * the whole reason this is a function. `RelayProvingProviderModule` only
 * compile-enforces the three for kinds whose catalog entry says
 * `domainVerification: 'api'`; a kind declaring `'none'` that nevertheless
 * implemented `ensureRelayIdentity` alone would compile clean, pass
 * `_relayProofTypecheck`, and then never be backfilled — surfacing only as a
 * relay refusing From domains once the deliverability fallback opened, which is
 * the exact failure the mapped-type guards exist to prevent. The three are one
 * promise: a proof nothing provisions is always false, a backfill nothing reads
 * is dead work, and an arm without a proof describes DNS the router may not use.
 *
 * The methods are BOUND to the adapter they came off, so a future implementation
 * that reads `this` keeps working rather than failing one frame into an enqueue
 * read.
 */
export function toRelayIdentityProvider(
	kind: SendingDomainProviderKind,
	provider: SendingDomainProviderModule<SendingDomainProviderKind>
): RelayIdentityProviderModule | null {
	const { relayDomainVerified, describeReferenceArm, ensureRelayIdentity } = provider;
	const implemented = [relayDomainVerified, describeReferenceArm, ensureRelayIdentity].filter(
		(seam) => seam !== undefined
	).length;
	if (implemented === 0) return null;
	if (!relayDomainVerified || !describeReferenceArm || !ensureRelayIdentity) {
		throw new Error(
			`Sending-domain provider '${kind}' implements ${implemented} of the three relay ` +
				'seams (relayDomainVerified, describeReferenceArm, ensureRelayIdentity). They are ' +
				'all-or-nothing: a partial relay would register, compile, and never be backfilled.'
		);
	}
	// The sweep arm is genuinely optional — it says "this kind keeps rows in the
	// shared sendingDomainRelayIdentities table", which SES proves domains without
	// doing. Absent stays absent, so the sweep skips the kind rather than
	// scheduling into nothing.
	const scheduleRelayIdentityRefresh = provider.scheduleRelayIdentityRefresh;
	return Object.freeze({
		kind,
		relayDomainVerified: relayDomainVerified.bind(provider),
		describeReferenceArm: describeReferenceArm.bind(provider),
		ensureRelayIdentity: ensureRelayIdentity.bind(provider),
		...(scheduleRelayIdentityRefresh
			? { scheduleRelayIdentityRefresh: scheduleRelayIdentityRefresh.bind(provider) }
			: {}),
	});
}
