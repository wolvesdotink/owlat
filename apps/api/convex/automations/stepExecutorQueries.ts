import { v } from 'convex/values';
import { internalQuery, type MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { bumpAutomationStats } from './statShards';

// ============== Denormalized step-run status counters ==============

type StepRunStatus = Doc<'automationStepRuns'>['status'];

/** One status counter's `±1` patch on an automationSteps row. */
function statDelta(
	step: Doc<'automationSteps'>,
	status: StepRunStatus,
	delta: number
): Partial<Doc<'automationSteps'>> {
	switch (status) {
		case 'pending':
			return { statPending: Math.max(0, (step.statPending ?? 0) + delta) };
		case 'executing':
			return { statExecuting: Math.max(0, (step.statExecuting ?? 0) + delta) };
		case 'completed':
			return { statCompleted: Math.max(0, (step.statCompleted ?? 0) + delta) };
		case 'failed':
			return { statFailed: Math.max(0, (step.statFailed ?? 0) + delta) };
		case 'skipped':
			return { statSkipped: Math.max(0, (step.statSkipped ?? 0) + delta) };
	}
}

/**
 * Maintain the denormalized per-status step-run counters on an automationSteps
 * row across a `from → to` transition (`from = null` for creation). Patches the
 * shared step row, so getStepAnalytics / getAutomationStats can read the funnel
 * off the bounded step rows instead of scanning every run × step-run.
 */
export async function applyStepStatusTransition(
	ctx: MutationCtx,
	automationStepId: Id<'automationSteps'>,
	from: StepRunStatus | null,
	to: StepRunStatus | null
): Promise<void> {
	if (from === to) return;
	const step = await ctx.db.get(automationStepId);
	if (!step) return;
	await ctx.db.patch(automationStepId, {
		...(from ? statDelta(step, from, -1) : {}),
		...(to ? statDelta(step, to, +1) : {}),
	});
}

/**
 * Insert a `pending` step run for `step` and count it. The step's kind is read
 * off the step row itself, so a run can never record a different kind than the
 * step it executes.
 */
export async function insertStepRun(
	ctx: MutationCtx,
	args: {
		automationRunId: Id<'automationRuns'>;
		step: Pick<Doc<'automationSteps'>, '_id' | 'stepIndex' | 'stepType'>;
		delayUntil: number | undefined;
	}
): Promise<Id<'automationStepRuns'>> {
	const stepRunId = await ctx.db.insert('automationStepRuns', {
		automationRunId: args.automationRunId,
		automationStepId: args.step._id,
		stepIndex: args.step.stepIndex,
		stepType: args.step.stepType,
		status: 'pending',
		scheduledAt: Date.now(),
		delayUntil: args.delayUntil,
		retryCount: 0,
	});
	await applyStepStatusTransition(ctx, args.step._id, null, 'pending');
	return stepRunId;
}

/**
 * Move a step run to `to`, patching `fields` and keeping the step counters in
 * step. Terminal step runs never move again: a late duplicate must not flip a
 * completed run to failed or count it twice.
 */
export async function transitionStepRun(
	ctx: MutationCtx,
	stepRun: Doc<'automationStepRuns'>,
	to: StepRunStatus,
	fields: Partial<Doc<'automationStepRuns'>> = {}
): Promise<boolean> {
	if (isTerminalStepRunStatus(stepRun.status)) return false;
	await ctx.db.patch(stepRun._id, { ...fields, status: to });
	await applyStepStatusTransition(ctx, stepRun.automationStepId, stepRun.status, to);
	return true;
}

export function isTerminalStepRunStatus(status: StepRunStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'skipped';
}

/**
 * Record terminal `skipped` step runs for the steps a forward condition branch
 * jumps over, `fromStepIndex` inclusive to `toStepIndex` exclusive.
 */
export async function recordSkippedSteps(
	ctx: MutationCtx,
	run: Pick<Doc<'automationRuns'>, '_id' | 'automationId'>,
	fromStepIndex: number,
	toStepIndex: number
): Promise<void> {
	const now = Date.now();
	for (let stepIndex = fromStepIndex; stepIndex < toStepIndex; stepIndex++) {
		const step = await ctx.db
			.query('automationSteps')
			.withIndex('by_automation_and_index', (q) =>
				q.eq('automationId', run.automationId).eq('stepIndex', stepIndex)
			)
			.first();
		if (!step) continue;

		await ctx.db.insert('automationStepRuns', {
			automationRunId: run._id,
			automationStepId: step._id,
			stepIndex,
			stepType: step.stepType,
			status: 'skipped',
			scheduledAt: now,
			completedAt: now,
			retryCount: 0,
		});
		await applyStepStatusTransition(ctx, step._id, null, 'skipped');
	}
}

/**
 * Finalize a still-running run as `completed`. A duplicate firing is a no-op, so
 * the shared statsActive (derived from entered − completed − cancelled) is never
 * decremented twice.
 */
export async function completeRun(
	ctx: MutationCtx,
	automationRunId: Id<'automationRuns'>
): Promise<void> {
	const run = await ctx.db.get(automationRunId);
	if (!run || run.status !== 'running') return;

	await ctx.db.patch(automationRunId, { status: 'completed', completedAt: Date.now() });
	await bumpAutomationStats(ctx, run.automationId, { statsCompleted: 1 });

	// A run completing successfully clears the circuit-breaker streak — only
	// CONSECUTIVE failures should trip it.
	const automation = await ctx.db.get(run.automationId);
	if (automation && (automation.consecutiveRunFailures ?? 0) > 0) {
		await ctx.db.patch(run.automationId, { consecutiveRunFailures: 0 });
	}
}

/** Finalize a still-running run as `cancelled` (see {@link completeRun}). */
export async function cancelRun(
	ctx: MutationCtx,
	automationRunId: Id<'automationRuns'>
): Promise<void> {
	const run = await ctx.db.get(automationRunId);
	if (!run || run.status !== 'running') return;

	await ctx.db.patch(automationRunId, { status: 'cancelled', completedAt: Date.now() });
	// Sharded counter — statsActive is derived by the rollup.
	await bumpAutomationStats(ctx, run.automationId, { statsCancelled: 1 });
}

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
