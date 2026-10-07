/**
 * Answer mode "Draft with AI" and the response plan (SPEC §6): the thread's
 * open items with the stances the owner chose in Answer mode
 * (`mail/interpret/responsePlan.setStances`), for the drafter's prompt. An
 * item whose question in this ask session is still unanswered defaults to
 * `clarify`. FAIL-SOFT: no plan, the draft is written as before.
 */

import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { logError } from '../../lib/runtimeLog';
import type { AnswerAskTarget } from '../../lib/validators/answerAsk';
import { slotItemsOf, type SlotItem } from '../../inbox/clarificationSlots';
import { toPromptItems, type PlanPromptItem } from '../interpret/planCheck';

/** The plan's items with their stances, or undefined when there are none. */
export async function loadAnswerPlan(
	ctx: Pick<ActionCtx, 'runQuery'>,
	session: Pick<Doc<'answerAskSessions'>, 'target' | 'questions'>
): Promise<PlanPromptItem[] | undefined> {
	try {
		const openSlots = session.questions.flatMap((q) => (q.itemId && !q.answer ? [q.itemId] : []));
		const loaded = await ctx.runQuery(internal.mail.interpret.responsePlanDraft.loadForAskTarget, {
			target: session.target,
			openSlots,
		});
		if (!loaded || loaded.items.length === 0) return undefined;
		return toPromptItems(loaded.items, loaded.stances);
	} catch (err) {
		logError(
			'[composeDraft] loading the response plan failed:',
			err instanceof Error ? err.message.split('\n', 1)[0] : 'non-Error thrown'
		);
		return undefined;
	}
}

/** The target thread's open items for the gap check, so a question names its item. */
export async function loadSlotItems(
	ctx: Pick<ActionCtx, 'runQuery'>,
	target: AnswerAskTarget
): Promise<SlotItem<Id<'threadItems'>>[]> {
	try {
		const loaded = await ctx.runQuery(internal.mail.interpret.responsePlanDraft.loadForAskTarget, {
			target,
			openSlots: [],
		});
		return loaded ? slotItemsOf(loaded.items) : [];
	} catch {
		return []; // questions without an item link, as before
	}
}
