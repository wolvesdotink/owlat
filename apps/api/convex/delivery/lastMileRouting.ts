'use node';

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { DeliveryDomain, GovernedMessageType } from '@owlat/shared';
import type { MtaIpPool, SendProviderKind } from '../lib/sendProviders';
import { resolveMtaRoutingDecision } from '../lib/sendProviders/mta';
import type { ResolvedRoute } from '../lib/sendProviders/routing';
import { transportEnvOptional } from '../lib/sendProviders/transportEnv';
import { defaultSendTransportId, resolveSendTransport } from '../lib/sendProviders/transports';
import { selectSendProviderKind } from '../lib/sendProviders/types';

interface LastMileInput {
	messageType: GovernedMessageType;
	to: string;
	from: string;
	providerType?: string;
	ipPool?: string;
	organizationId?: string;
	idempotencyKey: string;
	workAttemptId: string;
	routingReentryToken: string;
	startedAt: number;
	deliveryDomain: DeliveryDomain;
	mtaReconciliation?: boolean;
	/**
	 * The durable Send id. Passed to route resolution so an `adaptive_mix` cell
	 * dispatches on the arm the enqueue transaction RECORDED for this recipient,
	 * instead of a second, independently-taken decision.
	 */
	sendId?: string;
}

export interface LastMileRoutingReady {
	kind: 'ready';
	providerKind: SendProviderKind;
	route: ResolvedRoute | null;
	organizationId: string;
	routingLease?: string;
	/**
	 * The return-path host a relay send may stamp as its VERP envelope sender,
	 * so a bounce the relay generates reaches our own bounce server (plan G-08).
	 * Carried on the routing result because the routing query already resolved
	 * it — the send path must not grow a second round trip per message.
	 * `undefined` unless the transport is PROVEN to honour a custom return path
	 * AND the From domain's return-path host authorises it.
	 */
	relayReturnPathHost?: string | undefined;
}

export interface LastMileRoutingDeferred {
	kind: 'defer';
	retryAfterMs: number;
	/**
	 * A deliberate safety hold (an open org-wide circuit, an unverified relay
	 * identity) rather than routing churn. The routing attempt cap exists to
	 * bound churn, so a hold must not consume one — eight 60-second attempts
	 * would terminalize the send about seven minutes in, well inside a single
	 * signal's own freshness window, which is the destruction the hold exists
	 * to prevent. Held sends are bounded by the four-day delivery deadline.
	 */
	isPolicyHold?: boolean;
	/**
	 * WHOSE FACT THIS DEFERRAL IS — gate 2's numerator (plan D5, D10), and the
	 * reason this field is REQUIRED rather than defaulted: a new defer site that
	 * forgot to answer would quietly pick a side.
	 *
	 * `governed` — the MTA's routing governance declined to carry this message on
	 * what it knows about the SENDING IDENTITY: an open safety circuit, no warmed
	 * IP, an open breaker with no relay to catch the overflow. That is a statement
	 * about whether this identity can get mail out, which is what gate 2 measures
	 * and what may halt a cell.
	 *
	 * `local` — this deployment's own machinery: a deliberate policy hold, the
	 * idempotency reconciliation wait, an unconfigured or unreachable decision
	 * endpoint, a warm-up cap we set ourselves, and the MTA reporting any Redis
	 * failure while taking the lease. Our own infrastructure is `local` wherever it
	 * runs, and an ANSWER from the MTA is not automatically `governed` — only an
	 * answer about the identity is. Counting these would let a forty-minute outage
	 * on our own side push a cell past the 25% halt line — share to the floor,
	 * cooldown, and the graduation pin revoked — for a fault no receiver ever saw.
	 */
	origin: 'governed' | 'local';
}

/** Poll at the deliverability signal's own freshness horizon while held. */
const POLICY_HOLD_RETRY_MS = 10 * 60 * 1000;

export type LastMileRoutingResult = LastMileRoutingReady | LastMileRoutingDeferred;

/**
 * A reconciliation attempt exists because an earlier `POST /send` may already
 * have committed MTA work whose response was lost. Only the owned-MTA path can
 * resolve that ambiguity — the MTA deduplicates on the reused `workAttemptId`.
 * Any other transport would transmit a second copy of a message the MTA may
 * already be delivering, and a relay carries no idempotency key at all. Every
 * non-owned outcome must therefore defer until the owned path can answer.
 */
function withReconciliationSafety(
	result: LastMileRoutingResult,
	mtaReconciliation: boolean | undefined
): LastMileRoutingResult {
	if (!mtaReconciliation) return result;
	if (result.kind === 'ready' && result.providerKind !== 'mta') {
		// OUR OWN IDEMPOTENCY WAIT, not the receiver's answer: nothing about this
		// identity's standing has been observed, so it is not gate 2's evidence.
		return { kind: 'defer', retryAfterMs: 60_000, origin: 'local' };
	}
	return result;
}

/** Resolve current recipient routing and the MTA's authoritative safety lease. */
export async function resolveLastMileRouting(
	ctx: ActionCtx,
	input: LastMileInput
): Promise<LastMileRoutingResult> {
	const plan = await ctx.runQuery(internal.lib.sendProviders.route.resolveLastMileRoutePlan, {
		messageType: input.messageType,
		to: input.to,
		from: input.from,
		...(input.sendId !== undefined ? { sendId: input.sendId } : {}),
	});
	// An open org-wide safety circuit, or a fallback whose relay identity is
	// unverified, is a "not right now" — holding keeps the message alive until
	// the deadline instead of burning every in-flight send the moment a safety
	// signal trips. The code is logged because it is the operator's only clue
	// as to why mail paused.
	if (plan.deferralCode) {
		console.warn(`[lastMileRouting] holding delivery: ${plan.deferralCode}`);
		return {
			kind: 'defer',
			retryAfterMs: POLICY_HOLD_RETRY_MS,
			isPolicyHold: true,
			// The deployment pausing itself. It already does not consume a routing
			// attempt for that reason; for the same reason it is not a 4xx.
			origin: 'local',
		};
	}
	let route = plan.route;
	let providerKind = selectSendProviderKind(route?.providerType ?? input.providerType);
	if (!providerKind) {
		throw new Error(
			'No delivery provider configured: set EMAIL_PROVIDER (and its credentials) or a provider route before sending.'
		);
	}
	const organizationId =
		input.organizationId ??
		(await ctx.runQuery(internal.campaigns.sendQueries.getSingletonOrganizationId, {}));
	if (!organizationId)
		throw new Error('Delivery safety decision requires an organization identity.');
	if (!plan.isMtaGoverned) {
		return withReconciliationSafety(
			{
				kind: 'ready',
				providerKind,
				route,
				organizationId,
				relayReturnPathHost: plan.relayReturnPathHost,
			},
			input.mtaReconciliation
		);
	}
	// Convex snapshots are authoritative for IP/DNSBL/persistent-defer routing.
	// Only a breaker route is eligible for an MTA half-open recovery probe.
	if (route?.deliverabilityReason && route.deliverabilityReason !== 'breaker_open') {
		return withReconciliationSafety(
			{
				kind: 'ready',
				providerKind,
				route,
				organizationId,
				relayReturnPathHost: plan.relayReturnPathHost,
			},
			input.mtaReconciliation
		);
	}
	// The governed last mile leases from — and sends through — the DEFAULT MTA
	// transport. Reading its configuration through the record keeps the gate and
	// the lease pointed at the same instance.
	const mtaTransport = resolveSendTransport(defaultSendTransportId('mta'));
	if (
		!transportEnvOptional(mtaTransport, 'MTA_API_URL') ||
		!transportEnvOptional(mtaTransport, 'MTA_API_KEY')
	) {
		// Unconfigured on our side — a fault, not a verdict about this identity.
		return { kind: 'defer', retryAfterMs: 60_000, origin: 'local' };
	}
	const baseProviderKind = selectSendProviderKind(
		plan.baseRoute?.providerType ?? input.providerType
	);
	if (!baseProviderKind) {
		throw new Error('Owned-MTA routing has no configured base transport.');
	}
	if (input.mtaReconciliation && baseProviderKind !== 'mta') {
		return { kind: 'defer', retryAfterMs: 60_000, origin: 'local' };
	}

	const decision = await resolveMtaRoutingDecision(mtaTransport, {
		messageId: input.idempotencyKey,
		workAttemptId: input.workAttemptId,
		routingReentryToken: input.routingReentryToken,
		startedAt: input.startedAt,
		deliveryDomain: input.deliveryDomain,
		messageType: input.messageType,
		organizationId,
		recipient: input.to,
		from: input.from,
		candidateProvider: baseProviderKind === 'mta' ? 'mta' : 'relay',
		ipPool: (plan.baseRoute?.ipPool ?? input.ipPool) as MtaIpPool | undefined,
		allowWarmupOverflow: Boolean(
			input.messageType === 'campaign' && plan.baseRoute?.warmupOverflowEnabled
		),
		requireProviderProbe: route?.deliverabilityReason === 'breaker_open',
	});
	if (decision.kind === 'defer') {
		// CARRIED, never re-derived, because three cases arrive here looking
		// identical and only the adapter can tell them apart: the MTA answered
		// `defer` about THIS IDENTITY (`governed`), it answered `defer` about our
		// own infrastructure — a Redis failure while taking the lease, see
		// `MTA_DEFER_REASON_ORIGIN` (`local`) — or it was never reached at all, so
		// nobody judged anything (`local`). This layer sees one `retryAfterMs` for
		// all three, so re-deriving the origin here could only guess.
		return { kind: 'defer', retryAfterMs: decision.retryAfterMs, origin: decision.origin };
	}
	if (decision.kind === 'mta') {
		if (baseProviderKind !== 'mta') {
			throw new Error('MTA returned an owned route for a relay-only candidate.');
		}
		if (route?.deliverabilityReason === 'breaker_open' && !decision.isProviderProbe) {
			return withReconciliationSafety(
				{
					kind: 'ready',
					providerKind,
					route,
					organizationId,
					relayReturnPathHost: plan.relayReturnPathHost,
				},
				input.mtaReconciliation
			);
		}
		return {
			kind: 'ready',
			providerKind: 'mta',
			route: plan.baseRoute,
			organizationId,
			routingLease: decision.leaseToken,
			relayReturnPathHost: plan.relayReturnPathHost,
		};
	}
	if (input.mtaReconciliation) {
		return { kind: 'defer', retryAfterMs: 60_000, origin: 'local' };
	}
	if (baseProviderKind === 'mta' && route?.providerType !== 'ses') {
		const relayReason = decision.reason === 'warmup_overflow' ? 'warmup_overflow' : 'breaker_open';
		const relay = await ctx.runQuery(internal.lib.sendProviders.route.resolveGovernedRelayRoute, {
			messageType: input.messageType,
			to: input.to,
			from: input.from,
			...(input.sendId !== undefined ? { sendId: input.sendId } : {}),
			forceRelayReason: relayReason,
		});
		route = relay.route;
		providerKind = selectSendProviderKind(route?.providerType);
		// The MTA has already declined this message, so there is nowhere to send
		// it right now. Hold rather than terminalizing a message the policy
		// intends to pause.
		if (relay.deferralCode || !providerKind || providerKind === 'mta') {
			console.warn(
				`[lastMileRouting] holding delivery: ${relay.deferralCode ?? 'relay_unavailable'}`
			);
			return {
				kind: 'defer',
				retryAfterMs: POLICY_HOLD_RETRY_MS,
				isPolicyHold: true,
				// THREE HOLDS AT ONE RETURN SITE, and only one of them is evidence.
				//
				// `breaker_open` with no relay to catch it is the MTA refusing to carry
				// this identity on evidence it gathered about the identity — exactly
				// the pressure gate 2 exists to see.
				//
				// `warmup_overflow` is NOT. The cap is a schedule WE set and its
				// designed relief valve is the relay; a deployment running without one
				// (the standalone twin is a first-class configuration here) would
				// otherwise push every over-cap message into gate 2's numerator, cross
				// the 25% halt line on its own ramp plan, and take the share to the
				// floor with the graduation pin revoked — for a 4xx no receiver ever
				// sent. The warming cap has its own actuator; it is not this one.
				//
				// A `deferralCode` from the relay route is our own configuration too.
				origin: relay.deferralCode || relayReason === 'warmup_overflow' ? 'local' : 'governed',
			};
		}
	}
	// The warm-up-overflow / breaker-open relay fallback resolved above carries
	// most relay traffic during a ramp, so it is the LAST route that may drop the
	// VERP envelope sender: without it those bounces land at the relay and the
	// arm reads artificially clean (plan G-08).
	return withReconciliationSafety(
		{
			kind: 'ready',
			providerKind,
			route,
			organizationId,
			relayReturnPathHost: plan.relayReturnPathHost,
		},
		input.mtaReconciliation
	);
}
