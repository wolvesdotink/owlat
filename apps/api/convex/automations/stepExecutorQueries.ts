import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { stepKindValidator } from './steps/catalog';
import { gateStepRun } from './stepOrchestration';
import {
	activeStepRunOf,
	cancelRun,
	completeRun,
	insertStepRun,
	isTerminalStepRunStatus,
	recentStepRunsOf,
	recordSkippedSteps,
	transitionStepRun,
} from './stepRunTransitions';

// ============== Internal Queries ==============

// Get email template for step execution
export const getEmailTemplateForStep = internalQuery({
	args: {
		templateId: v.id('emailTemplates'),
	},
	handler: async (ctx, args) => {
		return await ctx.db.get(args.templateId);
	},
});

// Get instance settings for sender information
export const getInstanceSettings = internalQuery({
	args: {},
	handler: async (ctx) => {
		const settings = await ctx.db.query('instanceSettings').first();
		return settings;
	},
});

/** Per-tick cap for the pending-delay recovery sweep. */
export const PENDING_DELAY_BATCH = 200;

// Get pending delay step runs that are ready to execute. Capped per tick so a
// large coming-due cohort (thousands of contacts on the same "wait N days" step
// all maturing at once while the scheduler is backed up) can't blow the read /
// single-transaction fan-out budget; the walker reschedules itself to drain the
// rest, and the claimStepRun CAS makes the re-fire idempotent.
export const getPendingDelayStepRuns = internalQuery({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const pendingRuns = await ctx.db
			.query('automationStepRuns')
			.withIndex('by_status_and_delay_until', (q) =>
				q.eq('status', 'pending').lte('delayUntil', now)
			)
			.take(PENDING_DELAY_BATCH);

		return pendingRuns;
	},
});

// ============== v0.5.5 compatibility shims — remove after release N+1 ==============
//
// v0.5.5's step walker drove every step through the single-transition
// functions below, called from its `executeStep` / `startAutomationRun` actions
// with ctx.runQuery / ctx.runMutation. An action that is running when this
// release deploys finishes on v0.5.5's code, but each of those calls resolves
// against the NEW deployment. So they stay for one release, at their original
// paths with their original argument and result shapes (see CONVENTIONS.md,
// "Old clients and workers against new functions"), delegating to the walker's
// current transitions (`stepRunTransitions.ts`).
//
// None of them may fight the new orchestration, which can take a legacy
// attempt over (the recovery sweep adopts an `executing` row without a lease):
//   - a step run holding a lease belongs to a new attempt, so the legacy
//     completion and failure leave it alone;
//   - a run with an active (pending or executing) step run has been moved on
//     by the new walker, so the legacy advance, skip, create, complete and
//     cancel calls are no-ops against it. The legacy walker only calls them
//     after ending its own step run, when the run has no active step run.
// The rows the legacy walker claims carry no lease, so an action that dies
// mid-step is recovered by `getInterruptedStepRuns`, and a run it leaves with
// no active step run by `stalledRuns.sweepStalledRuns`.

/** Remove after release N+1: v0.5.5 compatibility (see the section comment above). */
export const getAutomationRunWithContact = internalQuery({
	args: {
		automationRunId: v.id('automationRuns'),
	},
	handler: async (ctx, args) => {
		const run = await ctx.db.get(args.automationRunId);
		if (!run) return null;
		const contact = await ctx.db.get(run.contactId);
		if (!contact) return null;
		const automation = await ctx.db.get(run.automationId);
		if (!automation) return null;
		return { run, contact, automation };
	},
});

/** Remove after release N+1: v0.5.5 compatibility (see the section comment above). */
export const getAutomationStep = internalQuery({
	args: {
		automationId: v.id('automations'),
		stepIndex: v.number(),
	},
	handler: async (ctx, args) => {
		return await ctx.db
			.query('automationSteps')
			.withIndex('by_automation_and_index', (q) =>
				q.eq('automationId', args.automationId).eq('stepIndex', args.stepIndex)
			)
			.first();
	},
});

/** Remove after release N+1: v0.5.5 compatibility (see the section comment above). */
export const getAutomationSteps = internalQuery({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
		const steps = await ctx.db
			.query('automationSteps')
			.withIndex('by_automation', (q) => q.eq('automationId', args.automationId))
			.collect(); // bounded: one automation's steps
		return steps.sort((a, b) => a.stepIndex - b.stepIndex);
	},
});

/** True when the legacy walker may still move `automationRunId` itself. */
async function isLegacyAdvanceAllowed(
	ctx: MutationCtx,
	automationRunId: Id<'automationRuns'>
): Promise<boolean> {
	const run = await ctx.db.get(automationRunId);
	if (!run || run.status !== 'running') return false;
	return (await activeStepRunOf(ctx, automationRunId)) === null;
}

/** A legacy completion or failure may only end a step run no new attempt owns. */
function isLegacyOwned(
	stepRun: Doc<'automationStepRuns'> | null
): stepRun is Doc<'automationStepRuns'> {
	return (
		stepRun !== null &&
		!isTerminalStepRunStatus(stepRun.status) &&
		stepRun.leaseExpiresAt === undefined
	);
}

/**
 * Remove after release N+1: v0.5.5 compatibility (see the section comment
 * above). When the run already has an active step run (the new walker moved
 * it on), that one is returned instead of a second: the legacy caller only
 * schedules `executeStep` for it, which the claim's CAS makes harmless.
 */
export const createStepRun = internalMutation({
	args: {
		automationRunId: v.id('automationRuns'),
		automationStepId: v.id('automationSteps'),
		stepIndex: v.number(),
		stepType: stepKindValidator,
		delayUntil: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<Id<'automationStepRuns'>> => {
		const active = await activeStepRunOf(ctx, args.automationRunId);
		if (active) return active._id;
		const run = await ctx.db.get(args.automationRunId);
		const step = await ctx.db.get(args.automationStepId);
		if (!run || run.status !== 'running' || !step) {
			// Nothing to create; hand back the run's last step run, which the
			// scheduled claim drops as terminal.
			const [latest] = await recentStepRunsOf(ctx, args.automationRunId);
			if (latest) return latest._id;
			throw new Error('Automation run has ended; no step run to create');
		}
		return await insertStepRun(ctx, {
			automationRunId: args.automationRunId,
			step,
			delayUntil: args.delayUntil,
		});
	},
});

/** Remove after release N+1: v0.5.5 compatibility (see the section comment above). */
export const markStepsSkipped = internalMutation({
	args: {
		automationRunId: v.id('automationRuns'),
		fromStepIndex: v.number(),
		toStepIndex: v.number(),
	},
	handler: async (ctx, args) => {
		if (args.toStepIndex <= args.fromStepIndex) return;
		if (!(await isLegacyAdvanceAllowed(ctx, args.automationRunId))) return;
		const run = await ctx.db.get(args.automationRunId);
		if (run) await recordSkippedSteps(ctx, run, args.fromStepIndex, args.toStepIndex);
	},
});

/**
 * Remove after release N+1: v0.5.5 compatibility (see the section comment
 * above). The legacy claim: pending → executing with no lease, counting the
 * step execution. The step's context is re-checked like a new claim's
 * (`gateStepRun`), so a legacy action honours contact deletion and
 * unsubscribe too; a closed gate reports `claimed: false`, which the legacy
 * caller treats as a duplicate and drops.
 */
export const markStepExecuting = internalMutation({
	args: {
		stepRunId: v.id('automationStepRuns'),
	},
	handler: async (ctx, args): Promise<{ claimed: boolean; stepsExecuted: number }> => {
		const stepRun = await ctx.db.get(args.stepRunId);
		if (!stepRun) return { claimed: false, stepsExecuted: 0 };
		const run = await ctx.db.get(stepRun.automationRunId);
		const currentCount = run?.stepsExecuted ?? 0;
		const now = Date.now();
		if (stepRun.status !== 'pending' || (stepRun.delayUntil ?? 0) > now) {
			return { claimed: false, stepsExecuted: currentCount };
		}
		const gate = await gateStepRun(ctx, stepRun);
		if (!gate.isOpen) return { claimed: false, stepsExecuted: currentCount };

		await transitionStepRun(ctx, stepRun, 'executing', { startedAt: now });
		const stepsExecuted = currentCount + 1;
		await ctx.db.patch(gate.run._id, { stepsExecuted });
		return { claimed: true, stepsExecuted };
	},
});

/**
 * Remove after release N+1: v0.5.5 compatibility (see the section comment
 * above). v0.5.5 enqueued its Send without the step-run key; completing the
 * step stamps the key on it, so `findStepRunSend`'s fallback for unkeyed Sends
 * can never mistake it for a later step's.
 */
export const markStepCompleted = internalMutation({
	args: {
		stepRunId: v.id('automationStepRuns'),
		emailSendId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const stepRun = await ctx.db.get(args.stepRunId);
		const sendId =
			args.emailSendId === undefined
				? null
				: ctx.db.normalizeId('transactionalSends', args.emailSendId);
		const send = sendId === null ? null : await ctx.db.get(sendId);
		if (send && send.automationStepRunId === undefined) {
			await ctx.db.patch(send._id, { automationStepRunId: args.stepRunId });
		}
		if (!isLegacyOwned(stepRun)) return;
		await transitionStepRun(ctx, stepRun, 'completed', {
			completedAt: Date.now(),
			emailSendId: args.emailSendId,
		});
	},
});

/** Remove after release N+1: v0.5.5 compatibility (see the section comment above). */
export const markStepFailed = internalMutation({
	args: {
		stepRunId: v.id('automationStepRuns'),
		errorMessage: v.string(),
		retryCount: v.number(),
	},
	handler: async (ctx, args) => {
		const stepRun = await ctx.db.get(args.stepRunId);
		if (!isLegacyOwned(stepRun)) return;
		await transitionStepRun(ctx, stepRun, 'failed', {
			completedAt: Date.now(),
			errorMessage: args.errorMessage,
			retryCount: args.retryCount,
		});
	},
});

/** Remove after release N+1: v0.5.5 compatibility (see the section comment above). */
export const advanceAutomationRun = internalMutation({
	args: {
		automationRunId: v.id('automationRuns'),
		nextStepIndex: v.number(),
		nextStepAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		if (!(await isLegacyAdvanceAllowed(ctx, args.automationRunId))) return;
		await ctx.db.patch(args.automationRunId, {
			currentStepIndex: args.nextStepIndex,
			nextStepAt: args.nextStepAt,
		});
	},
});

/** Remove after release N+1: v0.5.5 compatibility (see the section comment above). */
export const completeAutomationRun = internalMutation({
	args: {
		automationRunId: v.id('automationRuns'),
	},
	handler: async (ctx, args) => {
		if (!(await isLegacyAdvanceAllowed(ctx, args.automationRunId))) return;
		await completeRun(ctx, args.automationRunId);
	},
});

/** Remove after release N+1: v0.5.5 compatibility (see the section comment above). */
export const cancelAutomationRun = internalMutation({
	args: {
		automationRunId: v.id('automationRuns'),
	},
	handler: async (ctx, args) => {
		if (!(await isLegacyAdvanceAllowed(ctx, args.automationRunId))) return;
		await cancelRun(ctx, args.automationRunId);
	},
});
