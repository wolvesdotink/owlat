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
 * ends failed. A recovered email step whose Send already exists is completed
 * with that Send rather than decided again.
 *
 * CONTACT ELIGIBILITY. A soft-deleted or erased contact ends the run (the step
 * is skipped, the run cancelled). A contact who unsubscribed from marketing
 * only loses the mail: an email step is skipped and the run moves on to its
 * next step, so conditions, delays and plugin steps still run.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { MAX_RETRY_ATTEMPTS, RETRY_DELAYS_MS } from '../lib/constants';
import {
	contactMarketingIneligibility,
	marketingIneligibilityValidator,
} from '../lib/marketingEligibility';
import { findStepRunSend } from './stepRunSend';
import { logWarn } from '../lib/runtimeLog';
import {
	abandonPreUpgradeStepRun,
	cancelRun,
	completeSentStepAndAdvance,
	enterStep,
	failStepAndCancelRun,
	isTerminalStepRunStatus,
	recordSkippedSteps,
	skipStepAndCancelRun,
	skipUnsubscribedStepAndAdvance,
	transitionStepRun,
	PRE_UPGRADE_ABANDON_AFTER_MS,
	PRE_UPGRADE_ABANDONED_ERROR,
	type EnterStepResult,
} from './stepRunTransitions';

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
	| { kind: 'skipped'; reason: string }
	| { kind: 'ended'; reason: string };

/** Does `attempt` still own this step run? */
function ownsStepRun(stepRun: Doc<'automationStepRuns'>, attempt: number): boolean {
	return stepRun.status === 'executing' && (stepRun.retryCount ?? 0) === attempt;
}

export type StepRunGate =
	| {
			isOpen: true;
			run: Doc<'automationRuns'>;
			step: Doc<'automationSteps'>;
			contact: Doc<'contacts'>;
			automation: Doc<'automations'>;
	  }
	| { isOpen: false; isRunEnded: boolean; reason: string };

/**
 * Re-check, in the claiming transaction, that a step run may still run its
 * side effect: the run is running, the automation active, the step present and
 * the contact eligible. A closed gate has already written its outcome — the
 * step run skipped or failed, and the run cancelled or moved on — so the
 * caller only reports it. Also used by the v0.5.5 claim shim
 * (`stepExecutorQueries.markStepExecuting`).
 */
export async function gateStepRun(
	ctx: MutationCtx,
	stepRun: Doc<'automationStepRuns'>
): Promise<StepRunGate> {
	const run = await ctx.db.get(stepRun.automationRunId);
	if (!run || run.status !== 'running') {
		await transitionStepRun(ctx, stepRun, 'skipped', {
			completedAt: Date.now(),
			errorMessage: 'Automation run is no longer running',
			leaseExpiresAt: undefined,
		});
		return { isOpen: false, isRunEnded: true, reason: 'Run not running' };
	}

	const automation = await ctx.db.get(run.automationId);
	if (!automation || automation.status !== 'active') {
		await failStepAndCancelRun(ctx, stepRun, 'Automation is no longer active', {
			countRunFailure: false,
		});
		return { isOpen: false, isRunEnded: true, reason: 'Automation inactive' };
	}

	const step = await ctx.db.get(stepRun.automationStepId);
	if (!step) {
		await failStepAndCancelRun(ctx, stepRun, 'Step not found', { countRunFailure: false });
		return { isOpen: false, isRunEnded: true, reason: 'Step not found' };
	}

	const contact = await ctx.db.get(run.contactId);
	const ineligibility = contactMarketingIneligibility(contact);
	if (ineligibility === 'contact_deleted' || contact === null) {
		await skipStepAndCancelRun(ctx, stepRun, 'Contact is no longer eligible: contact_deleted');
		return { isOpen: false, isRunEnded: true, reason: 'Contact ineligible (contact_deleted)' };
	}
	if (ineligibility === 'contact_unsubscribed' && step.stepType === 'email') {
		await skipUnsubscribedStepAndAdvance(ctx, stepRun);
		return { isOpen: false, isRunEnded: false, reason: 'Contact unsubscribed; email skipped' };
	}

	return { isOpen: true, run, step, contact, automation };
}

/**
 * Claim `attempt` of a step run. Attempt 0 claims a `pending` row; attempt n>0
 * takes over an `executing` row owned by attempt n-1 (a scheduled retry or a
 * lease recovery). Anything else is a duplicate or stale firing and is dropped.
 *
 * A takeover of a row v0.5.5 claimed (no lease) more than
 * `PRE_UPGRADE_ABANDON_AFTER_MS` ago ends it and cancels the run without
 * running anything: that row was lost before the upgrade, not delayed.
 *
 * A takeover of an email step first looks for the Send an earlier attempt
 * enqueued: if it exists the side effect already happened, so the step is
 * completed with it and the run moves on, whatever changed since. Otherwise
 * the step's context is re-checked by {@link gateStepRun} before the side
 * effect may run.
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
			const emailSendId =
				stepRun.stepType === 'email' ? await findStepRunSend(ctx, stepRun._id) : null;
			if (
				isLegacyClaim &&
				now - (stepRun.startedAt ?? stepRun.scheduledAt) > PRE_UPGRADE_ABANDON_AFTER_MS
			) {
				await abandonPreUpgradeStepRun(ctx, stepRun, emailSendId);
				logWarn('[automations] abandoned a step run stuck since before the upgrade', {
					automationRunId: stepRun.automationRunId,
					stepRunId: stepRun._id,
				});
				return { kind: 'ended', reason: PRE_UPGRADE_ABANDONED_ERROR };
			}
			if (stepRun.stepType === 'email') {
				if (emailSendId !== null) {
					await completeSentStepAndAdvance(ctx, stepRun, emailSendId);
					return { kind: 'dropped' };
				}
			}
		}

		const gate = await gateStepRun(ctx, stepRun);
		if (!gate.isOpen) {
			return gate.isRunEnded
				? { kind: 'ended', reason: gate.reason }
				: { kind: 'skipped', reason: gate.reason };
		}
		const { run, step, contact, automation } = gate;

		if (args.attempt > MAX_RETRY_ATTEMPTS) {
			await failStepAndCancelRun(
				ctx,
				stepRun,
				'Step execution was interrupted and ran out of recovery attempts',
				{ countRunFailure: true }
			);
			return { kind: 'ended', reason: 'Retries exhausted' };
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
 * `contact_ineligible` outcome means the intake saw the contact change after
 * the claim: an unsubscribe skips the email step and moves the run on, a
 * deletion skips it and cancels the run.
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
			if (args.outcome.reason === 'contact_unsubscribed') {
				return await skipUnsubscribedStepAndAdvance(ctx, stepRun);
			}
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
 * `executing` step runs whose attempt was interrupted between two commits:
 *   - rows whose lease has expired, and
 *   - rows claimed without a lease (by v0.5.5's walker, before leases existed,
 *     or by its claim shim) that started more than a lease ago. Those rows are
 *     only the ones in flight across the upgrade, so the post-index filter
 *     reads a small range. A row that started more than
 *     `PRE_UPGRADE_ABANDON_AFTER_MS` ago is dispatched too, but its claim ends
 *     it without running the step (`abandonPreUpgradeStepRun`). Remove this
 *     half after release N+1, with the shims.
 */
export const getInterruptedStepRuns = internalQuery({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const expired = await ctx.db
			.query('automationStepRuns')
			.withIndex('by_status_and_lease_expires_at', (q) =>
				q.eq('status', 'executing').gt('leaseExpiresAt', 0).lte('leaseExpiresAt', now)
			)
			.take(RECOVERY_BATCH);
		if (expired.length === RECOVERY_BATCH) return expired;
		const legacyCutoff = now - STEP_LEASE_MS;
		const unleased = await ctx.db
			.query('automationStepRuns')
			.withIndex('by_status_and_lease_expires_at', (q) =>
				q.eq('status', 'executing').eq('leaseExpiresAt', undefined)
			)
			.filter((q) => q.lt(q.field('startedAt'), legacyCutoff))
			.take(RECOVERY_BATCH - expired.length);
		return [...expired, ...unleased];
	},
});
