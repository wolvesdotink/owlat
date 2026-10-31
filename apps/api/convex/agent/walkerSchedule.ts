/**
 * How the walker hands off to its next `runStep`: a core step, or first the
 * plugin steps that follow the completed one, then the core step. Shared by
 * the walker action (after a hosted plugin step) and its commit mutations
 * (`./walkerCommit.ts`), which schedule the next hop in the transaction that
 * records the step, so the next run exists exactly when the step's result does.
 */

import { v } from 'convex/values';
import type { Scheduler } from 'convex/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { agentStepKindValidator, pluginStepsFollowing } from './steps/catalog';
import type { AgentStepKind, NextStep } from './steps/types';

export const nextStepValidator = v.object({ kind: agentStepKindValidator, input: v.any() });

export interface PluginStepContinuation {
	readonly remainingPluginSteps: readonly AgentStepKind[];
	readonly coreStep?: NextStep;
}

type SchedulerCtx = { readonly scheduler: Scheduler };

async function scheduleStep(
	ctx: SchedulerCtx,
	inboundMessageId: Id<'inboundMessages'>,
	step: NextStep,
	continuation?: PluginStepContinuation
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.agent.walker.runStep, {
		inboundMessageId,
		kind: step.kind,
		input: step.input,
		remainingPluginSteps: continuation ? [...continuation.remainingPluginSteps] : undefined,
		coreStep: continuation?.coreStep,
	});
}

export async function scheduleAfterCoreStep(
	ctx: SchedulerCtx,
	inboundMessageId: Id<'inboundMessages'>,
	completedKind: AgentStepKind,
	nextStep: NextStep
): Promise<void> {
	const [firstPluginStep, ...remainingPluginSteps] = pluginStepsFollowing(completedKind);
	if (!firstPluginStep) {
		await scheduleStep(ctx, inboundMessageId, nextStep);
		return;
	}
	await scheduleStep(
		ctx,
		inboundMessageId,
		{ kind: firstPluginStep, input: { inboundMessageId } },
		{ remainingPluginSteps, coreStep: nextStep }
	);
}

export async function scheduleAfterPluginStep(
	ctx: SchedulerCtx,
	inboundMessageId: Id<'inboundMessages'>,
	continuation: PluginStepContinuation
): Promise<void> {
	const [nextPluginStep, ...remainingPluginSteps] = continuation.remainingPluginSteps;
	if (nextPluginStep) {
		await scheduleStep(
			ctx,
			inboundMessageId,
			{ kind: nextPluginStep, input: { inboundMessageId } },
			{ remainingPluginSteps, coreStep: continuation.coreStep }
		);
		return;
	}
	if (continuation.coreStep) await scheduleStep(ctx, inboundMessageId, continuation.coreStep);
}
