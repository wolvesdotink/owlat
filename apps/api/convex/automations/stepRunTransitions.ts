/**
 * Step-run and run transitions (helpers) — every state change the automation
 * step walker makes, as plain functions over a mutation context. The walker's
 * mutations (`stepOrchestration.ts`), the stalled-run sweep (`stalledRuns.ts`),
 * run deletion (`runDeletion.ts`) and the one-release compatibility shims in
 * `stepExecutorQueries.ts` all go through these, so the counter arithmetic and
 * the "a terminal row never moves again" rule live in one place.
 */

import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { computeEntryDelay } from './steps';
import { recordAutomationRunFailure } from './lifecycle';
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

// ============== Step runs ==============

export function isTerminalStepRunStatus(status: StepRunStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'skipped';
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

/** How many of a run's newest step runs {@link recentStepRunsOf} reads. */
const RECENT_STEP_RUNS = 4;

/**
 * A run's newest step runs, newest first. A run has at most one non-terminal
 * step run, and it is always among the newest: forward-branch `skipped` rows
 * are written before the step run that is entered after them.
 */
export async function recentStepRunsOf(
	ctx: MutationCtx,
	automationRunId: Id<'automationRuns'>
): Promise<Doc<'automationStepRuns'>[]> {
	return await ctx.db
		.query('automationStepRuns')
		.withIndex('by_automation_run', (q) => q.eq('automationRunId', automationRunId))
		.order('desc')
		.take(RECENT_STEP_RUNS);
}

/** The run's pending or executing step run, if it has one. */
export async function activeStepRunOf(
	ctx: MutationCtx,
	automationRunId: Id<'automationRuns'>
): Promise<Doc<'automationStepRuns'> | null> {
	const recent = await recentStepRunsOf(ctx, automationRunId);
	return recent.find((stepRun) => !isTerminalStepRunStatus(stepRun.status)) ?? null;
}

// ============== Runs ==============

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

// ============== Walker transitions ==============

export type EnterStepResult =
	| { kind: 'scheduled'; stepRunId: Id<'automationStepRuns'>; delayMs: number }
	| { kind: 'completed' };

/**
 * Point the run at `stepIndex`, create its step run and schedule it — or
 * complete the run when there is no such step. Scheduling from the mutation is
 * what makes this atomic: the scheduled call commits with the step run.
 */
export async function enterStep(
	ctx: MutationCtx,
	run: Doc<'automationRuns'>,
	stepIndex: number
): Promise<EnterStepResult> {
	const step = await ctx.db
		.query('automationSteps')
		.withIndex('by_automation_and_index', (q) =>
			q.eq('automationId', run.automationId).eq('stepIndex', stepIndex)
		)
		.first();
	if (!step) {
		await completeRun(ctx, run._id);
		return { kind: 'completed' };
	}

	const delayMs = computeEntryDelay(step);
	const delayUntil = delayMs > 0 ? Date.now() + delayMs : undefined;
	await ctx.db.patch(run._id, { currentStepIndex: stepIndex, nextStepAt: delayUntil });
	const stepRunId = await insertStepRun(ctx, { automationRunId: run._id, step, delayUntil });
	await ctx.scheduler.runAfter(delayMs, internal.automations.stepWalker.executeStep, {
		automationRunId: run._id,
		stepRunId,
	});
	return { kind: 'scheduled', stepRunId, delayMs };
}

/**
 * End a step run in `status` and, if its run is still running, enter the step
 * after it. For steps that never branch (an email step), so the next index is
 * always the following one.
 */
async function endStepAndAdvance(
	ctx: MutationCtx,
	stepRun: Doc<'automationStepRuns'>,
	status: 'completed' | 'skipped',
	fields: Partial<Doc<'automationStepRuns'>>
): Promise<EnterStepResult | { kind: 'run_ended' }> {
	await transitionStepRun(ctx, stepRun, status, {
		...fields,
		completedAt: Date.now(),
		leaseExpiresAt: undefined,
	});
	const run = await ctx.db.get(stepRun.automationRunId);
	if (!run || run.status !== 'running') return { kind: 'run_ended' };
	return await enterStep(ctx, run, stepRun.stepIndex + 1);
}

/**
 * Complete an email step whose Send already exists (an earlier attempt enqueued
 * it before it was interrupted) and move the run on.
 */
export function completeSentStepAndAdvance(
	ctx: MutationCtx,
	stepRun: Doc<'automationStepRuns'>,
	emailSendId: Id<'transactionalSends'>
): Promise<EnterStepResult | { kind: 'run_ended' }> {
	return endStepAndAdvance(ctx, stepRun, 'completed', { emailSendId });
}

/**
 * Skip an email step for a contact who unsubscribed from marketing, and move
 * the run on: an unsubscribe stops the mail, not the automation's other steps.
 */
export function skipUnsubscribedStepAndAdvance(
	ctx: MutationCtx,
	stepRun: Doc<'automationStepRuns'>
): Promise<EnterStepResult | { kind: 'run_ended' }> {
	return endStepAndAdvance(ctx, stepRun, 'skipped', {
		errorMessage: 'Contact unsubscribed from marketing; email step skipped',
	});
}

/** Fail the step run and cancel its run, optionally counting a run failure. */
export async function failStepAndCancelRun(
	ctx: MutationCtx,
	stepRun: Doc<'automationStepRuns'>,
	errorMessage: string,
	options: { countRunFailure: boolean }
): Promise<void> {
	await transitionStepRun(ctx, stepRun, 'failed', {
		completedAt: Date.now(),
		errorMessage,
		leaseExpiresAt: undefined,
	});
	await cancelRun(ctx, stepRun.automationRunId);
	if (options.countRunFailure) {
		const run = await ctx.db.get(stepRun.automationRunId);
		if (run) await recordAutomationRunFailure(ctx, run.automationId);
	}
}

/** Skip the step run (it never ran its side effect) and cancel its run. */
export async function skipStepAndCancelRun(
	ctx: MutationCtx,
	stepRun: Doc<'automationStepRuns'>,
	errorMessage: string
): Promise<void> {
	await transitionStepRun(ctx, stepRun, 'skipped', {
		completedAt: Date.now(),
		errorMessage,
		leaseExpiresAt: undefined,
	});
	await cancelRun(ctx, stepRun.automationRunId);
}
