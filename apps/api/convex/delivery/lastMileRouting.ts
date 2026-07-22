'use node';

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { GovernedMessageType } from '@owlat/shared';
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
		return { kind: 'ready', providerKind, route, organizationId };
	}
	// Convex snapshots are authoritative for IP/DNSBL/persistent-defer routing.
	// Only a breaker route is eligible for an MTA half-open recovery probe.
	if (route?.deliverabilityReason && route.deliverabilityReason !== 'breaker_open') {
		return { kind: 'ready', providerKind, route, organizationId };
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

	const decision = await resolveMtaRoutingDecision({
		messageId: input.idempotencyKey,
		messageType: input.messageType,
		organizationId,
		recipient: input.to,
		from: input.from,
		candidateProvider: baseProviderKind === 'mta' ? 'mta' : 'relay',
		ipPool: (plan.baseRoute?.ipPool ?? input.ipPool) as MtaIpPool | undefined,
		allowWarmupOverflow: Boolean(
			input.messageType === 'campaign' && plan.baseRoute?.warmupOverflowEnabled
		),
	});
	if (decision.kind === 'defer') {
		return { kind: 'defer', retryAfterMs: decision.retryAfterMs };
	}
	if (decision.kind === 'mta') {
		if (baseProviderKind !== 'mta') {
			throw new Error('MTA returned an owned route for a relay-only candidate.');
		}
		return {
			kind: 'ready',
			providerKind: 'mta',
			route: plan.baseRoute,
			organizationId,
			routingLease: decision.leaseToken,
		};
	}
	if (baseProviderKind === 'mta' && route?.providerType !== 'ses') {
		route = await ctx.runQuery(internal.lib.sendProviders.route.resolveSendRoute, {
			messageType: input.messageType,
			to: input.to,
			from: input.from,
			forceRelayReason: decision.reason === 'warmup_overflow' ? 'warmup_overflow' : 'breaker_open',
		});
		providerKind = selectSendProviderKind(route?.providerType);
		if (!providerKind || providerKind === 'mta') {
			throw new Error('Verified deliverability relay unavailable for the active safety policy.');
		}
	}
	return {
		kind: 'ready',
		providerKind,
		route,
		organizationId,
	};
}
