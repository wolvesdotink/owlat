/**
 * Waiting for configuration (module): an email step that hits a fault of the
 * instance's sending setup (the reasons in `automationStepWaitReasonValidator`)
 * waits for a person to fix it instead of failing, for at most
 * {@link CONFIGURATION_WAIT_MS}.
 *
 * THE WAIT. The attempt that hit the fault puts its step run back to `pending`
 * with `waitingFor` (the reason), `waitingUntil` (when the wait gives up, kept
 * from the first wait) and `waitingCheckedAt` (its place in the re-check
 * queue). `delayUntil` is set to `waitingUntil`, so the claim refuses the row
 * until it is taken out of the queue, and the first wait schedules one firing
 * for `waitingUntil`: if the fault is still there then, the step fails with the
 * same reason, exactly as it did before waiting existed. Nothing fails while
 * the step waits, so nothing counts toward the self-pause and the run stays
 * active. The error-retry backoff is skipped: a configuration fault does not
 * clear within 30 seconds.
 *
 * THE RE-CHECK. All four faults belong to the instance, not to one step, so
 * one step that passes tells about all of them. Each tick of the cron
 * (`probeWaitingStepRun`) re-runs the one step that was checked longest ago,
 * however many wait: the work while the fault lasts is one step attempt per
 * tick. When a re-checked step's mail goes out, its commit starts
 * `releaseWaitingStepRuns`, which takes {@link RELEASE_BATCH} waiting steps out
 * of the queue per transaction and continues itself until the queue holds only
 * steps that started waiting again after it began. A released step drops its
 * `waitingFor`, so its own mail going out starts no second chain; if it hits a
 * fault again (a route that differs by recipient), it waits again with its
 * original deadline.
 *
 * NO SECOND SEND. A step runs only through the claim, which a `pending` row
 * passes once (the CAS of `stepOrchestration.claimStepRun`): the cron's firing,
 * a release, the give-up firing and the due-delay sweep may all fire the same
 * step run, and the losers are dropped. The intake is keyed by the step run as
 * well, so an attempt that does get through returns the first Send. The claim
 * also re-checks the run, the automation and the contact, so a run that ended,
 * an automation paused or deleted meanwhile, and a contact deleted or
 * unsubscribed meanwhile send nothing; a blocklisted address is refused by the
 * intake.
 *
 * TIMING. A step that waited completes when its mail goes out, and the next
 * step's delay counts from then (`enterStep` measures from the commit), so a
 * drip keeps its spacing after the wait. The step uses the automation's
 * current step config and template when it runs.
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import type {
	AutomationStepFailureReason,
	AutomationStepWaitReason,
} from '../lib/validators/automations';
import { transitionStepRun } from './stepRunTransitions';

/**
 * How long a step waits for its configuration fault to be fixed. A day leaves
 * time for DNS verification and for someone to notice the note on the run and
 * fix the setup. Mail that arrives more than a day after the contact's action
 * (a welcome, a confirmation of a signup) has lost its moment, so the run fails
 * visibly instead, the same day the walker allows work the previous release
 * left stuck (`PRE_UPGRADE_ABANDON_AFTER_MS`).
 */
export const CONFIGURATION_WAIT_MS = 24 * 60 * 60 * 1000;

/** Waiting steps one release transaction takes out of the queue. */
export const RELEASE_BATCH = 25;

const WAIT_REASONS: ReadonlySet<AutomationStepFailureReason> = new Set<AutomationStepWaitReason>([
	'no_delivery_provider',
	'domain_not_verified',
	'sending_not_allowed',
	'no_default_sender',
]);

/** The failure reason as a reason to wait, or null for one that fails the step. */
export function configurationWaitReason(
	reason: AutomationStepFailureReason | undefined
): AutomationStepWaitReason | null {
	return reason !== undefined && WAIT_REASONS.has(reason)
		? (reason as AutomationStepWaitReason)
		: null;
}

/**
 * Put an executing step run that hit `reason` back to waiting, or return null
 * when its wait is over and the step should fail.
 */
export async function waitForConfiguration(
	ctx: MutationCtx,
	stepRun: Doc<'automationStepRuns'>,
	reason: AutomationStepWaitReason,
	errorMessage: string
): Promise<{ until: number } | null> {
	const now = Date.now();
	const until = stepRun.waitingUntil ?? now + CONFIGURATION_WAIT_MS;
	if (now >= until) return null;
	await transitionStepRun(ctx, stepRun, 'pending', {
		waitingFor: reason,
		waitingUntil: until,
		waitingCheckedAt: now,
		delayUntil: until,
		errorMessage,
		leaseExpiresAt: undefined,
	});
	if (stepRun.waitingUntil === undefined) {
		// The give-up check. Later waits of the same step run keep this one.
		await ctx.scheduler.runAt(until, internal.automations.stepWalker.executeStep, {
			automationRunId: stepRun.automationRunId,
			stepRunId: stepRun._id,
		});
	}
	return { until };
}

/** Waiting step runs, the one checked longest ago first. */
function waitingQueue(ctx: MutationCtx, checkedBefore: number) {
	return ctx.db
		.query('automationStepRuns')
		.withIndex('by_status_and_waiting_checked_at', (q) =>
			q.eq('status', 'pending').gt('waitingCheckedAt', 0).lt('waitingCheckedAt', checkedBefore)
		);
}

/**
 * Take a waiting step run out of the queue and fire it now. A released one
 * (`isProbe` false) forgets its reason, so its mail going out does not start
 * another release; the probe keeps it, so its mail going out starts the first.
 */
async function fireWaitingStepRun(
	ctx: MutationCtx,
	stepRun: Doc<'automationStepRuns'>,
	isProbe: boolean
): Promise<void> {
	await ctx.db.patch(stepRun._id, {
		delayUntil: Date.now(),
		waitingCheckedAt: undefined,
		...(isProbe ? {} : { waitingFor: undefined }),
	});
	await ctx.scheduler.runAfter(0, internal.automations.stepWalker.executeStep, {
		automationRunId: stepRun.automationRunId,
		stepRunId: stepRun._id,
	});
}

/** Cron: re-run the waiting step checked longest ago. */
export const probeWaitingStepRun = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ probed: number }> => {
		const stepRun = await waitingQueue(ctx, Date.now() + 1).first();
		if (!stepRun) return { probed: 0 };
		await fireWaitingStepRun(ctx, stepRun, true);
		return { probed: 1 };
	},
});

/**
 * A waiting step's mail went out, so the sending setup is fixed: fire every
 * step that started waiting before `checkedBefore`, a batch per transaction.
 */
export const releaseWaitingStepRuns = internalMutation({
	args: { checkedBefore: v.number() },
	handler: async (ctx, args): Promise<{ released: number }> => {
		const batch = await waitingQueue(ctx, args.checkedBefore).take(RELEASE_BATCH);
		for (const stepRun of batch) await fireWaitingStepRun(ctx, stepRun, false);
		if (batch.length === RELEASE_BATCH) {
			await ctx.scheduler.runAfter(
				0,
				internal.automations.configurationWait.releaseWaitingStepRuns,
				{
					checkedBefore: args.checkedBefore,
				}
			);
		}
		return { released: batch.length };
	},
});

/** Start the release when a step that waited (and was not itself released) sent its mail. */
export async function releaseAfterWaitedSend(
	ctx: MutationCtx,
	stepRun: Doc<'automationStepRuns'>,
	emailSendId: string | undefined
): Promise<void> {
	if (stepRun.waitingFor === undefined || emailSendId === undefined) return;
	await ctx.scheduler.runAfter(0, internal.automations.configurationWait.releaseWaitingStepRuns, {
		checkedBefore: Date.now(),
	});
}
