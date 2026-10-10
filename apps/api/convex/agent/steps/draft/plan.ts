/**
 * The `draft` step's response plan (SPEC §6): the thread's open items with
 * their default stances go into the prompt, and the self-check's coverage of
 * the written draft is stored against its hash (`draftResponsePlans`), where
 * the `item_coverage` auto-send gate reads it.
 *
 * The team plan covers every unresolved item of the thread, not only the
 * newest message's. A thread with no open items still gets a plan (empty), so
 * the self-check still lists the draft's file claims and commitments.
 *
 * FAIL-SOFT: a plan that cannot be loaded or stored leaves the draft exactly
 * as it was; the gate then finds no (or a stale) plan and objects.
 */

import { internal } from '../../../_generated/api';
import type { ActionCtx } from '../../../_generated/server';
import type { Id } from '../../../_generated/dataModel';
import { logError } from '../../../lib/runtimeLog';
import {
	toPromptItems,
	type AttachmentRef,
	type PlanPromptItem,
} from '../../../mail/interpret/planCheck';
import {
	draftHashOf,
	planVerdictOf,
	type PlanCoverage,
	type PlanStance,
} from '../../../mail/interpret/responsePlanRules';

type ItemId = Id<'threadItems'>;

export interface DraftPlan {
	inboundMessageId: Id<'inboundMessages'>;
	threadId: Id<'conversationThreads'>;
	threadRevision: number;
	planRevision: number;
	deletionEpoch: number;
	attachmentSetHash: string;
	isOverflow: boolean;
	stances: PlanStance<ItemId>[];
	itemRevisions: { itemId: ItemId; revision: number }[];
	prompt: { items: PlanPromptItem<ItemId>[]; attachments: AttachmentRef[] };
}

function failureText(err: unknown): string {
	return err instanceof Error ? err.message.split('\n', 1)[0]! : 'non-Error thrown';
}

/** The plan for this message's draft, or null when it cannot be built. */
export async function loadDraftPlan(
	ctx: Pick<ActionCtx, 'runQuery'>,
	inboundMessageId: Id<'inboundMessages'>,
	threadId: Id<'conversationThreads'> | undefined
): Promise<DraftPlan | null> {
	if (!threadId) return null;
	try {
		const loaded = await ctx.runQuery(internal.mail.interpret.responsePlanDraft.loadForDraft, {
			threadRef: { kind: 'team', id: threadId },
			draftRef: { kind: 'inboundDraft', id: inboundMessageId },
		});
		return {
			inboundMessageId,
			threadId,
			threadRevision: loaded.threadRevision,
			planRevision: loaded.planRevision,
			deletionEpoch: loaded.deletionEpoch,
			attachmentSetHash: loaded.attachmentSetHash,
			isOverflow: loaded.isOverflow,
			stances: loaded.stances,
			itemRevisions: loaded.items.map((i) => ({ itemId: i.id, revision: i.revision })),
			prompt: {
				items: toPromptItems(loaded.items, loaded.stances),
				attachments: loaded.attachments,
			},
		};
	} catch (err) {
		logError('[draft] loading the response plan failed:', failureText(err));
		return null;
	}
}

/** Store the checked plan against the draft as written. */
export async function recordDraftPlan(
	ctx: Pick<ActionCtx, 'runMutation'>,
	plan: DraftPlan,
	draftBody: string,
	checked: PlanCoverage | null
): Promise<void> {
	try {
		// The ids are the plan's own: the coverage was parsed from its items.
		const coverage = (checked ?? {
			coverage: [],
			fileClaims: [],
			newPromises: [],
			isIncomplete: false,
		}) as PlanCoverage<ItemId>;
		await ctx.runMutation(internal.mail.interpret.responsePlanDraft.recordCheck, {
			threadRef: { kind: 'team', id: plan.threadId },
			draftRef: { kind: 'inboundDraft', id: plan.inboundMessageId },
			threadRevision: plan.threadRevision,
			itemRevisions: plan.itemRevisions,
			stances: plan.stances,
			coverage: coverage.coverage,
			fileClaims: coverage.fileClaims,
			newPromises: coverage.newPromises,
			draftHash: await draftHashOf(draftBody),
			// No self-check answer: nothing is known to be covered.
			verdict: checked ? planVerdictOf(plan.stances, coverage) : 'pending',
			// Compare-and-set: a person's stance write since the load wins.
			planRevision: plan.planRevision,
			deletionEpoch: plan.deletionEpoch,
			attachmentSetHash: plan.attachmentSetHash,
			isCheckIncomplete: coverage.isIncomplete || plan.isOverflow,
		});
	} catch (err) {
		logError('[draft] storing the response plan failed:', failureText(err));
	}
}
