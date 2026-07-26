'use node';

import { v } from 'convex/values';
import { DELIVERABILITY_CHECKLIST } from '@owlat/shared';
import { internal } from '../_generated/api';
import { internalAction, type ActionCtx } from '../_generated/server';
import { authedAction } from '../lib/authedFunctions';
import { deliverabilityCheckIdValidator } from './checklistEvidence';
import { observeDeploymentCheck } from './checklistDeploymentValidators';
import { observeDomainCheck } from './checklistDomainValidators';
import type {
	ChecklistVerificationContext,
	ChecklistVerificationRequest,
} from './checklistValidatorTypes';

type VerificationResult = {
	accepted: boolean;
	status?: 'pass' | 'warn' | 'fail' | 'pending-dns';
	nextCheckAt?: number;
};

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
		if (request.itemId.startsWith('deployment.') && request.source !== 'sweep') {
			await Promise.all([
				ctx.runAction(internal.delivery.warmingSync.syncWarmingState, {}),
				ctx.runAction(internal.delivery.mtaHealth.sync, {}),
			]);
		}
		const context: ChecklistVerificationContext = await ctx.runQuery(
			internal.delivery.checklist.getVerificationContext,
			{
				organizationId: request.organizationId,
				...(request.domainId ? { domainId: request.domainId } : {}),
			}
		);
		const definition = DELIVERABILITY_CHECKLIST.find((item) => item.id === request.itemId);
		if (!definition) throw new Error('Unknown deliverability checklist item');
		const isFinalDnsRetry =
			definition.dnsBacked &&
			((request.source === 'sweep' && claim.hadConfirmedPass) ||
				(request.expectedGeneration !== undefined && claim.retryIndex >= 4));
		const result =
			request.domainId && context.domain
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
