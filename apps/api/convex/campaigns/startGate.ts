/**
 * What a scheduled campaign does at its start time when something is wrong:
 * wait, or give up visibly.
 *
 * The orchestrator re-runs the pre-flight when a scheduled campaign comes due,
 * because the template, the domain or the account can change after the
 * schedule was accepted. A refusal there must never be a silent skip: a
 * campaign left `scheduled` in the past never starts, and nobody is told.
 * Every outcome is one of three:
 *
 *  - proceed: the start goes ahead.
 *  - hold: the cause is temporary (delivery held by the org-wide safety
 *    circuit, or a built-in mail server that cannot deliver right now). The
 *    campaign stays `scheduled`; the per-minute scheduler tick re-enters
 *    `startCampaignSend`, which asks again, for at most
 *    {@link SCHEDULED_START_MAX_WAIT_MS} past the scheduled time.
 *  - refuse: the cause needs a person (a deleted template, an unverified
 *    domain, a suspended account), or a hold outlasted its wait. The campaign
 *    goes back to `draft` with the refusal stored on it, the editor shows the
 *    reason in place, and the people who may schedule it are notified.
 *    Fixing the cause and scheduling or sending it again clears the refusal.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { getLive } from '../lib/softDelete';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { loadStreamlessRouteState } from '../lib/deliverabilityRouteState';
import { isGlobalBreakerOpenState } from '../lib/sendProviders/routeInputs';
import { campaignStartRefusalValidator } from '../lib/validators/campaigns';
import { transitionCampaign } from './lifecycle';
import { validateReadyToSend, type PreflightResult } from './preflight';
import { preflightMessageKey, type PreflightFailureReason } from './refusalCopy';
import type { CampaignStartRefusal } from './lifecycleReducer';

/**
 * How long past its scheduled time a campaign waits out a temporary hold
 * before it gives up. A campaign is timed for its readers: one meant for 9am
 * that goes out in the evening has lost most of its point, and the person who
 * scheduled it should decide whether it still should.
 */
export const SCHEDULED_START_MAX_WAIT_MS = 6 * 60 * 60 * 1000;

/** The audit user for a start the gate gave up. */
const LIFECYCLE_USER_START_GATE = 'system:scheduled_start';

/** Pre-flight reasons that describe the delivery path right now, not the campaign. */
const TRANSIENT_REASONS: ReadonlySet<PreflightFailureReason> = new Set(['mail_server_not_ready']);

const DELIVERY_ON_HOLD_MESSAGE =
	'The scheduled campaign did not start: delivery stayed on hold (the sending safety circuit was open) for the whole wait after its start time. Check delivery health, then schedule it again.';

export type ScheduledStartDecision =
	| { kind: 'proceed' }
	| { kind: 'hold'; reason: string }
	| { kind: 'refuse'; refusal: CampaignStartRefusal };

type PreflightFailure = Extract<PreflightResult, { ok: false }>;

function storedRefusal(
	failure: Pick<PreflightFailure, 'reason' | 'messageKey' | 'messageParams' | 'message'>,
	scheduledAt: number,
	now: number
): CampaignStartRefusal {
	return {
		reason: failure.reason,
		messageKey: failure.messageKey,
		...(failure.messageParams ? { messageParams: { ...failure.messageParams } } : {}),
		message: failure.message,
		scheduledAt,
		refusedAt: now,
	};
}

/**
 * Pure: the fire-time decision for a due scheduled campaign, from its
 * pre-flight result and whether delivery is held org-wide.
 */
export function decideScheduledStart(input: {
	preflight: PreflightResult;
	isDeliveryOnHold: boolean;
	scheduledAt: number;
	now: number;
}): ScheduledStartDecision {
	const { preflight, isDeliveryOnHold, scheduledAt, now } = input;
	const isWaitOver = now - scheduledAt >= SCHEDULED_START_MAX_WAIT_MS;
	if (!preflight.ok) {
		if (TRANSIENT_REASONS.has(preflight.reason) && !isWaitOver) {
			return { kind: 'hold', reason: `Waiting for delivery: ${preflight.message}` };
		}
		return { kind: 'refuse', refusal: storedRefusal(preflight, scheduledAt, now) };
	}
	if (isDeliveryOnHold) {
		if (!isWaitOver) {
			return { kind: 'hold', reason: 'Waiting for delivery: the sending safety circuit is open' };
		}
		return {
			kind: 'refuse',
			refusal: storedRefusal(
				{
					reason: 'delivery_on_hold',
					messageKey: preflightMessageKey('delivery_on_hold', 'default'),
					message: DELIVERY_ON_HOLD_MESSAGE,
				},
				scheduledAt,
				now
			),
		};
	}
	return { kind: 'proceed' };
}

/**
 * Whether the org-wide safety circuit holds all delivery right now: the same
 * fresh `breaker_open` signal on the stream-less `all` row that makes route
 * resolution defer every send. No organization means no circuit.
 */
async function isDeliveryCircuitOpen(ctx: QueryCtx, now: number): Promise<boolean> {
	let organizationId: string;
	try {
		organizationId = await getSingletonOrganizationId(ctx);
	} catch {
		return false;
	}
	const state = await loadStreamlessRouteState(ctx, organizationId, 'all');
	return isGlobalBreakerOpenState(state, now);
}

/**
 * The fire-time check for a due `scheduled` campaign. The capacity gate is not
 * re-run: the schedule was accepted against the capacity at its start, and a
 * capacity refusal here would turn "the tail expires" into "nothing is sent".
 */
export const checkScheduledStart = internalQuery({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args): Promise<ScheduledStartDecision> => {
		const campaign = await getLive(ctx, args.campaignId);
		if (!campaign || campaign.status !== 'scheduled' || campaign.scheduledAt === undefined) {
			return { kind: 'hold', reason: 'Campaign is no longer scheduled' };
		}
		const now = Date.now();
		return decideScheduledStart({
			preflight: await validateReadyToSend(ctx, campaign, { checkCapacity: false, now }),
			isDeliveryOnHold: await isDeliveryCircuitOpen(ctx, now),
			scheduledAt: campaign.scheduledAt,
			now,
		});
	},
});

/** Whether a refusal still applies to the campaign as it is now. */
function isStillThatStart(campaign: Doc<'campaigns'> | null, scheduledAt: number): boolean {
	return campaign?.status === 'scheduled' && campaign.scheduledAt === scheduledAt;
}

/**
 * Give up a scheduled start: back to draft with the refusal recorded, which
 * also notifies (the lifecycle's `notify_marketing` effect). A no-op when the
 * campaign was rescheduled, unscheduled, cancelled or started since the check,
 * so a late refusal can never undo a newer decision.
 */
export const refuseScheduledStart = internalMutation({
	args: { campaignId: v.id('campaigns'), refusal: campaignStartRefusalValidator },
	handler: async (ctx, args): Promise<{ refused: boolean }> => {
		const campaign = await getLive(ctx, args.campaignId);
		if (!isStillThatStart(campaign, args.refusal.scheduledAt)) return { refused: false };
		const outcome = await transitionCampaign(
			ctx,
			args.campaignId,
			{ to: 'draft', at: args.refusal.refusedAt, startRefusal: args.refusal },
			LIFECYCLE_USER_START_GATE
		);
		return { refused: outcome.ok };
	},
});
