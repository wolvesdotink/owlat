'use node';

import { v } from 'convex/values';
import { DELIVERABILITY_CHECKLIST } from '@owlat/shared';
import { internal } from '../_generated/api';
import { internalAction, type ActionCtx } from '../_generated/server';
import { authedAction } from '../lib/authedFunctions';
import { DNS_RETRY_DELAYS_MS, deliverabilityCheckIdValidator } from './checklistEvidence';
import { observeDeploymentCheck } from './checklistDeploymentValidators';
import { observeDomainCheck } from './checklistDomainValidators';
import { checklistTraits } from './checklistTraits';
import type {
	ChecklistVerificationContext,
	ChecklistVerificationRequest,
} from './checklistValidatorTypes';

type VerificationResult = {
	accepted: boolean;
	status?: 'pass' | 'warn' | 'fail' | 'pending-dns';
	nextCheckAt?: number;
};

export function isFinalDnsPropagationAttempt(
	isDnsBacked: boolean,
	expectedGeneration: number | undefined,
	retryIndex: number
): boolean {
	return (
		isDnsBacked && expectedGeneration !== undefined && retryIndex >= DNS_RETRY_DELAYS_MS.length
	);
}

async function executeVerification(
	ctx: ActionCtx,
	request: ChecklistVerificationRequest
): Promise<VerificationResult> {
	const attemptId = crypto.randomUUID();
	const leaseToken = crypto.randomUUID();
	const claim = await ctx.runMutation(internal.delivery.checklistEvidence.claimVerification, {
		organizationId: request.organizationId,
		itemId: request.itemId,
		...(request.domainId ? { domainId: request.domainId } : {}),
		attemptId,
		leaseToken,
		now: Date.now(),
		...(request.source === 'sweep' ? { preserveScheduledRetry: true } : {}),
		...(request.expectedGeneration !== undefined
			? { expectedGeneration: request.expectedGeneration }
			: {}),
	});
	if (!claim.claimed) {
		return {
			accepted: false,
			...(claim.nextCheckAt ? { nextCheckAt: claim.nextCheckAt } : {}),
		};
	}

	try {
		const traits = checklistTraits(request.itemId);
		if (request.source !== 'sweep') {
			await Promise.all([
				...(traits.contextDependencies.includes('warming')
					? [ctx.runAction(internal.delivery.warmingSync.syncWarmingState, {})]
					: []),
				...(traits.contextDependencies.includes('mta_health')
					? [ctx.runAction(internal.delivery.mtaHealth.sync, {})]
					: []),
			]);
		}
		const context: ChecklistVerificationContext = await ctx.runQuery(
			internal.delivery.checklist.getVerificationContext,
			{
				organizationId: request.organizationId,
				itemId: request.itemId,
				...(request.domainId ? { domainId: request.domainId } : {}),
			}
		);
		const definition = DELIVERABILITY_CHECKLIST.find((item) => item.id === request.itemId);
		if (!definition) throw new Error('Unknown deliverability checklist item');
		const isFinalDnsRetry = isFinalDnsPropagationAttempt(
			definition.dnsBacked,
			request.expectedGeneration,
			claim.retryIndex
		);
		const result =
			traits.scope === 'domain'
				? await observeDomainCheck(ctx, request.itemId, context, isFinalDnsRetry)
				: await observeDeploymentCheck(request.itemId, context, isFinalDnsRetry);
		const recorded = await ctx.runMutation(internal.delivery.checklistEvidence.recordEvidence, {
			organizationId: request.organizationId,
			itemId: request.itemId,
			...(request.domainId ? { domainId: request.domainId } : {}),
			attemptId,
			generation: claim.generation,
			leaseToken,
			validator: result.validator,
			status: result.status,
			observedValues: result.observedValues,
			diagnostic: result.diagnostic,
			observedAt: Date.now(),
		});
		return {
			accepted: recorded.recorded,
			status: result.status,
			...(recorded.recorded && recorded.nextCheckAt ? { nextCheckAt: recorded.nextCheckAt } : {}),
		};
	} catch {
		const diagnostic =
			'The live check is temporarily unconfirmed, so its status is warning while Owlat retries.';
		const recorded = await ctx.runMutation(internal.delivery.checklistEvidence.recordEvidence, {
			organizationId: request.organizationId,
			itemId: request.itemId,
			...(request.domainId ? { domainId: request.domainId } : {}),
			attemptId,
			generation: claim.generation,
			leaseToken,
			validator: 'checklist.orchestrator',
			status: 'warn',
			observedValues: [],
			diagnostic,
			observedAt: Date.now(),
		});
		return { accepted: recorded.recorded, status: 'warn' };
	}
}

// authz: owner/admin gate is enforced by the inherited-identity
// `checklist.getAdminScope` query before verification can claim or write evidence.
export const verifyNow = authedAction({
	args: {
		itemId: deliverabilityCheckIdValidator,
		domainId: v.optional(v.id('domains')),
	},
	handler: async (ctx, args): Promise<VerificationResult> => {
		const { organizationId } = (await ctx.runQuery(
			internal.delivery.checklist.getAdminScope,
			{}
		)) as { organizationId: string };
		return executeVerification(ctx, {
			organizationId,
			...args,
			source: 'interactive',
		});
	},
});

export const retry = internalAction({
	args: {
		organizationId: v.string(),
		itemId: deliverabilityCheckIdValidator,
		domainId: v.optional(v.id('domains')),
		expectedGeneration: v.number(),
	},
	handler: async (ctx, args): Promise<VerificationResult> =>
		executeVerification(ctx, { ...args, source: 'retry' }),
});

export const sweep = internalAction({
	args: {
		organizationId: v.string(),
		itemId: deliverabilityCheckIdValidator,
		domainId: v.optional(v.id('domains')),
	},
	handler: async (ctx, args): Promise<VerificationResult> =>
		executeVerification(ctx, { ...args, source: 'sweep' }),
});
