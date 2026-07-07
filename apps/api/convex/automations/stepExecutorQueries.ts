import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { bumpAutomationStats } from './statShards';

// ============== Denormalized step-run status counters ==============

type StepRunStatus = Doc<'automationStepRuns'>['status'];

/** One status counter's `±1` patch on an automationSteps row. */
function statDelta(
	step: Doc<'automationSteps'>,
	status: StepRunStatus,
	delta: number,
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
async function applyStepStatusTransition(
	ctx: MutationCtx,
	automationStepId: Id<'automationSteps'>,
	from: StepRunStatus | null,
	to: StepRunStatus | null,
): Promise<void> {
	if (from === to) return;
	const step = await ctx.db.get(automationStepId);
	if (!step) return;
	await ctx.db.patch(automationStepId, {
		...(from ? statDelta(step, from, -1) : {}),
		...(to ? statDelta(step, to, +1) : {}),
	});
}

// ============== Internal Queries ==============

// Get automation run with contact data
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

// Get automation step by automation and index
export const getAutomationStep = internalQuery({
	args: {
		automationId: v.id('automations'),
		stepIndex: v.number(),
	},
	handler: async (ctx, args) => {
		const step = await ctx.db
			.query('automationSteps')
			.withIndex('by_automation_and_index', (q) =>
				q.eq('automationId', args.automationId).eq('stepIndex', args.stepIndex)
			)
			.first();

		return step;
	},
});

// Get all steps for an automation
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
		const settings = await ctx.db
			.query('instanceSettings')
			.first();
		return settings;
	},
});

/** Per-tick cap for the pending-delay recovery sweep. */
export const PENDING_DELAY_BATCH = 200;

// Get pending delay step runs that are ready to execute. Capped per tick so a
// large coming-due cohort (thousands of contacts on the same "wait N days" step
// all maturing at once while the scheduler is backed up) can't blow the read /
// single-transaction fan-out budget; the walker reschedules itself to drain the
// rest, and the markStepExecuting CAS makes the re-fire idempotent.
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

// ============== Internal Mutations ==============

// Create an automation step run record
export const createStepRun = internalMutation({
	args: {
		automationRunId: v.id('automationRuns'),
		automationStepId: v.id('automationSteps'),
		stepIndex: v.number(),
		stepType: v.union(v.literal('email'), v.literal('delay'), v.literal('condition')),
		delayUntil: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const stepRunId = await ctx.db.insert('automationStepRuns', {
			automationRunId: args.automationRunId,
			automationStepId: args.automationStepId,
			stepIndex: args.stepIndex,
			stepType: args.stepType,
			status: 'pending',
			scheduledAt: now,
			delayUntil: args.delayUntil,
			retryCount: 0,
		});

		await applyStepStatusTransition(ctx, args.automationStepId, null, 'pending');
		return stepRunId;
	},
});

// Record terminal `skipped` step runs for the steps a condition branch jumps
// over. When a condition step branches forward (its target is beyond the next
// sequential index), the walker leaps straight to the target and the bypassed
// steps would otherwise leave no trace in the step funnel. Writing a `skipped`
// step run per bypassed step — and bumping that step's `statSkipped` counter —
// lets getStepAnalytics / getAutomationStats show what each contact actually
// skipped, instead of the count being permanently zero.
export const markStepsSkipped = internalMutation({
	args: {
		automationRunId: v.id('automationRuns'),
		fromStepIndex: v.number(), // first bypassed index (inclusive)
		toStepIndex: v.number(), // branch target index (exclusive) — not skipped
	},
	handler: async (ctx, args) => {
		// Only a strictly forward jump skips anything. A backward branch or a
		// sequential `+1` advance bypasses no intermediate steps.
		if (args.toStepIndex <= args.fromStepIndex) return;

		const run = await ctx.db.get(args.automationRunId);
		if (!run) return;

		const now = Date.now();
		for (let stepIndex = args.fromStepIndex; stepIndex < args.toStepIndex; stepIndex++) {
			const step = await ctx.db
				.query('automationSteps')
				.withIndex('by_automation_and_index', (q) =>
					q.eq('automationId', run.automationId).eq('stepIndex', stepIndex)
				)
				.first();
			if (!step) continue;

			await ctx.db.insert('automationStepRuns', {
				automationRunId: args.automationRunId,
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
	},
});

// Atomically claim a pending step run for execution.
//
// Two independent schedulers can target the same pending step: the original
// `runAfter(delayMs)` AND the `processPendingDelays` cron (which re-schedules
// any pending step whose delay has elapsed). Without an atomic guard both fire,
// the step executes twice, and a delay-gated email goes out twice. Claiming is
// therefore a single pending → executing CAS: only the first caller wins.
//
// It also enforces the per-run step-execution cap (loop protection): each claim
// bumps `automationRuns.stepsExecuted`, and the caller cancels the run when the
// returned count exceeds the cap (a backward-branching condition step would
// otherwise loop forever, re-sending on every pass).
export const markStepExecuting = internalMutation({
	args: {
		stepRunId: v.id('automationStepRuns'),
	},
	handler: async (ctx, args): Promise<{ claimed: boolean; stepsExecuted: number }> => {
		const stepRun = await ctx.db.get(args.stepRunId);
		if (!stepRun) return { claimed: false, stepsExecuted: 0 };

		const run = await ctx.db.get(stepRun.automationRunId);
		const currentCount = run?.stepsExecuted ?? 0;

		// Only a `pending` step can be claimed. A second invocation (cron vs.
		// original schedule) sees `executing`/`completed`/… and loses the race.
		if (stepRun.status !== 'pending') {
			return { claimed: false, stepsExecuted: currentCount };
		}

		await ctx.db.patch(args.stepRunId, {
			status: 'executing',
			startedAt: Date.now(),
		});
		await applyStepStatusTransition(ctx, stepRun.automationStepId, 'pending', 'executing');

		const stepsExecuted = currentCount + 1;
		if (run) {
			await ctx.db.patch(stepRun.automationRunId, { stepsExecuted });
		}

		return { claimed: true, stepsExecuted };
	},
});

// Mark step run as completed
export const markStepCompleted = internalMutation({
	args: {
		stepRunId: v.id('automationStepRuns'),
		emailSendId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const stepRun = await ctx.db.get(args.stepRunId);
		// Skip any already-terminal step run: a duplicate executeStep firing (the
		// runAfter scheduler vs the processPendingDelays cron both target one
		// pending step) must not flip a completed→failed / re-count it. Guarding
		// only `=== 'completed'` left the cross-terminal flip open.
		if (!stepRun || stepRun.status === 'completed' || stepRun.status === 'failed') return;
		await ctx.db.patch(args.stepRunId, {
			status: 'completed',
			completedAt: Date.now(),
			emailSendId: args.emailSendId,
		});
		await applyStepStatusTransition(ctx, stepRun.automationStepId, stepRun.status, 'completed');
	},
});

// Mark step run as failed
export const markStepFailed = internalMutation({
	args: {
		stepRunId: v.id('automationStepRuns'),
		errorMessage: v.string(),
		retryCount: v.number(),
	},
	handler: async (ctx, args) => {
		const stepRun = await ctx.db.get(args.stepRunId);
		// Skip any already-terminal step run (see markStepCompleted).
		if (!stepRun || stepRun.status === 'failed' || stepRun.status === 'completed') return;
		await ctx.db.patch(args.stepRunId, {
			status: 'failed',
			completedAt: Date.now(),
			errorMessage: args.errorMessage,
			retryCount: args.retryCount,
		});
		await applyStepStatusTransition(ctx, stepRun.automationStepId, stepRun.status, 'failed');
	},
});

// Update automation run to next step
export const advanceAutomationRun = internalMutation({
	args: {
		automationRunId: v.id('automationRuns'),
		nextStepIndex: v.number(),
		nextStepAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.automationRunId, {
			currentStepIndex: args.nextStepIndex,
			nextStepAt: args.nextStepAt,
		});
	},
});

// Complete the automation run
export const completeAutomationRun = internalMutation({
	args: {
		automationRunId: v.id('automationRuns'),
	},
	handler: async (ctx, args) => {
		const run = await ctx.db.get(args.automationRunId);
		// Only finalize a still-running run: a duplicate firing must not decrement
		// the shared automations.statsActive twice (which inflates the derived
		// `cancelled`/understates `running` in getAutomationStats).
		if (!run || run.status !== 'running') return;

		const now = Date.now();

		// Update the run status
		await ctx.db.patch(args.automationRunId, {
			status: 'completed',
			completedAt: now,
		});

		// Sharded counter — statsActive is derived (entered − completed − cancelled)
		// by the rollup, so we only bump completed here.
		await bumpAutomationStats(ctx, run.automationId, { statsCompleted: 1 });

		// A run completing successfully clears the circuit-breaker streak — only
		// CONSECUTIVE failures should trip it.
		const automation = await ctx.db.get(run.automationId);
		if (automation && (automation.consecutiveRunFailures ?? 0) > 0) {
			await ctx.db.patch(run.automationId, { consecutiveRunFailures: 0 });
		}
	},
});

// Cancel the automation run (e.g., on failure after max retries)
export const cancelAutomationRun = internalMutation({
	args: {
		automationRunId: v.id('automationRuns'),
	},
	handler: async (ctx, args) => {
		const run = await ctx.db.get(args.automationRunId);
		// Only finalize a still-running run (see completeAutomationRun) — prevents
		// double-decrementing statsActive on a duplicate firing.
		if (!run || run.status !== 'running') return;

		const now = Date.now();

		// Update the run status
		await ctx.db.patch(args.automationRunId, {
			status: 'cancelled',
			completedAt: now,
		});

		// Sharded counter — statsActive is derived by the rollup.
		await bumpAutomationStats(ctx, run.automationId, { statsCancelled: 1 });
	},
});
