'use node';

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { GovernedMessageType } from '@owlat/shared';
import type { MtaIpPool, SendProviderKind } from '../lib/sendProviders';
import { resolveMtaRoutingDecision } from '../lib/sendProviders/mta';
import type { ResolvedRoute } from '../lib/sendProviders/routing';
import { selectSendProviderKind } from '../lib/sendProviders/types';

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
	let route = await ctx.runQuery(internal.lib.sendProviders.route.resolveSendRoute, {
		messageType: input.messageType,
		to: input.to,
		from: input.from,
		baseOnly: true,
	});
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

	const decision = await resolveMtaRoutingDecision({
		messageId: input.idempotencyKey,
		messageType: input.messageType,
		organizationId,
		recipient: input.to,
		from: input.from,
		candidateProvider: providerKind === 'mta' ? 'mta' : 'relay',
		ipPool: (route?.ipPool ?? input.ipPool) as MtaIpPool | undefined,
		allowWarmupOverflow: Boolean(input.messageType === 'campaign' && route?.warmupOverflowEnabled),
	});
	if (decision.kind === 'defer') {
		return { kind: 'defer', retryAfterMs: decision.retryAfterMs };
	}
	if (providerKind === 'mta' && decision.kind === 'relay') {
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
		...(decision.kind === 'mta' ? { routingLease: decision.leaseToken } : {}),
	};
}
