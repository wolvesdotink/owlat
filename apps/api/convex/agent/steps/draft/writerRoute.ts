/**
 * How the Team Inbox `draft` step writes its reply.
 *
 * The route comes from the TRUSTED classifier signals and two settings:
 * `LLM_COMPLEXITY_ROUTING` (today's downgrade) and the routing policy's
 * `cheapFirstWriter` switch (`lib/llmProvider.ts` `classifiedDraftRouteOf`).
 * Cheap-first applies only to a REVIEWED draft: one no auto-send can follow.
 * It drafts without the recall tool (`agent/shared/cheapFirstDraft.ts`).
 * The step knows that for certain only while shadow mode ("Draft only") is
 * on, since then the route step sends nothing. The step also marks the draft
 * (`isCheapFirstDraft`), and the `cheap_first_draft` auto-send gate refuses
 * it, so a shadow mode turned off before the route step cannot send it.
 *
 * Fail-soft to today's route: an unreadable policy is the defaults (switch
 * off), and an unreadable shadow setting is "not known to be reviewed". The
 * shadow setting is read only when the switch is on.
 */

import { internal } from '../../../_generated/api';
import type { ActionCtx } from '../../../_generated/server';
import { classifiedDraftRouteOf } from '../../../lib/llmProvider';
import type { ClassificationSignals, ClassifiedDraftRoute } from '../../../lib/llm/complexity';

export async function draftWriterRoute(
	ctx: Pick<ActionCtx, 'runQuery'>,
	signals: ClassificationSignals
): Promise<ClassifiedDraftRoute> {
	let cheapFirstWriter: 'off' | 'reviewed' = 'off';
	try {
		const policy = await ctx.runQuery(internal.aiRouting.policy.getResolved, {});
		if (policy?.cheapFirstWriter === 'reviewed') cheapFirstWriter = 'reviewed';
	} catch {
		// unreadable: the defaults, today's route
	}
	let isReviewedDraft = false;
	if (cheapFirstWriter === 'reviewed') {
		try {
			const shadow = await ctx.runQuery(internal.agent.shadowScorecard.getShadowMode, {});
			isReviewedDraft = shadow?.enabled === true;
		} catch {
			// unreadable: not known to be reviewed, so not cheap-first
		}
	}
	return classifiedDraftRouteOf(signals, { cheapFirstWriter, isReviewedDraft });
}
