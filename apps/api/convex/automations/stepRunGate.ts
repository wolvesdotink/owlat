/**
 * Step run gate (helper) — whether a step run may still run its side effect,
 * and the outcome to write when it may not.
 *
 * Checked twice for an email step: by the claim (`stepOrchestration.ts`), and
 * again by the non-campaign intake in the transaction that writes the Send
 * (`delivery/nonCampaignIntake.ts`). The worker re-checks the contact and the
 * automation once more before dispatch (`delivery/marketingDispatchGate.ts`),
 * and withdraws the queued mail of an automation paused since. Between the
 * first two the email step reads its
 * template and the default sender and personalizes the mail in an action, and a
 * pause, a deletion or a removed step landing in that window must still stop
 * the mail. The intake checks only the run, the automation and the step: it
 * gates the contact itself, at the marketing scope, and its refusal leads the
 * walker to the same outcome the contact half below writes.
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import {
	automationTopicIneligibility,
	contactMarketingIneligibility,
} from '../lib/marketingEligibility';
import {
	failStepAndCancelRun,
	isTerminalStepRunStatus,
	skipIneligibleEmailStepAndAdvance,
	skipStepAndCancelRun,
	transitionStepRun,
} from './stepRunTransitions';

type ContextGate =
	| {
			isOpen: true;
			run: Doc<'automationRuns'>;
			step: Doc<'automationSteps'>;
			automation: Doc<'automations'>;
	  }
	| { isOpen: false; reason: string };

export type StepRunGate =
	| (Extract<ContextGate, { isOpen: true }> & { contact: Doc<'contacts'> })
	| { isOpen: false; isRunEnded: boolean; reason: string };

/**
 * The run is running, the automation active and the step present. A closed gate
 * has already ended the step run and the run, without counting a failure: the
 * step did not fail, its context went away.
 */
async function gateStepRunContext(
	ctx: MutationCtx,
	stepRun: Doc<'automationStepRuns'>
): Promise<ContextGate> {
	const run = await ctx.db.get(stepRun.automationRunId);
	if (!run || run.status !== 'running') {
		await transitionStepRun(ctx, stepRun, 'skipped', {
			completedAt: Date.now(),
			errorMessage: 'Automation run is no longer running',
			leaseExpiresAt: undefined,
		});
		return { isOpen: false, reason: 'Run not running' };
	}

	// A deleted or reverted automation is never `active`, and its steps can only
	// be edited while it is a draft, so this also covers a deletion and an edit.
	const automation = await ctx.db.get(run.automationId);
	if (!automation || automation.status !== 'active') {
		await failStepAndCancelRun(ctx, stepRun, 'Automation is no longer active', {
			countRunFailure: false,
			stepFault: false,
		});
		return { isOpen: false, reason: 'Automation inactive' };
	}

	const step = await ctx.db.get(stepRun.automationStepId);
	if (!step) {
		await failStepAndCancelRun(ctx, stepRun, 'Step not found', {
			countRunFailure: false,
			stepFault: false,
		});
		return { isOpen: false, reason: 'Step not found' };
	}

	return { isOpen: true, run, step, automation };
}

/**
 * The claim's gate: {@link gateStepRunContext}, then the contact is eligible:
 * not deleted, and for an email step neither unsubscribed from all marketing
 * nor out of the automation's topic. The global unsubscribe is checked first,
 * so it is the reason a contact who did both is recorded with. A
 * closed gate has already written its outcome (the step run skipped or failed,
 * and the run cancelled or moved on), so the caller only reports it.
 */
export async function gateStepRun(
	ctx: MutationCtx,
	stepRun: Doc<'automationStepRuns'>
): Promise<StepRunGate> {
	const gate = await gateStepRunContext(ctx, stepRun);
	if (!gate.isOpen) return { isOpen: false, isRunEnded: true, reason: gate.reason };

	const contact = await ctx.db.get(gate.run.contactId);
	const ineligibility = contactMarketingIneligibility(contact);
	if (ineligibility === 'contact_deleted' || contact === null) {
		await skipStepAndCancelRun(ctx, stepRun, 'Contact is no longer eligible: contact_deleted');
		return { isOpen: false, isRunEnded: true, reason: 'Contact ineligible (contact_deleted)' };
	}
	if (gate.step.stepType === 'email') {
		if (ineligibility === 'contact_unsubscribed') {
			await skipIneligibleEmailStepAndAdvance(ctx, stepRun, { reason: 'contact_unsubscribed' });
			return { isOpen: false, isRunEnded: false, reason: 'Contact unsubscribed; email skipped' };
		}
		const leftTopic = await automationTopicIneligibility(ctx, gate.automation, contact);
		if (leftTopic !== null) {
			await skipIneligibleEmailStepAndAdvance(ctx, stepRun, leftTopic);
			return { isOpen: false, isRunEnded: false, reason: 'Contact left the topic; email skipped' };
		}
	}

	return { ...gate, contact };
}

/**
 * The intake's re-check for an email step run that has no Send yet: why it must
 * not send now, or `null` when it may. A step run that is gone (its run was
 * deleted) or already ended sends nothing either; neither has an outcome left
 * to write. Not checked for ownership: only the attempt that holds the claim
 * reaches the intake before the lease runs out.
 */
export async function stepRunEndedBeforeSend(
	ctx: MutationCtx,
	stepRunId: Id<'automationStepRuns'>
): Promise<string | null> {
	const stepRun = await ctx.db.get(stepRunId);
	if (!stepRun) return 'Step run not found';
	if (isTerminalStepRunStatus(stepRun.status)) return 'Step run already ended';
	const gate = await gateStepRunContext(ctx, stepRun);
	return gate.isOpen ? null : gate.reason;
}
