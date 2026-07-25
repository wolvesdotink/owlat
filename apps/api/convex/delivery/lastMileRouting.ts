'use node';

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { DeliveryDomain, GovernedMessageType } from '@owlat/shared';
import type { MtaIpPool, SendProviderKind } from '../lib/sendProviders';
import { resolveMtaRoutingDecision } from '../lib/sendProviders/mta';
import type { ResolvedRoute } from '../lib/sendProviders/routing';
import { selectSendProviderKind } from '../lib/sendProviders/types';
import { getOptional } from '../lib/env';

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
}

export interface LastMileRoutingReady {
	kind: 'ready';
	providerKind: SendProviderKind;
	route: ResolvedRoute | null;
	organizationId: string;
	routingLease?: string;
}

export interface LastMileRoutingDeferred {
	kind: 'defer';
	retryAfterMs: number;
}

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
		return { kind: 'defer', retryAfterMs: 60_000 };
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
	});
	// An open org-wide safety circuit, or a fallback whose relay identity is
	// unverified, is a "not right now" — deferring keeps the message alive under
	// the routing attempt cap and the delivery deadline instead of burning every
	// in-flight send the moment a safety signal trips.
	if (plan.deferralCode) return { kind: 'defer', retryAfterMs: 60_000 };
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
			{ kind: 'ready', providerKind, route, organizationId },
			input.mtaReconciliation
		);
	}
	// Convex snapshots are authoritative for IP/DNSBL/persistent-defer routing.
	// Only a breaker route is eligible for an MTA half-open recovery probe.
	if (route?.deliverabilityReason && route.deliverabilityReason !== 'breaker_open') {
		return withReconciliationSafety(
			{ kind: 'ready', providerKind, route, organizationId },
			input.mtaReconciliation
		);
	}
	if (!getOptional('MTA_API_URL') || !getOptional('MTA_API_KEY')) {
		return { kind: 'defer', retryAfterMs: 60_000 };
	}
	const baseProviderKind = selectSendProviderKind(
		plan.baseRoute?.providerType ?? input.providerType
	);
	if (!baseProviderKind) {
		throw new Error('Owned-MTA routing has no configured base transport.');
	}
	if (input.mtaReconciliation && baseProviderKind !== 'mta') {
		return { kind: 'defer', retryAfterMs: 60_000 };
	}

	const decision = await resolveMtaRoutingDecision({
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
		return { kind: 'defer', retryAfterMs: decision.retryAfterMs };
	}
	if (decision.kind === 'mta') {
		if (baseProviderKind !== 'mta') {
			throw new Error('MTA returned an owned route for a relay-only candidate.');
		}
		if (route?.deliverabilityReason === 'breaker_open' && !decision.isProviderProbe) {
			return withReconciliationSafety(
				{ kind: 'ready', providerKind, route, organizationId },
				input.mtaReconciliation
			);
		}
		return {
			kind: 'ready',
			providerKind: 'mta',
			route: plan.baseRoute,
			organizationId,
			routingLease: decision.leaseToken,
		};
	}
	if (input.mtaReconciliation) {
		return { kind: 'defer', retryAfterMs: 60_000 };
	}
	if (baseProviderKind === 'mta' && route?.providerType !== 'ses') {
		const relay = await ctx.runQuery(internal.lib.sendProviders.route.resolveGovernedRelayRoute, {
			messageType: input.messageType,
			to: input.to,
			from: input.from,
			forceRelayReason: decision.reason === 'warmup_overflow' ? 'warmup_overflow' : 'breaker_open',
		});
		route = relay.route;
		providerKind = selectSendProviderKind(route?.providerType);
		// The MTA has already declined this message, so there is nowhere to send
		// it right now. Defer rather than terminalizing a message the policy
		// intends to hold.
		if (relay.deferralCode || !providerKind || providerKind === 'mta') {
			return { kind: 'defer', retryAfterMs: 60_000 };
		}
	}
	return withReconciliationSafety(
		{ kind: 'ready', providerKind, route, organizationId },
		input.mtaReconciliation
	);
}
