'use node';

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { stepModuleFor } from './steps';
import { isPluginStepKind, type CoreStepKind } from './steps/catalog';
import { executePluginStep } from './steps/pluginStep';
import { PENDING_DELAY_BATCH } from './stepExecutorQueries';
import { RECOVERY_BATCH } from './stepOrchestration';
import type { StepOutcome } from './types';

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

type ClaimedStep = {
	step: Doc<'automationSteps'>;
	contact: Doc<'contacts'>;
	automation: Doc<'automations'>;
};

/**
 * Run the step's side effect — the only part of a step that is not a
 * transaction. Plugin step kinds run through the host-gated runner (authorize →
 * bounded input → module → scrubbed result); core kinds dispatch to their
 * module directly. A throw is folded into a `failed` outcome so the caller has
 * one retry path.
 */
async function runStepSideEffect(
	ctx: ActionCtx,
	claimed: ClaimedStep,
	stepRunId: Id<'automationStepRuns'>
): Promise<StepOutcome> {
	const { step, contact, automation } = claimed;
	try {
		if (isPluginStepKind(step.stepType)) {
			return await executePluginStep(ctx, step, contact);
		}
		const module = stepModuleFor(step.stepType as CoreStepKind);
		const config = module.parseConfig(step.config);
		return await module.execute(ctx, {
			config: config as never,
			contact,
			automation,
			stepRunId,
		});
	} catch (error) {
		return { status: 'failed', error: error instanceof Error ? error.message : 'Unknown error' };
	}
}

// ============== Main action: execute one step ==============

/**
 * Execute one attempt of one step run. The state around the side effect lives
 * in three mutations (see `stepOrchestration.ts`): the claim binds this attempt
 * to the persisted step run, and exactly one of finalize or retry-or-fail
 * commits its result. If this action dies anywhere in between, the step run's
 * lease expires and `processPendingDelays` recovers it.
 */
export const executeStep = internalAction({
	args: {
		automationRunId: v.id('automationRuns'),
		stepRunId: v.id('automationStepRuns'),
		retryCount: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<ExecuteStepResult> => {
		const attempt = args.retryCount ?? 0;

		const claim = await ctx.runMutation(internal.automations.stepOrchestration.claimStepRun, {
			stepRunId: args.stepRunId,
			attempt,
		});
		// Another invocation already owns (or finished) this step — drop this duplicate.
		if (claim.kind === 'dropped') return { success: true };
		if (claim.kind === 'ended') return { success: false, error: claim.reason, cancelled: true };

		const outcome = await runStepSideEffect(ctx, claim, args.stepRunId);

		if (outcome.status === 'failed') {
			const retry = await ctx.runMutation(
				internal.automations.stepOrchestration.retryOrFailStepRun,
				{ stepRunId: args.stepRunId, attempt, errorMessage: outcome.error }
			);
			if (retry.kind === 'retrying') {
				return { success: false, error: outcome.error, retrying: true };
			}
			return { success: false, error: outcome.error, cancelled: retry.kind === 'failed' };
		}

		const finalized = await ctx.runMutation(
			internal.automations.stepOrchestration.finalizeStepRun,
			{
				stepRunId: args.stepRunId,
				attempt,
				outcome:
					outcome.status === 'contact_ineligible'
						? { kind: 'contact_ineligible', reason: outcome.reason }
						: {
								kind: 'completed',
								emailSendId: outcome.emailSendId,
								nextStepIndex: outcome.nextStepIndex,
							},
			}
		);
		switch (finalized.kind) {
			case 'scheduled':
				return { success: true, nextStepScheduled: true, delayMs: finalized.delayMs };
			case 'completed':
				return { success: true, completed: true };
			case 'cancelled':
				return { success: false, error: 'Contact ineligible', cancelled: true };
			case 'stale':
			case 'run_ended':
				return { success: true };
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
		// One mutation: create the first step run and schedule it together.
		const started = await ctx.runMutation(
			internal.automations.stepOrchestration.beginAutomationRun,
			{ automationRunId: args.automationRunId }
		);
		switch (started.kind) {
			case 'not_found':
				return { success: false, error: 'Automation run not found' };
			case 'automation_inactive':
				return { success: false, error: 'Automation is not active' };
			case 'already_started':
				return { success: true, message: 'Run already started' };
			case 'completed':
				return { success: true, completed: true, message: 'No steps to execute' };
			case 'scheduled':
				return { success: true, stepRunId: started.stepRunId, delayMs: started.delayMs };
		}
	},
});

// ============== Cron: catch up missed delays ==============

export const processPendingDelays = internalAction({
	args: {},
	handler: async (ctx): Promise<{ processedCount: number; recoveredCount: number }> => {
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

		// Orchestration recovery: attempts whose lease expired were interrupted
		// between two commits. Re-dispatch each as the NEXT attempt; the claim's
		// fencing CAS drops it if a scheduled retry got there first.
		const interruptedRuns = await ctx.runQuery(
			internal.automations.stepOrchestration.getInterruptedStepRuns
		);
		for (const stepRun of interruptedRuns) {
			await ctx.scheduler.runAfter(0, internal.automations.stepWalker.executeStep, {
				automationRunId: stepRun.automationRunId,
				stepRunId: stepRun._id,
				retryCount: (stepRun.retryCount ?? 0) + 1,
			});
		}

		// A full page means more may be due — drain across ticks rather than fanning
		// out the whole overflow in one transaction. The claim CAS makes a
		// re-fired step idempotent.
		if (pendingRuns.length === PENDING_DELAY_BATCH || interruptedRuns.length === RECOVERY_BATCH) {
			await ctx.scheduler.runAfter(0, internal.automations.stepWalker.processPendingDelays, {});
		}
		return { processedCount, recoveredCount: interruptedRuns.length };
	},
});
