/**
 * Where the Phase 2 bundles hook into today's pipelines (ADR-0073 §5). Each
 * hook schedules a separate action and returns: a bundle never runs inside a
 * pipeline step, so its answer, its latency and its failure cannot change the
 * step's outcome (D9). Every hook checks its routing switch first, so with
 * every switch off (the default) nothing is scheduled at all. Every hook is
 * fail-soft: a scheduling failure is logged and the pipeline continues.
 *
 * Runtime-neutral: called from the Team steps and the Postbox category action.
 */

import type { ResolvedRoutingPolicy } from '@owlat/shared/aiRouting';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { ActionCtx } from '../_generated/server';
import type { DecisionLabels } from '../lib/decision/bundles';
import { planMessageBundle, planTriage } from '../lib/decision/routing';

type ScheduleCtx = Pick<ActionCtx, 'scheduler'>;
type ReadScheduleCtx = Pick<ActionCtx, 'scheduler' | 'runQuery'>;

function logFailure(hook: string, error: unknown): void {
	console.warn(`[decision] ${hook} not scheduled`, error instanceof Error ? error.name : error);
}

/**
 * D11: after the security scan let a Team message through (the guard ran and
 * passed, nothing quarantined or archived it) and before retrieval, schedule
 * the message-only triage shadow. The scan already holds the policy.
 */
export async function scheduleTeamTriage(
	ctx: ScheduleCtx,
	policy: Pick<ResolvedRoutingPolicy, 'triageBundle'>,
	inboundMessageId: Id<'inboundMessages'>
): Promise<void> {
	if (!planTriage(policy)) return;
	try {
		await ctx.scheduler.runAfter(0, internal.decision.bundleActions.teamTriage, {
			inboundMessageId,
		});
	} catch (error) {
		logFailure('team triage', error);
	}
}

/** After the Team classifier, the category and disposition bundle beside it. */
export async function scheduleTeamMessageBundle(
	ctx: ReadScheduleCtx,
	inboundMessageId: Id<'inboundMessages'>,
	today: { readonly baseline: DecisionLabels; readonly language?: string }
): Promise<void> {
	try {
		const policy = await ctx.runQuery(internal.aiRouting.policy.getResolved, {});
		if (!planMessageBundle(policy)) return;
		await ctx.scheduler.runAfter(0, internal.decision.bundleActions.teamMessage, {
			inboundMessageId,
			baseline: { ...today.baseline },
			...(today.language ? { language: today.language } : {}),
		});
	} catch (error) {
		logFailure('team message bundle', error);
	}
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
		const policy = await ctx.runQuery(internal.aiRouting.policy.getResolved, {});
		if (!planMessageBundle(policy)) return;
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
