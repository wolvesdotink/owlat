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
import { attachmentSetHashOf, draftHashOf } from '@owlat/shared/threadBriefRules';
import { toPromptItems, type PlanPromptItem } from '../interpret/planCheck';
import { planVerdictOf, type PlanCoverage } from '../interpret/responsePlanRules';
import type { PlanForDraft } from '../interpret/responsePlanState';

/**
 * A team reply's exact draft: the inbound message the drafter's context
 * answers (`composeDraftContext.loadTeamThreadContext`, the same read the
 * context is built from), never another message's plan (review F9).
 */
async function answeredInbound(
	ctx: Pick<ActionCtx, 'runQuery'>,
	target: AnswerAskTarget
): Promise<{ inboundMessageId?: Id<'inboundMessages'> }> {
	if (target.kind !== 'teamThread') return {};
	const loaded = await ctx.runQuery(internal.mail.ai.composeDraftContext.loadTeamThreadContext, {
		threadId: target.threadId,
	});
	return { inboundMessageId: loaded.inboundMessageId };
}

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
			...(await answeredInbound(ctx, session.target)),
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
			...(await answeredInbound(ctx, target)),
		});
		return loaded ? slotItemsOf(loaded.items) : [];
	} catch {
		return []; // questions without an item link, as before
	}
}

/** A Postbox thread's plan for a drafter: its items, stances and binding values. */
export interface ThreadPlan {
	prompt: { items: PlanPromptItem[]; attachments: [] };
	threadRevision: number;
	planRevision: number;
	isOverflow: boolean;
	itemRevisions: { itemId: Id<'threadItems'>; revision: number }[];
	stances: PlanForDraft['stances'];
}

/**
 * A Postbox thread's plan with its defaults (`answer`, or `clarify` while an
 * item's Reply Queue question is unanswered), for the drafters that write
 * before any draft row exists: draft on arrival, and the Reply Queue's starter
 * after the owner's answers (review F13). Undefined without items or on a
 * failed read: the draft is written as before.
 */
export async function loadThreadPlan(
	ctx: Pick<ActionCtx, 'runQuery'>,
	threadId: Id<'mailThreads'>
): Promise<ThreadPlan | undefined> {
	try {
		const loaded = await ctx.runQuery(internal.mail.interpret.responsePlanDraft.loadForDraft, {
			threadRef: { kind: 'mail', id: threadId },
			draftRef: { kind: 'arrivalDraft', id: threadId },
		});
		if (loaded.items.length === 0) return undefined;
		return {
			prompt: { items: toPromptItems(loaded.items, loaded.stances), attachments: [] },
			threadRevision: loaded.threadRevision,
			planRevision: loaded.planRevision,
			isOverflow: loaded.isOverflow,
			itemRevisions: loaded.items.map((i) => ({ itemId: i.id, revision: i.revision })),
			stances: loaded.stances,
		};
	} catch (err) {
		logError(
			'[draftPlan] loading the thread plan failed:',
			err instanceof Error ? err.message.split('\n', 1)[0] : 'non-Error thrown'
		);
		return undefined;
	}
}

/**
 * Store the prepared reply's checked plan under the thread's `arrivalDraft`
 * reference, bound to the hash of the text the slot holds (review F16); it
 * moves to the Postbox draft the composer creates from that text
 * (`responsePlan.adoptArrivalPlan`). Fail-soft.
 */
export async function recordArrivalPlan(
	ctx: Pick<ActionCtx, 'runMutation'>,
	threadId: Id<'mailThreads'>,
	plan: ThreadPlan,
	draft: string,
	checked: PlanCoverage | null
): Promise<void> {
	try {
		const coverage = (checked ?? {
			coverage: [],
			fileClaims: [],
			newPromises: [],
			isIncomplete: false,
		}) as PlanCoverage<Id<'threadItems'>>;
		await ctx.runMutation(internal.mail.interpret.responsePlanDraft.recordCheck, {
			threadRef: { kind: 'mail', id: threadId },
			draftRef: { kind: 'arrivalDraft', id: threadId },
			threadRevision: plan.threadRevision,
			itemRevisions: plan.itemRevisions,
			stances: plan.stances,
			coverage: coverage.coverage,
			fileClaims: coverage.fileClaims,
			newPromises: coverage.newPromises,
			draftHash: await draftHashOf(draft),
			verdict: checked ? planVerdictOf(plan.stances, coverage) : 'pending',
			planRevision: plan.planRevision,
			attachmentSetHash: await attachmentSetHashOf([]),
			isCheckIncomplete: coverage.isIncomplete || plan.isOverflow,
		});
	} catch (err) {
		logError(
			'[draftPlan] storing the prepared reply plan failed:',
			err instanceof Error ? err.message.split('\n', 1)[0] : 'non-Error thrown'
		);
	}
}
