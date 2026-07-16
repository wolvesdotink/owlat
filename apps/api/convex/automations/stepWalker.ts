'use node';

import { v } from 'convex/values';
import { MAX_RETRY_ATTEMPTS, RETRY_DELAYS_MS } from '../lib/constants';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { stepModuleFor, computeEntryDelay } from './steps';
import { isPluginStepKind, type CoreStepKind } from './steps/catalog';
import { executePluginStep } from './steps/pluginStep';
import { PENDING_DELAY_BATCH } from './stepExecutorQueries';
import type { StepOutcome } from './types';

// ============== Retry policy ==============

// Retry configuration lives in lib/constants.

// Hard ceiling on step executions per automation run. A condition step may
// branch to an earlier step (the editor allows any target), so without a cap a
// cycle would loop forever and re-send the email step on every pass. 100 is far
// above any legitimate linear automation length.
const MAX_STEPS_PER_RUN = 100;

// ============== Re-exports (compat) ==============

// Some test code imports these from the old `stepExecutor` path. They live
// in per-module files now; re-export from here so the walker continues to be
// the single entry point for callers that don't care about per-module
// internals.
export { delayConfigToMs } from './steps/delay';

// ============== Shared helpers ==============

interface ExecuteStepResult {
	success: boolean;
	error?: string;
	completed?: boolean;
	nextStepScheduled?: boolean;
	delayMs?: number;
	retrying?: boolean;
	cancelled?: boolean;
}

/**
 * Advance to the next step in an automation run: schedule it, or mark the
 * run completed if the index is past the end. Uses the next step's module
 * `entryDelay` to compute the scheduling delay — no `if (step.kind === ...)`
 * branching at the walker layer.
 *
 * `currentStepIndex` is the index of the step that just finished. When a
 * condition step branches forward (`nextStepIndex` is beyond the sequential
 * `currentStepIndex + 1`), the steps in between are recorded as `skipped` step
 * runs so the analytics funnel reflects what each contact bypassed.
 */
async function advanceToStep(
	ctx: ActionCtx,
	automationRunId: Id<'automationRuns'>,
	currentStepIndex: number,
	nextStepIndex: number,
	allSteps: Doc<'automationSteps'>[]
): Promise<ExecuteStepResult> {
	// Record `skipped` rows for any steps a forward condition branch jumped over.
	if (nextStepIndex > currentStepIndex + 1) {
		await ctx.runMutation(internal.automations.stepExecutorQueries.markStepsSkipped, {
			automationRunId,
			fromStepIndex: currentStepIndex + 1,
			toStepIndex: nextStepIndex,
		});
	}

	if (nextStepIndex >= allSteps.length) {
		await ctx.runMutation(internal.automations.stepExecutorQueries.completeAutomationRun, {
			automationRunId,
		});
		return { success: true, completed: true };
	}

	const nextStep = allSteps.find((s) => s.stepIndex === nextStepIndex);
	if (!nextStep) {
		await ctx.runMutation(internal.automations.stepExecutorQueries.completeAutomationRun, {
			automationRunId,
		});
		return { success: true, completed: true };
	}

	const delayMs = computeEntryDelay(nextStep);
	const nextStepAt = delayMs > 0 ? Date.now() + delayMs : undefined;

	await ctx.runMutation(internal.automations.stepExecutorQueries.advanceAutomationRun, {
		automationRunId,
		nextStepIndex,
		nextStepAt,
	});

	const nextStepRunId = await ctx.runMutation(
		internal.automations.stepExecutorQueries.createStepRun,
		{
			automationRunId,
			automationStepId: nextStep._id,
			stepIndex: nextStepIndex,
			stepType: nextStep.stepType,
			delayUntil: nextStepAt,
		}
	);

	await ctx.scheduler.runAfter(delayMs, internal.automations.stepWalker.executeStep, {
		automationRunId,
		stepRunId: nextStepRunId,
	});

	return { success: true, nextStepScheduled: true, delayMs };
}

// ============== Main action: execute one step ==============

export const executeStep = internalAction({
	args: {
		automationRunId: v.id('automationRuns'),
		stepRunId: v.id('automationStepRuns'),
		retryCount: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<ExecuteStepResult> => {
		const retryCount = args.retryCount ?? 0;

		const runData = await ctx.runQuery(
			internal.automations.stepExecutorQueries.getAutomationRunWithContact,
			{ automationRunId: args.automationRunId }
		);

		if (!runData) {
			await ctx.runMutation(internal.automations.stepExecutorQueries.markStepFailed, {
				stepRunId: args.stepRunId,
				errorMessage: 'Automation run or contact not found',
				retryCount,
			});
			return { success: false, error: 'Run not found' };
		}

		const { run, contact, automation } = runData;

		if (automation.status !== 'active') {
			await ctx.runMutation(internal.automations.stepExecutorQueries.markStepFailed, {
				stepRunId: args.stepRunId,
				errorMessage: 'Automation is no longer active',
				retryCount,
			});
			await ctx.runMutation(internal.automations.stepExecutorQueries.cancelAutomationRun, {
				automationRunId: args.automationRunId,
			});
			return { success: false, error: 'Automation inactive' };
		}

		const step = await ctx.runQuery(internal.automations.stepExecutorQueries.getAutomationStep, {
			automationId: run.automationId,
			stepIndex: run.currentStepIndex,
		});

		if (!step) {
			await ctx.runMutation(internal.automations.stepExecutorQueries.markStepFailed, {
				stepRunId: args.stepRunId,
				errorMessage: 'Step not found',
				retryCount,
			});
			return { success: false, error: 'Step not found' };
		}

		// Fresh dispatch (retryCount 0) must atomically claim the pending step so
		// a duplicate scheduler firing (cron vs. original runAfter) can't execute
		// it twice. Retries (retryCount > 0) re-enter on an already-`executing`
		// step run that this same chain owns, so they skip the claim.
		if (retryCount === 0) {
			const claim = await ctx.runMutation(
				internal.automations.stepExecutorQueries.markStepExecuting,
				{ stepRunId: args.stepRunId }
			);
			if (!claim.claimed) {
				// Another invocation already owns this step — drop this duplicate.
				return { success: true };
			}
			if (claim.stepsExecuted > MAX_STEPS_PER_RUN) {
				await ctx.runMutation(internal.automations.stepExecutorQueries.markStepFailed, {
					stepRunId: args.stepRunId,
					errorMessage: `Automation exceeded ${MAX_STEPS_PER_RUN} step executions — cancelled to prevent a loop`,
					retryCount,
				});
				await ctx.runMutation(internal.automations.stepExecutorQueries.cancelAutomationRun, {
					automationRunId: args.automationRunId,
				});
				return { success: false, error: 'Max steps exceeded', cancelled: true };
			}
		}

		try {
			// Plugin step kinds run through the host-gated runner (authorize →
			// bounded input → module → scrubbed result); core kinds dispatch to
			// their module directly. Both feed the same retry/idempotency path.
			let outcome: StepOutcome;
			if (isPluginStepKind(step.stepType)) {
				outcome = await executePluginStep(ctx, step, contact);
			} else {
				const module = stepModuleFor(step.stepType as CoreStepKind);
				const config = module.parseConfig(step.config);
				outcome = await module.execute(ctx, {
					config: config as never,
					contact,
					automation,
					stepRunId: args.stepRunId,
				});
			}

			if (outcome.status === 'failed') {
				throw new Error(outcome.error);
			}

			// Mark the step completed — emailSendId is set only when the email
			// module returns one.
			await ctx.runMutation(internal.automations.stepExecutorQueries.markStepCompleted, {
				stepRunId: args.stepRunId,
				emailSendId: outcome.emailSendId,
			});

			// Decide where to go next: explicit override (condition branch) or
			// sequential `currentStepIndex + 1`.
			const allSteps = await ctx.runQuery(
				internal.automations.stepExecutorQueries.getAutomationSteps,
				{ automationId: run.automationId }
			);
			const nextStepIndex = outcome.nextStepIndex ?? run.currentStepIndex + 1;
			return await advanceToStep(
				ctx,
				args.automationRunId,
				run.currentStepIndex,
				nextStepIndex,
				allSteps
			);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';

			if (retryCount < MAX_RETRY_ATTEMPTS) {
				const retryDelay = RETRY_DELAYS_MS[retryCount] ?? 30000;
				await ctx.scheduler.runAfter(retryDelay, internal.automations.stepWalker.executeStep, {
					automationRunId: args.automationRunId,
					stepRunId: args.stepRunId,
					retryCount: retryCount + 1,
				});
				return { success: false, error: errorMessage, retrying: true };
			}

			await ctx.runMutation(internal.automations.stepExecutorQueries.markStepFailed, {
				stepRunId: args.stepRunId,
				errorMessage,
				retryCount,
			});
			await ctx.runMutation(internal.automations.stepExecutorQueries.cancelAutomationRun, {
				automationRunId: args.automationRunId,
			});
			// Circuit breaker: a run that exhausted its retries is a systematic
			// failure (a broken step), not bad luck — count it toward auto-pausing
			// the automation so it stops re-failing for every subsequent contact.
			await ctx.runMutation(internal.automations.lifecycle.recordRunFailure, {
				automationId: run.automationId,
			});

			return { success: false, error: errorMessage, cancelled: true };
		}
	},
});

// ============== Start a new automation run ==============

interface StartAutomationResult {
	success: boolean;
	error?: string;
	completed?: boolean;
	message?: string;
	stepRunId?: Id<'automationStepRuns'>;
	delayMs?: number;
}

export const startAutomationRun = internalAction({
	args: {
		automationRunId: v.id('automationRuns'),
	},
	handler: async (ctx, args): Promise<StartAutomationResult> => {
		const runData = await ctx.runQuery(
			internal.automations.stepExecutorQueries.getAutomationRunWithContact,
			{ automationRunId: args.automationRunId }
		);

		if (!runData) {
			return { success: false, error: 'Automation run not found' };
		}

		const { run, automation } = runData;

		if (automation.status !== 'active') {
			await ctx.runMutation(internal.automations.stepExecutorQueries.cancelAutomationRun, {
				automationRunId: args.automationRunId,
			});
			return { success: false, error: 'Automation is not active' };
		}

		const firstStep = await ctx.runQuery(
			internal.automations.stepExecutorQueries.getAutomationStep,
			{
				automationId: run.automationId,
				stepIndex: 0,
			}
		);

		if (!firstStep) {
			await ctx.runMutation(internal.automations.stepExecutorQueries.completeAutomationRun, {
				automationRunId: args.automationRunId,
			});
			return { success: true, completed: true, message: 'No steps to execute' };
		}

		const delayMs = computeEntryDelay(firstStep);
		const delayUntil = delayMs > 0 ? Date.now() + delayMs : undefined;

		if (delayMs > 0) {
			await ctx.runMutation(internal.automations.stepExecutorQueries.advanceAutomationRun, {
				automationRunId: args.automationRunId,
				nextStepIndex: 0,
				nextStepAt: delayUntil,
			});
		}

		const stepRunId = await ctx.runMutation(
			internal.automations.stepExecutorQueries.createStepRun,
			{
				automationRunId: args.automationRunId,
				automationStepId: firstStep._id,
				stepIndex: 0,
				stepType: firstStep.stepType,
				delayUntil,
			}
		);

		await ctx.scheduler.runAfter(delayMs, internal.automations.stepWalker.executeStep, {
			automationRunId: args.automationRunId,
			stepRunId,
		});

		return { success: true, stepRunId, delayMs };
	},
});

// ============== Cron: catch up missed delays ==============

export const processPendingDelays = internalAction({
	args: {},
	handler: async (ctx) => {
		const pendingRuns = await ctx.runQuery(
			internal.automations.stepExecutorQueries.getPendingDelayStepRuns
		);

		let processedCount = 0;
		for (const stepRun of pendingRuns) {
			await ctx.scheduler.runAfter(0, internal.automations.stepWalker.executeStep, {
				automationRunId: stepRun.automationRunId,
				stepRunId: stepRun._id,
			});
			processedCount++;
		}

		// A full page means more may be due — drain across ticks rather than fanning
		// out the whole overflow in one transaction. markStepExecuting's CAS makes a
		// re-fired step idempotent.
		if (pendingRuns.length === PENDING_DELAY_BATCH) {
			await ctx.scheduler.runAfter(0, internal.automations.stepWalker.processPendingDelays, {});
		}
		return { processedCount };
	},
});
