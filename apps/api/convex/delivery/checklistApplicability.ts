/**
 * Which checks apply to this deployment, read once for every caller.
 *
 * The Center's grade, the sweeps, a manual verify, a scheduled retry and the
 * regression alerts all ask `deliverabilityCheckUnusedReason` against the send
 * paths loaded here. A check that judges a send path the deployment does not
 * use is not run, keeps no evidence that a later run could be compared
 * against, and can neither raise nor keep open a regression alert.
 */

import {
	DELIVERABILITY_CHECKLIST,
	deliverabilityCheckUnusedReason,
	type DeliverabilityCheckId,
	type DeliverabilitySendPaths,
} from '@owlat/shared';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { messageTypeTransportKinds } from '../lib/sendProviders/capability';
import { OWN_ARM_TRANSPORT_KIND } from '../lib/sendProviders/strategies/adaptive_mix';
import { isFeatureEnabled } from '../lib/featureFlags';
import { resolveOpenItemAlerts } from './checklistAlertResolution';

/**
 * Which send paths the checks are judged against. The transport kinds per
 * message type are the ones the readiness panel and the health dot read
 * (`messageTypeTransportKinds`), so the surfaces agree on whether the
 * built-in mail server is in use.
 */
export async function loadDeliverabilitySendPaths(
	ctx: QueryCtx | MutationCtx,
	loadedRoutes?: readonly Doc<'providerRoutes'>[]
): Promise<DeliverabilitySendPaths> {
	const routes = loadedRoutes ?? (await ctx.db.query('providerRoutes').take(10)); // bounded: three message-type rows
	const kinds = await Promise.all(
		(['transactional', 'campaign', 'automation'] as const).map((messageType) =>
			messageTypeTransportKinds(ctx, routes, messageType)
		)
	);
	return {
		usesOwnMta: kinds.some((forType) => forType.includes(OWN_ARM_TRANSPORT_KIND)),
		sendsMarketing: await isFeatureEnabled(ctx, 'campaigns'),
	};
}

export function isChecklistItemApplicable(
	itemId: DeliverabilityCheckId,
	paths: DeliverabilitySendPaths
): boolean {
	const definition = DELIVERABILITY_CHECKLIST.find((item) => item.id === itemId);
	if (!definition) throw new Error('Unknown deliverability checklist item');
	return deliverabilityCheckUnusedReason(definition, paths) === null;
}

/**
 * Put a check that stopped applying out of play: resolve its open alerts
 * (cancelling any email still pending), drop the evidence the Center shows,
 * cancel a pending retry, and stamp when it happened so a pass from before it
 * is never the baseline of a later regression alert.
 */
export async function retireInapplicableCheck(
	ctx: MutationCtx,
	args: {
		organizationId: string;
		targetKey: string;
		itemId: DeliverabilityCheckId;
		now: number;
	}
): Promise<void> {
	await resolveOpenItemAlerts(ctx, args, args.now, 'not_applicable');
	const state = await ctx.db
		.query('deliverabilityVerificationState')
		.withIndex('by_org_target_item', (q) =>
			q
				.eq('organizationId', args.organizationId)
				.eq('targetKey', args.targetKey)
				.eq('itemId', args.itemId)
		)
		.unique();
	// An already retired row is left alone, so the hourly sweep does not
	// rewrite it (and wake every Center subscriber) each time it runs.
	if (
		!state ||
		(state.notApplicableAt !== undefined &&
			state.currentEvidenceId === undefined &&
			state.nextCheckAt === undefined)
	) {
		return;
	}
	await ctx.db.patch(state._id, {
		currentEvidenceId: undefined,
		nextCheckAt: undefined,
		retryIndex: 0,
		notApplicableAt: args.now,
		updatedAt: args.now,
	});
}
