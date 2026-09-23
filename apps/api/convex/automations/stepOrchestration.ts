/**
 * Step orchestration (module) — the transactional half of the automation step
 * walker. `stepWalker.ts` (a Node action) owns the one thing a mutation cannot
 * do, the step's SIDE EFFECT; every state change around it happens here, each
 * in a single mutation:
 *
 *   claimStepRun       — bind this attempt to the persisted step run, check the
 *                        run/automation/contact are still live, take the lease.
 *   finalizeStepRun    — complete the step, record skipped steps, advance the
 *                        run, create the next step run and schedule it. One
 *                        commit, so there is no state in which the run points
 *                        at a step whose step run was never created or never
 *                        scheduled.
 *   retryOrFailStepRun — persist the retry and schedule it together, or fail
 *                        the step, cancel the run and count the failure.
 *
 * STEP IDENTITY. Execution is bound to the step run, never to the run's mutable
 * `currentStepIndex`: the step executed is `stepRun.automationStepId`, and the
 * next index is computed from `stepRun.stepIndex`. A retry therefore always
 * re-executes the step it was created for.
 *
 * FENCING. `automationStepRuns.retryCount` is the attempt that owns an
 * `executing` step run. Every claim after the first advances it by one, and
 * finalize/retry calls carrying an older attempt are stale no-ops. Two firings
 * of the same attempt (a scheduled retry and a recovery sweep) race on the same
 * CAS and only one wins.
 *
 * RETRY vs RECOVERY. A step whose side effect FAILED is retried with backoff
 * (`retryOrFailStepRun`). An attempt that was INTERRUPTED — the action died
 * after the claim or after the side effect, before finalize committed — leaves
 * an `executing` row with a lease; once the lease expires the recovery sweep
 * (`stepWalker.processPendingDelays`) re-dispatches it as the next attempt.
 * Recovery re-runs the side effect, which is safe because it is idempotent per
 * step run: the email step's intake is keyed by the step run id, condition and
 * delay steps have no side effect, and plugin steps are at-least-once. Retries
 * and recoveries share one attempt budget, so a step that keeps dying still
 * ends failed.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { MAX_RETRY_ATTEMPTS, RETRY_DELAYS_MS } from '../lib/constants';
import {
	contactMarketingIneligibility,
	marketingIneligibilityValidator,
} from '../lib/marketingEligibility';
import { computeEntryDelay } from './steps';
import { recordAutomationRunFailure } from './lifecycle';
import {
	cancelRun,
	completeRun,
	insertStepRun,
	isTerminalStepRunStatus,
	recordSkippedSteps,
	transitionStepRun,
} from './stepExecutorQueries';

// Hard ceiling on step executions per automation run. A condition step may
// branch to an earlier step (the editor allows any target), so without a cap a
// cycle would loop forever and re-send the email step on every pass. 100 is far
// above any legitimate linear automation length.
export const MAX_STEPS_PER_RUN = 100;

/**
 * How long one attempt owns an `executing` step run before the recovery sweep
 * may take it over. Above the platform's action time limit, so an attempt that
 * is merely slow is never raced by its own recovery.
 */
export const STEP_LEASE_MS = 15 * 60 * 1000;

/** Per-tick cap for the interrupted-attempt recovery sweep. */
export const RECOVERY_BATCH = 200;

// ============== Shared transitions ==============

type EnterStepResult =
	| { kind: 'scheduled'; stepRunId: Id<'automationStepRuns'>; delayMs: number }
	| { kind: 'completed' };

/**
 * Point the run at `stepIndex`, create its step run and schedule it — or
 * complete the run when there is no such step. Scheduling from the mutation is
 * what makes this atomic: the scheduled call commits with the step run.
 */
async function enterStep(
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

/** Fail the step run and cancel its run, optionally counting a run failure. */
async function failStepAndCancelRun(
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
async function skipStepAndCancelRun(
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

/** Does `attempt` still own this step run? */
function ownsStepRun(stepRun: Doc<'automationStepRuns'>, attempt: number): boolean {
	return stepRun.status === 'executing' && (stepRun.retryCount ?? 0) === attempt;
}

// ============== Start ==============

export const beginAutomationRun = internalMutation({
	args: {
		automationRunId: v.id('automationRuns'),
	},
	handler: async (
		ctx,
		args
	): Promise<
		| EnterStepResult
		| { kind: 'not_found' }
		| { kind: 'already_started' }
		| { kind: 'automation_inactive' }
	> => {
		const run = await ctx.db.get(args.automationRunId);
		if (!run || run.status !== 'running') return { kind: 'not_found' };

		const automation = await ctx.db.get(run.automationId);
		if (!automation || automation.status !== 'active') {
			await cancelRun(ctx, run._id);
			return { kind: 'automation_inactive' };
		}

		// A duplicate start firing must not create a second first step.
		const existing = await ctx.db
			.query('automationStepRuns')
			.withIndex('by_automation_run', (q) => q.eq('automationRunId', run._id))
			.first();
		if (existing) return { kind: 'already_started' };

		return await enterStep(ctx, run, 0);
	},
});

// ============== Claim ==============

type ClaimResult =
	| {
			kind: 'claimed';
			step: Doc<'automationSteps'>;
			contact: Doc<'contacts'>;
			automation: Doc<'automations'>;
	  }
	| { kind: 'dropped' }
	| { kind: 'ended'; reason: string };

/**
 * Claim `attempt` of a step run. Attempt 0 claims a `pending` row; attempt n>0
 * takes over an `executing` row owned by attempt n-1 (a scheduled retry or a
 * lease recovery). Anything else is a duplicate or stale firing and is dropped.
 *
 * Before the side effect may run, the step's context is re-checked in this same
 * transaction: the run must still be running, the automation active, the step
 * present, and the contact still eligible for marketing. A contact that
 * unsubscribed or was deleted while the run waited ends the run here, as a
 * `skipped` step and a `cancelled` run, so the run counters stay right.
 */
export const claimStepRun = internalMutation({
	args: {
		stepRunId: v.id('automationStepRuns'),
		attempt: v.number(),
	},
	handler: async (ctx, args): Promise<ClaimResult> => {
		const stepRun = await ctx.db.get(args.stepRunId);
		if (!stepRun || isTerminalStepRunStatus(stepRun.status)) return { kind: 'dropped' };

		const now = Date.now();
		if (args.attempt === 0) {
			if (stepRun.status !== 'pending') return { kind: 'dropped' };
			// Never run a delayed step early. The firing scheduled for `delayUntil`
			// (or the sweep, once it is due) will claim it.
			if (stepRun.delayUntil !== undefined && stepRun.delayUntil > now) return { kind: 'dropped' };
		} else {
			if (stepRun.status !== 'executing') return { kind: 'dropped' };
			// Rows claimed before leases existed carry no attempt history; the
			// retry chain that owns them is adopted as-is.
			const isLegacyClaim = stepRun.leaseExpiresAt === undefined;
			if (!isLegacyClaim && (stepRun.retryCount ?? 0) !== args.attempt - 1) {
				return { kind: 'dropped' };
			}
		}

		const run = await ctx.db.get(stepRun.automationRunId);
		if (!run || run.status !== 'running') {
			await transitionStepRun(ctx, stepRun, 'skipped', {
				completedAt: now,
				errorMessage: 'Automation run is no longer running',
				leaseExpiresAt: undefined,
			});
			return { kind: 'ended', reason: 'Run not running' };
		}

		if (args.attempt > MAX_RETRY_ATTEMPTS) {
			await failStepAndCancelRun(
				ctx,
				stepRun,
				'Step execution was interrupted and ran out of recovery attempts',
				{ countRunFailure: true }
			);
			return { kind: 'ended', reason: 'Retries exhausted' };
		}

		const automation = await ctx.db.get(run.automationId);
		if (!automation || automation.status !== 'active') {
			await failStepAndCancelRun(ctx, stepRun, 'Automation is no longer active', {
				countRunFailure: false,
			});
			return { kind: 'ended', reason: 'Automation inactive' };
		}

		const step = await ctx.db.get(stepRun.automationStepId);
		if (!step) {
			await failStepAndCancelRun(ctx, stepRun, 'Step not found', { countRunFailure: false });
			return { kind: 'ended', reason: 'Step not found' };
		}

		const contact = await ctx.db.get(run.contactId);
		const ineligibility = contactMarketingIneligibility(contact);
		if (ineligibility !== null || contact === null) {
			await skipStepAndCancelRun(ctx, stepRun, `Contact is no longer eligible: ${ineligibility}`);
			return { kind: 'ended', reason: `Contact ineligible (${ineligibility})` };
		}

		if (stepRun.status === 'pending') {
			// Loop protection counts step executions, so only a first claim counts.
			const stepsExecuted = (run.stepsExecuted ?? 0) + 1;
			await ctx.db.patch(run._id, { stepsExecuted });
			if (stepsExecuted > MAX_STEPS_PER_RUN) {
				await failStepAndCancelRun(
					ctx,
					stepRun,
					`Automation exceeded ${MAX_STEPS_PER_RUN} step executions — cancelled to prevent a loop`,
					{ countRunFailure: false }
				);
				return { kind: 'ended', reason: 'Max steps exceeded' };
			}
			await transitionStepRun(ctx, stepRun, 'executing', {
				startedAt: now,
				retryCount: args.attempt,
				leaseExpiresAt: now + STEP_LEASE_MS,
			});
		} else {
			await ctx.db.patch(stepRun._id, {
				retryCount: args.attempt,
				leaseExpiresAt: now + STEP_LEASE_MS,
			});
		}

		return { kind: 'claimed', step, contact, automation };
	},
});

// ============== Finalize ==============

const stepOutcomeValidator = v.union(
	v.object({
		kind: v.literal('completed'),
		emailSendId: v.optional(v.string()),
		nextStepIndex: v.optional(v.number()),
	}),
	v.object({
		kind: v.literal('contact_ineligible'),
		reason: marketingIneligibilityValidator,
	})
);

/**
 * Commit a successful attempt: complete the step run, record the steps a
 * forward branch skipped, then enter the next step (or complete the run). A
 * `contact_ineligible` outcome (the intake saw the contact unsubscribe or be
 * deleted after the claim) skips the step and cancels the run instead.
 */
export const finalizeStepRun = internalMutation({
	args: {
		stepRunId: v.id('automationStepRuns'),
		attempt: v.number(),
		outcome: stepOutcomeValidator,
	},
	handler: async (
		ctx,
		args
	): Promise<
		EnterStepResult | { kind: 'stale' } | { kind: 'cancelled' } | { kind: 'run_ended' }
	> => {
		const stepRun = await ctx.db.get(args.stepRunId);
		if (!stepRun || !ownsStepRun(stepRun, args.attempt)) return { kind: 'stale' };

		if (args.outcome.kind === 'contact_ineligible') {
			await skipStepAndCancelRun(
				ctx,
				stepRun,
				`Contact is no longer eligible: ${args.outcome.reason}`
			);
			return { kind: 'cancelled' };
		}

		await transitionStepRun(ctx, stepRun, 'completed', {
			completedAt: Date.now(),
			emailSendId: args.outcome.emailSendId,
			leaseExpiresAt: undefined,
		});

		const run = await ctx.db.get(stepRun.automationRunId);
		if (!run || run.status !== 'running') return { kind: 'run_ended' };

		const nextStepIndex = args.outcome.nextStepIndex ?? stepRun.stepIndex + 1;
		if (nextStepIndex > stepRun.stepIndex + 1) {
			await recordSkippedSteps(ctx, run, stepRun.stepIndex + 1, nextStepIndex);
		}
		return await enterStep(ctx, run, nextStepIndex);
	},
});

// ============== Retry ==============

/**
 * A failed side effect: schedule the next attempt with backoff (the retry and
 * its lease extension commit together), or — once the budget is spent — fail
 * the step, cancel the run and count the failure toward the circuit breaker.
 */
export const retryOrFailStepRun = internalMutation({
	args: {
		stepRunId: v.id('automationStepRuns'),
		attempt: v.number(),
		errorMessage: v.string(),
	},
	handler: async (
		ctx,
		args
	): Promise<{ kind: 'retrying'; delayMs: number } | { kind: 'failed' } | { kind: 'stale' }> => {
		const stepRun = await ctx.db.get(args.stepRunId);
		if (!stepRun || !ownsStepRun(stepRun, args.attempt)) return { kind: 'stale' };

		if (args.attempt < MAX_RETRY_ATTEMPTS) {
			const delayMs = RETRY_DELAYS_MS[args.attempt] ?? 30_000;
			await ctx.db.patch(stepRun._id, {
				errorMessage: args.errorMessage,
				// The scheduled retry must claim before recovery may.
				leaseExpiresAt: Date.now() + delayMs + STEP_LEASE_MS,
			});
			await ctx.scheduler.runAfter(delayMs, internal.automations.stepWalker.executeStep, {
				automationRunId: stepRun.automationRunId,
				stepRunId: stepRun._id,
				retryCount: args.attempt + 1,
			});
			return { kind: 'retrying', delayMs };
		}

		await failStepAndCancelRun(ctx, stepRun, args.errorMessage, { countRunFailure: true });
		return { kind: 'failed' };
	},
});

// ============== Recovery ==============

/**
 * `executing` step runs whose lease has expired: attempts interrupted between
 * two commits. Rows without a lease (claimed before leases existed) are
 * excluded by the lower bound.
 */
export const getInterruptedStepRuns = internalQuery({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		return await ctx.db
			.query('automationStepRuns')
			.withIndex('by_status_and_lease_expires_at', (q) =>
				q.eq('status', 'executing').gt('leaseExpiresAt', 0).lte('leaseExpiresAt', now)
			)
			.take(RECOVERY_BATCH);
	},
});
