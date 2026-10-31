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
	ChecklistObservation,
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

/** What a run that could not observe records; its warning retries on the DNS chain. */
const UNCONFIRMED_OBSERVATION: ChecklistObservation = {
	validator: 'checklist.orchestrator',
	status: 'warn',
	observedValues: [],
	diagnostic:
		'The live check is temporarily unconfirmed, so its status is warning while Owlat retries.',
};

async function executeVerification(
	ctx: ActionCtx,
	request: ChecklistVerificationRequest
): Promise<VerificationResult> {
	const attemptId = crypto.randomUUID();
	const leaseToken = crypto.randomUUID();
	// checkpoint: a lease that keeps a concurrent verifier off this item during the
	// live checks; recordEvidence accepts only this lease token, and the lease lapses
	// after LEASE_MS, so a run that dies here leaves the item claimable again.
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

	let observation: ChecklistObservation;
	try {
		const traits = checklistTraits(request.itemId);
		if (request.source !== 'sweep') {
			await Promise.all([
				...(traits.contextDependencies.includes('warming')
					? [
							ctx.runAction(internal.delivery.warmingSync.syncWarmingState, {
								recheckIdentity: traits.contextDependencies.includes('outbound_identity'),
							}),
						]
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
		observation = {
			validator: result.validator,
			status: result.status,
			observedValues: result.observedValues,
			diagnostic: result.diagnostic,
		};
	} catch {
		observation = UNCONFIRMED_OBSERVATION;
	}

	// The one commit: recordEvidence re-checks the lease, writes the evidence and
	// its alerts, and schedules the next DNS retry.
	const recorded = await ctx.runMutation(internal.delivery.checklistEvidence.recordEvidence, {
		organizationId: request.organizationId,
		itemId: request.itemId,
		...(request.domainId ? { domainId: request.domainId } : {}),
		attemptId,
		generation: claim.generation,
		leaseToken,
		...observation,
		observedAt: Date.now(),
	});
	return {
		accepted: recorded.recorded,
		status: observation.status,
		...(observation !== UNCONFIRMED_OBSERVATION && recorded.recorded && recorded.nextCheckAt
			? { nextCheckAt: recorded.nextCheckAt }
			: {}),
	};
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
