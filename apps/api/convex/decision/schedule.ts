/**
 * Where the Phase 2 bundles hook into today's pipelines. Each
 * hook schedules a separate action: a bundle never runs inside a
 * pipeline step, so its answer, its latency and its failure cannot change the
 * step's outcome. The Team hooks only decide the bundle to schedule
 * ({@link TeamBundle}); the walker's step commit schedules it with the step
 * ({@link scheduleTeamBundle}), so a step that fails schedules none. Every hook
 * checks its routing switch first, so with every switch off (the default)
 * nothing is scheduled at all, and a mailbox excluded from hosted decisions
 * gets nothing unless the decision plane is the local engine. Every hook is
 * fail-soft: a scheduling failure is logged and the pipeline continues.
 *
 * Runtime-neutral: called from the Team steps and the Postbox category action.
 */

import { v, type Infer } from 'convex/values';
import type { ResolvedRoutingPolicy } from '@owlat/shared/aiRouting';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { ActionCtx } from '../_generated/server';
import type { DecisionLabels } from '../lib/decision/bundles';
import { planMessageBundle, planTriage } from '../lib/decision/routing';

type ReadScheduleCtx = Pick<ActionCtx, 'scheduler' | 'runQuery'>;
type ReadCtx = Pick<ActionCtx, 'runQuery'>;

/** A Team bundle a pipeline step decided to schedule beside itself. */
export const teamBundleValidator = v.union(
	v.object({ bundle: v.literal('team_triage') }),
	v.object({
		bundle: v.literal('team_message'),
		baseline: v.record(v.string(), v.string()),
		language: v.optional(v.string()),
	})
);

export type TeamBundle = Infer<typeof teamBundleValidator>;

function logFailure(hook: string, error: unknown): void {
	console.warn(`[decision] ${hook} not scheduled`, error instanceof Error ? error.name : error);
}

/**
 * After the security scan let a Team message through (the guard ran and
 * passed, nothing quarantined or archived it) and before retrieval, the
 * message-only triage shadow, or null. The scan already holds the policy.
 */
export async function teamTriageBundle(
	ctx: ReadCtx,
	policy: Pick<ResolvedRoutingPolicy, 'triageBundle'>
): Promise<TeamBundle | null> {
	if (!planTriage(policy)) return null;
	try {
		const gate = await ctx.runQuery(internal.decision.context.schedulingGate, {});
		if (!gate.isAllowed || !planTriage(gate.policy)) return null;
		return { bundle: 'team_triage' };
	} catch (error) {
		logFailure('team triage', error);
		return null;
	}
}

/** After the Team classifier, the category and disposition bundle beside it, or null. */
export async function teamMessageBundle(
	ctx: ReadCtx,
	today: { readonly baseline: DecisionLabels; readonly language?: string }
): Promise<TeamBundle | null> {
	try {
		const gate = await ctx.runQuery(internal.decision.context.schedulingGate, {});
		if (!gate.isAllowed || !planMessageBundle(gate.policy)) return null;
		return {
			bundle: 'team_message',
			baseline: { ...today.baseline },
			...(today.language ? { language: today.language } : {}),
		};
	} catch (error) {
		logFailure('team message bundle', error);
		return null;
	}
}

/** Schedule a Team bundle the step decided on, from the step's commit. */
export async function scheduleTeamBundle(
	ctx: Pick<ActionCtx, 'scheduler'>,
	inboundMessageId: Id<'inboundMessages'>,
	bundle: TeamBundle
): Promise<void> {
	if (bundle.bundle === 'team_triage') {
		await ctx.scheduler.runAfter(0, internal.decision.bundleActions.teamTriage, {
			inboundMessageId,
		});
		return;
	}
	await ctx.scheduler.runAfter(0, internal.decision.bundleActions.teamMessage, {
		inboundMessageId,
		baseline: bundle.baseline,
		...(bundle.language ? { language: bundle.language } : {}),
	});
}

/**
 * After the Postbox category refinement (mail the heuristic left ambiguous),
 * the category and disposition bundle beside it. Rung 0 (an override or the
 * heuristic) settles every other thread, so they are never asked.
 */
export async function schedulePostboxMessageBundle(
	ctx: ReadScheduleCtx,
	thread: {
		readonly threadId: Id<'mailThreads'>;
		readonly expectedLatestMessageId: Id<'mailMessages'> | undefined;
		readonly baseline: DecisionLabels;
	}
): Promise<void> {
	try {
		const gate = await ctx.runQuery(internal.decision.context.schedulingGate, {
			threadId: thread.threadId,
		});
		if (!gate.isAllowed || !planMessageBundle(gate.policy)) return;
		await ctx.scheduler.runAfter(0, internal.decision.bundleActions.postboxMessage, {
			threadId: thread.threadId,
			...(thread.expectedLatestMessageId
				? { expectedLatestMessageId: thread.expectedLatestMessageId }
				: {}),
			baseline: { ...thread.baseline },
		});
	} catch (error) {
		logFailure('postbox message bundle', error);
	}
}
