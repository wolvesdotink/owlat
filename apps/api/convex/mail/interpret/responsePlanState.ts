/**
 * Response plans (SPEC §6): the store's reads and writes, shared by the public
 * functions (`responsePlan.ts`) and the drafters' internal ones
 * (`responsePlanDraft.ts`). No Convex functions here.
 *
 * Item text is read unsealed for the prompt; claims and promises are sealed
 * at rest like every other derived text (`responsePlanDraft.recordCheck`).
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import { v } from 'convex/values';
import { compareForYou } from '@owlat/shared/threadBriefRules';
import type { BriefCompleteness } from '@owlat/shared/threadBrief';
import { openMessageBody } from '../../lib/messageBody';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { isSharedInboxReader } from '../../inbox/access';
import { requireMailboxAccess } from '../permissions';
import {
	draftRefToFields,
	responseStanceValidator,
	type DraftRef,
} from '../../lib/validators/threadBrief';
import { isSameThreadRef, threadRefToFields, type ThreadRef } from '../../lib/validators/threadRef';
import { loadBriefRow } from './briefRow';
import {
	isPlanRelevant,
	planStances,
	PLAN_ITEM_LIMIT,
	type PlanItem,
	type PlanStance,
} from './responsePlanRules';
import type { AttachmentRef } from './planCheck';

type ReadCtx = Pick<QueryCtx, 'db'>;
type ItemId = Id<'threadItems'>;

/** Open items read to pick a plan's items from. */
const OPEN_ITEMS_READ = 100;

async function toPlanItem(row: Doc<'threadItems'>): Promise<PlanItem<ItemId>> {
	return {
		id: row._id,
		revision: row.revision,
		intent: row.intent,
		facets: row.facets,
		...(row.consequences ? { consequences: row.consequences } : {}),
		responsibility: row.responsibility,
		text: await openMessageBody(row.assertion),
		...(row.due ? { duePhrase: row.due.phrase } : {}),
		...(row.amount ? { amount: row.amount } : {}),
		...(row.options?.length ? { options: row.options } : {}),
	};
}

/**
 * The thread's plan-relevant items (open, tracked, ours or unclear) in the
 * "For you" order, at most {@link PLAN_ITEM_LIMIT}: for the team, every
 * unresolved item of the thread, not only the newest message's.
 */
export async function loadPlanItems(
	ctx: ReadCtx,
	ref: ThreadRef
): Promise<{ rows: Doc<'threadItems'>[]; items: PlanItem<ItemId>[] }> {
	// Read here, not through load.ts: that module pulls the mailbox identity
	// graph in, and the draft store (composeDraftStore) imports this one.
	const open =
		ref.kind === 'mail'
			? await ctx.db
					.query('threadItems')
					.withIndex('by_mail_thread_and_status', (q) =>
						q.eq('mailThreadId', ref.id).eq('status', 'open')
					)
					.take(OPEN_ITEMS_READ)
			: await ctx.db
					.query('threadItems')
					.withIndex('by_conversation_thread_and_status', (q) =>
						q.eq('conversationThreadId', ref.id).eq('status', 'open')
					)
					.take(OPEN_ITEMS_READ);
	const rows = open
		.filter(isPlanRelevant)
		.sort((a, b) =>
			compareForYou(
				{ due: a.due, facets: a.facets, askedAt: a.askedAt, id: a._id },
				{ due: b.due, facets: b.facets, askedAt: b.askedAt, id: b._id }
			)
		)
		.slice(0, PLAN_ITEM_LIMIT);
	return { rows, items: await Promise.all(rows.map(toPlanItem)) };
}

/** The thread a draft replies in, or null (no thread, or the draft is gone). */
async function threadOfDraft(ctx: ReadCtx, draftRef: DraftRef): Promise<ThreadRef | null> {
	if (draftRef.kind === 'mailDraft') {
		const draft = await ctx.db.get(draftRef.id);
		return draft?.threadId ? { kind: 'mail', id: draft.threadId } : null;
	}
	const message = await ctx.db.get(draftRef.id);
	return message?.threadId ? { kind: 'team', id: message.threadId } : null;
}

/** Whether the draft replies in `ref`. */
export async function isDraftOfThread(
	ctx: ReadCtx,
	draftRef: DraftRef,
	ref: ThreadRef
): Promise<boolean> {
	const thread = await threadOfDraft(ctx, draftRef);
	return thread !== null && isSameThreadRef(thread, ref);
}

/**
 * Items with a clarification question still unanswered: the thread's Reply
 * Queue questions (Postbox) or the agent's questions on the draft's message
 * (team). Their default stance is `clarify`.
 */
async function openSlotItemIds(
	ctx: ReadCtx,
	ref: ThreadRef,
	draftRef: DraftRef | null
): Promise<Set<string>> {
	let questions: ReadonlyArray<{ itemId?: ItemId; answer?: unknown }> = [];
	if (ref.kind === 'mail') {
		questions = (await ctx.db.get(ref.id))?.needsReply?.clarification?.questions ?? [];
	} else if (draftRef?.kind === 'inboundDraft') {
		const message = await ctx.db.get(draftRef.id);
		questions = message?.pendingClarification?.answeredAt
			? []
			: (message?.pendingClarification?.questions ?? []);
	}
	return new Set(questions.filter((q) => q.itemId && !q.answer).map((q) => q.itemId as string));
}

export async function readPlanRow(
	ctx: ReadCtx,
	draftRef: DraftRef
): Promise<Doc<'draftResponsePlans'> | null> {
	return draftRef.kind === 'mailDraft'
		? ctx.db
				.query('draftResponsePlans')
				.withIndex('by_mail_draft', (q) => q.eq('mailDraftId', draftRef.id))
				.first()
		: ctx.db
				.query('draftResponsePlans')
				.withIndex('by_inbound_draft', (q) => q.eq('inboundMessageId', draftRef.id))
				.first();
}

/** Delete every plan of a draft (a discarded or sent draft). */
export async function deletePlansForDraft(ctx: MutationCtx, draftRef: DraftRef): Promise<void> {
	const rows =
		draftRef.kind === 'mailDraft'
			? await ctx.db
					.query('draftResponsePlans')
					.withIndex('by_mail_draft', (q) => q.eq('mailDraftId', draftRef.id))
					.take(20)
			: await ctx.db
					.query('draftResponsePlans')
					.withIndex('by_inbound_draft', (q) => q.eq('inboundMessageId', draftRef.id))
					.take(20);
	for (const row of rows) await ctx.db.delete(row._id);
}

/** A thread's plan as it stands: its items now, and the stances over them. */
export interface PlanState {
	threadRevision: number;
	completeness: BriefCompleteness;
	rows: Doc<'threadItems'>[];
	items: PlanItem<ItemId>[];
	stances: PlanStance<ItemId>[];
	row: Doc<'draftResponsePlans'> | null;
}

export async function loadPlanState(
	ctx: ReadCtx,
	ref: ThreadRef,
	draftRef: DraftRef | null,
	options: { chosen?: readonly PlanStance<ItemId>[]; openSlots?: readonly string[] } = {}
): Promise<PlanState> {
	const [brief, loaded, row, slots] = await Promise.all([
		loadBriefRow(ctx, ref),
		loadPlanItems(ctx, ref),
		draftRef ? readPlanRow(ctx, draftRef) : Promise.resolve(null),
		openSlotItemIds(ctx, ref, draftRef),
	]);
	for (const id of options.openSlots ?? []) slots.add(id);
	const chosen = [...(row?.stances ?? []), ...(options.chosen ?? [])];
	// Later choices win: the given ones over the stored ones.
	const latest = [...new Map(chosen.map((s) => [s.itemId as string, s])).values()];
	return {
		threadRevision: brief?.interpretationRevision ?? 0,
		completeness: brief?.completeness ?? 'none',
		rows: loaded.rows,
		items: loaded.items,
		stances: planStances(loaded.items, latest, slots),
		row,
	};
}

/** The files a draft carries now, for the file-claim check. */
async function draftAttachments(ctx: ReadCtx, draftRef: DraftRef | null, ref: ThreadRef) {
	const out: AttachmentRef[] = [];
	if (draftRef?.kind === 'mailDraft') {
		const draft = await ctx.db.get(draftRef.id);
		for (const a of draft?.attachments ?? []) out.push({ id: a.storageId, filename: a.filename });
	} else if (ref.kind === 'team') {
		const thread = await ctx.db.get(ref.id);
		for (const a of thread?.replyAttachments ?? []) {
			if (a.storageId) out.push({ id: a.id, filename: a.filename });
		}
	}
	return out;
}

/** Can this session read the thread? The soft-fail twin of `requireThreadReader`. */
export async function canRead(
	ctx: QueryCtx,
	ref: ThreadRef,
	session: Parameters<typeof isSharedInboxReader>[0]
): Promise<boolean> {
	if (ref.kind === 'mail') {
		const thread = await ctx.db.get(ref.id);
		return !!thread && (await requireMailboxAccess(ctx, thread.mailboxId)).ok;
	}
	return isSharedInboxReader(session) && (await isFeatureEnabled(ctx, 'inbox'));
}

export const givenStanceValidator = v.object({
	itemId: v.id('threadItems'),
	stance: responseStanceValidator,
});

/** Insert or update a draft's plan row. */
export async function upsertPlan(
	ctx: MutationCtx,
	ref: ThreadRef,
	draftRef: DraftRef,
	fields: Omit<
		Doc<'draftResponsePlans'>,
		| '_id'
		| '_creationTime'
		| 'threadKind'
		| 'mailThreadId'
		| 'conversationThreadId'
		| 'draftKind'
		| 'mailDraftId'
		| 'inboundMessageId'
		| 'createdAt'
	>
): Promise<Id<'draftResponsePlans'>> {
	const existing = await readPlanRow(ctx, draftRef);
	if (existing) {
		await ctx.db.patch(existing._id, fields);
		return existing._id;
	}
	return ctx.db.insert('draftResponsePlans', {
		...threadRefToFields(ref),
		...draftRefToFields(draftRef),
		...fields,
		createdAt: fields.updatedAt,
	});
}

/** What a drafter or the coverage check needs: items, stances, attachments. */
export interface PlanForDraft {
	threadRevision: number;
	completeness: BriefCompleteness;
	items: PlanItem<ItemId>[];
	stances: PlanStance<ItemId>[];
	attachments: AttachmentRef[];
}

export async function planForDraft(
	ctx: ReadCtx,
	ref: ThreadRef,
	draftRef: DraftRef | null,
	options: Parameters<typeof loadPlanState>[3]
): Promise<PlanForDraft> {
	const state = await loadPlanState(ctx, ref, draftRef, options);
	return {
		threadRevision: state.threadRevision,
		completeness: state.completeness,
		items: state.items,
		stances: state.stances,
		attachments: await draftAttachments(ctx, draftRef, ref),
	};
}
