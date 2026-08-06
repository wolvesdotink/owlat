/**
 * WHICH relays the deliverability fallback is currently configured to use —
 * read from the stored routes, in one place.
 *
 * A sibling question to `delivery/relayConfiguration.ts`'s
 * {@link configuredRelayKinds}, and deliberately not a section of it: that
 * module answers "which transports are the SECOND ARM" (every enabled non-MTA
 * entry plus the single-transport env), which is the alignment/ramp reading.
 * This one answers "which relay would an OPEN BREAKER hand traffic to", i.e.
 * `deliverabilityFallback.relayProviderType` on the routes that have the
 * fallback switched on — a strictly narrower set, and the only one the
 * relay-identity provisioning paths care about.
 *
 * Two callers, both provisioning relay identities on our own MTA's domains:
 * the forward path (`domains/lifecycle.ts`, on a domain reaching `verified`)
 * and the catch-up drain (`providerRoutes.provisionDeliverabilityRelayBatch`,
 * when an operator switches the fallback on). They used to each open the same
 * `providerRoutes` scan inline; two readings of one configuration is how the
 * two halves of "every domain gets an identity exactly once" start disagreeing
 * about which relay that identity is FOR.
 *
 * The WHOLE rule lives here, not just its first clause: {@link
 * relayIdentityBackfills} and {@link ensureRelayIdentities} below own the
 * registry filter, the own-MTA-primary gate and the per-kind call, so the two
 * callers differ only in which domains they hand over (one, on its transition;
 * a page of them, on a drain). A rule spelled twice is a rule that drifts, and
 * this particular drift has one symptom — a domain the forward path skipped and
 * the drain never reaches, refused by the relay on a real send.
 */

import { logError } from '../runtimeLog';
import {
	OWN_SENDING_DOMAIN_PROVIDER_KIND,
	isSendingDomainProviderKind,
	providerFor,
} from '../../domains/providers';
import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';

/**
 * Upper bound on the route rows scanned. `providerRoutes` holds one row per
 * message type (campaign, transactional, automation), so three is the real
 * ceiling; the spare row means a malformed duplicate still cannot turn a
 * verified-domain transition into an unbounded scan.
 */
const PROVIDER_ROUTE_SCAN_LIMIT = 4;

/**
 * Every relay kind named by an ENABLED deliverability fallback, deduplicated.
 *
 * Returns raw strings, not a narrowed union: a route persisted before a kind
 * was retired (or written by a newer deployment) can name anything, and the
 * caller's own registry guard is what decides whether the kind is dispatchable.
 * Empty means no route has the fallback switched on — nothing to provision.
 */
export async function enabledFallbackRelayKinds(
	ctx: QueryCtx | MutationCtx
): Promise<readonly string[]> {
	const routes = await ctx.db.query('providerRoutes').take(PROVIDER_ROUTE_SCAN_LIMIT);
	const kinds = new Set<string>();
	for (const route of routes) {
		const fallback = route.deliverabilityFallback;
		if (fallback?.isEnabled && typeof fallback.relayProviderType === 'string') {
			kinds.add(fallback.relayProviderType);
		}
	}
	return [...kinds];
}

/**
 * One relay's `ensureRelayIdentity`, already bound to its module.
 *
 * The functions travel, not the kinds: resolving the registry once per BATCH
 * rather than once per domain is what lets the drain decide, before it reads a
 * page, that there is nothing to provision at all.
 */
export type RelayIdentityBackfill = (ctx: MutationCtx, domain: Doc<'domains'>) => Promise<void>;

/**
 * The registered backfills for `relayKinds` — the "ask the kind, don't name it"
 * half of the pair.
 *
 * A kind with no registered sending-domain provider (a plugin transport, a
 * retired kind a stored route still names) and a kind whose provider has no
 * identity API to register at (`domainVerification: 'none'` — our own MTA,
 * Resend, a bring-your-own SMTP relay) both drop out here, which is the same
 * "nothing to backfill" the hand-written if-chain achieved by not listing them.
 */
export function relayIdentityBackfills(
	relayKinds: readonly string[]
): readonly RelayIdentityBackfill[] {
	return relayKinds
		.filter((kind) => isSendingDomainProviderKind(kind))
		.map((kind) => providerFor(kind))
		.map((provider) => provider.ensureRelayIdentity?.bind(provider))
		.filter((ensureRelayIdentity) => ensureRelayIdentity !== undefined);
}

/**
 * Make sure `domain` holds an identity at each backfilled relay.
 *
 * OWN-MTA-PRIMARY ONLY, and that gate lives here rather than at each caller: a
 * relay identity COEXISTS on a domain whose primary provider is our own
 * infrastructure, while a domain already hosted at some provider owns its
 * identity through the ordinary lifecycle. D3's sanctioned identity check, read
 * from the domain-provider registry's single declaration — these are
 * domain-provider kinds, not send transports, so the constant is the registry's
 * and not `OWN_ARM_TRANSPORT_KIND`, and the two are pinned equal at build time
 * in `domains/providers/index.ts`.
 *
 * The subject is the DOC in both callers. The forward path used to gate on the
 * `providerType` captured on its effect and the drain on the row it had just
 * read; same value in practice, but two subjects for one rule is exactly the
 * seam a future change ("let a relay-primary domain carry a coexisting
 * identity") lands on one side of.
 *
 * A THROW MUST NOT PROPAGATE. The forward caller runs inside the mutation that
 * lands the domain's → verified transition, so an adapter that throws (an org
 * lookup that fails transiently, a provider row that vanished) would roll the
 * transition back and the operator would see Verify error out with the domain
 * stuck — the very failure the "schedule, never call inline" rule exists to
 * prevent, arriving through the read the adapters do before they schedule. The
 * drain gets the same protection for the same reason: one bad kind must not
 * cost the whole page. Losing a backfill is recoverable (the drain re-runs when
 * the operator touches the fallback); losing the transition is not.
 */
export async function ensureRelayIdentities(
	ctx: MutationCtx,
	domain: Doc<'domains'>,
	backfills: readonly RelayIdentityBackfill[]
): Promise<void> {
	if (domain.providerType !== OWN_SENDING_DOMAIN_PROVIDER_KIND) return;
	for (const ensureRelayIdentity of backfills) {
		try {
			await ensureRelayIdentity(ctx, domain);
		} catch (error) {
			logError(`[Relay identity] Backfill failed for ${domain.domain}:`, error);
		}
	}
}
