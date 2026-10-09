/**
 * Response plans (SPEC §6): the store's reads and writes, shared by the public
 * functions (`responsePlan.ts`), the drafters' internal ones
 * (`responsePlanDraft.ts`) and the gate (`planGate.ts`). No Convex functions.
 *
 * Revision binding (review D1): a plan row carries `planRevision`, bumped by
 * every stance write. A coverage result is stored with the plan revision it
 * was computed for (`checkedPlanRevision`), the draft hash, the thread and
 * item revisions and the attachment-set hash, and only while the row's
 * revision is still the one the check read (compare-and-set). No silent caps
 * (D2): every relevant item up to a generous bound is loaded; past it the plan
 * is marked overflowing, and an overflowing check is incomplete.
 *
 * Item text is read unsealed for the prompt; claims and promises are sealed
 * at rest like every other derived text (`responsePlanDraft.recordCheck`).
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import { v } from 'convex/values';
import { attachmentSetHashOf, compareForYou } from '@owlat/shared/threadBriefRules';
import type { BriefCompleteness } from '@owlat/shared/threadBrief';
import { openMessageBody } from '../../lib/messageBody';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { isSharedInboxReader } from '../../inbox/access';
import { requireMailboxAccess } from '../permissions';
import { responseStanceValidator } from '../../lib/validators/threadBrief';
import { draftRefToFields, type DraftRef } from '../../lib/validators/responsePlan';
import { isSameThreadRef, threadRefToFields, type ThreadRef } from '../../lib/validators/threadRef';
import type { TeamReplyAttachment } from '../../lib/validators/teamReplyAttachment';
import { loadBriefRow } from './briefRow';
import {
	isPlanRelevant,
	planStances,
	MAX_PLAN_ITEMS,
	type PlanItem,
	type PlanStance,
} from './responsePlanRules';
import type { AttachmentRef } from './planCheck';

type ReadCtx = Pick<QueryCtx, 'db'>;
type ItemId = Id<'threadItems'>;

/** Open items read per thread; reaching it means more may exist (overflow). */
const OPEN_ITEMS_READ = 1000;
/** Plan rows of one draft or one thread read at a time. */
const PLAN_ROWS_READ = 50;

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
 * "For you" order: for the team, every unresolved item of the thread, not
 * only the newest message's. Past {@link MAX_PLAN_ITEMS} relevant items (or a
 * full read of open rows) `isOverflow` is set: the plan cannot be complete.
 */
export async function loadPlanItems(
	ctx: ReadCtx,
	ref: ThreadRef
): Promise<{ rows: Doc<'threadItems'>[]; items: PlanItem<ItemId>[]; isOverflow: boolean }> {
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
	const relevant = open
		.filter(isPlanRelevant)
		.sort((a, b) =>
			compareForYou(
				{ due: a.due, facets: a.facets, askedAt: a.askedAt, id: a._id },
				{ due: b.due, facets: b.facets, askedAt: b.askedAt, id: b._id }
			)
		);
	const rows = relevant.slice(0, MAX_PLAN_ITEMS);
	return {
		rows,
		items: await Promise.all(rows.map(toPlanItem)),
		isOverflow: open.length >= OPEN_ITEMS_READ || relevant.length > MAX_PLAN_ITEMS,
	};
}

/** The thread a draft replies in, or null (no thread, or the draft is gone). */
async function threadOfDraft(ctx: ReadCtx, draftRef: DraftRef): Promise<ThreadRef | null> {
	if (draftRef.kind === 'mailDraft') {
		const draft = await ctx.db.get(draftRef.id);
		return draft?.threadId ? { kind: 'mail', id: draft.threadId } : null;
	}
	if (draftRef.kind === 'arrivalDraft') {
		return (await ctx.db.get(draftRef.id)) ? { kind: 'mail', id: draftRef.id } : null;
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

/** A team draft that was sent, rejected or dropped is no longer a draft. */
const SETTLED_STATUSES: ReadonlySet<Doc<'inboundMessages'>['processingStatus']> = new Set([
	'sent',
	'rejected',
	'archived',
	'failed',
]);

/**
 * Whether a draft is still one that can be checked: a Postbox draft that
 * exists, a team reply not yet sent, rejected or dropped, a prepared reply still
 * on its thread. A late coverage check never recreates the plan of a draft
 * that went away (review F14).
 */
export async function isDraftLive(ctx: ReadCtx, draftRef: DraftRef): Promise<boolean> {
	if (draftRef.kind === 'mailDraft') return (await ctx.db.get(draftRef.id)) !== null;
	if (draftRef.kind === 'arrivalDraft') {
		return !!(await ctx.db.get(draftRef.id))?.needsReply?.draftSlot;
	}
	const message = await ctx.db.get(draftRef.id);
	return !!message && !SETTLED_STATUSES.has(message.processingStatus);
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

async function planRowsOf(ctx: ReadCtx, draftRef: DraftRef): Promise<Doc<'draftResponsePlans'>[]> {
	if (draftRef.kind === 'mailDraft') {
		return ctx.db
			.query('draftResponsePlans')
			.withIndex('by_mail_draft', (q) => q.eq('mailDraftId', draftRef.id))
			.take(PLAN_ROWS_READ);
	}
	if (draftRef.kind === 'inboundDraft') {
		return ctx.db
			.query('draftResponsePlans')
			.withIndex('by_inbound_draft', (q) => q.eq('inboundMessageId', draftRef.id))
			.take(PLAN_ROWS_READ);
	}
	const rows = await ctx.db
		.query('draftResponsePlans')
		.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', draftRef.id))
		.take(PLAN_ROWS_READ);
	return rows.filter((r) => r.draftKind === 'arrivalDraft');
}

export async function readPlanRow(
	ctx: ReadCtx,
	draftRef: DraftRef
): Promise<Doc<'draftResponsePlans'> | null> {
	return (await planRowsOf(ctx, draftRef))[0] ?? null;
}

/** Delete every plan of a draft (a discarded, sent, rejected or taken-over draft). */
export async function deletePlansForDraft(ctx: MutationCtx, draftRef: DraftRef): Promise<void> {
	for (const row of await planRowsOf(ctx, draftRef)) await ctx.db.delete(row._id);
}

/**
 * Retire a team draft's plan: the draft was sent (Send intake) or a person
 * took the reply over. The row stays as a generation marker with its revision
 * bumped and everything checked cleared, so a check computed before (for the
 * old revision, or for "no row" = revision 0) can never be stored after it
 * (review r2 F5). A draft without a row gets a marker row.
 */
export async function retirePlansForDraft(
	ctx: MutationCtx,
	draftRef: Extract<DraftRef, { kind: 'inboundDraft' }>,
	threadId: Id<'conversationThreads'>
): Promise<void> {
	const retired = {
		stances: [],
		coverage: [],
		fileClaims: [],
		newPromises: [],
		ownerInputs: [],
		itemRevisions: [],
		draftHash: '',
		verdict: 'stale' as const,
		updatedAt: Date.now(),
	};
	const cleared = {
		checkedPlanRevision: undefined,
		attachmentSetHash: undefined,
		isCheckIncomplete: undefined,
	};
	const rows = await planRowsOf(ctx, draftRef);
	if (rows.length === 0) {
		await ctx.db.insert('draftResponsePlans', {
			...threadRefToFields({ kind: 'team', id: threadId }),
			...draftRefToFields(draftRef),
			...retired,
			threadRevision: 0,
			planRevision: 1,
			createdAt: retired.updatedAt,
		});
		return;
	}
	for (const row of rows) {
		await ctx.db.patch(row._id, {
			...retired,
			...cleared,
			planRevision: (row.planRevision ?? 0) + 1,
		});
	}
}

/** A thread's plan as it stands: its items now, and the stances over them. */
export interface PlanState {
	threadRevision: number;
	completeness: BriefCompleteness;
	rows: Doc<'threadItems'>[];
	items: PlanItem<ItemId>[];
	isOverflow: boolean;
	stances: PlanStance<ItemId>[];
	/** The stored row's stance revision (0 without a row). */
	planRevision: number;
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
		isOverflow: loaded.isOverflow,
		stances: planStances(loaded.items, latest, slots),
		planRevision: row?.planRevision ?? 0,
		row,
	};
}

/**
 * The files an autonomous team reply carries (`inbox/replyAttachments
 * .intakeAgentReply`): those already on the message, plus the ready composer
 * files attached after the message arrived. A file staged before it is not
 * sent unattended, so it never satisfies a claim (review F4).
 */
export function outgoingTeamAttachments(
	message: Pick<Doc<'inboundMessages'>, 'receivedAt' | 'replyAttachments'>,
	staged: readonly TeamReplyAttachment[] | undefined
): TeamReplyAttachment[] {
	const ready = (staged ?? []).filter(
		(entry) => entry.storageId !== undefined && entry.addedAt >= message.receivedAt
	);
	return [...(message.replyAttachments ?? []), ...ready];
}

/** The files a draft carries now, as the file-claim check and its hash see them. */
async function draftAttachments(
	ctx: ReadCtx,
	draftRef: DraftRef | null,
	ref: ThreadRef
): Promise<AttachmentRef[]> {
	if (draftRef?.kind === 'mailDraft') {
		const draft = await ctx.db.get(draftRef.id);
		return (draft?.attachments ?? []).map((a) => ({ id: a.storageId, filename: a.filename }));
	}
	if (draftRef?.kind === 'inboundDraft' && ref.kind === 'team') {
		const [message, thread] = await Promise.all([ctx.db.get(draftRef.id), ctx.db.get(ref.id)]);
		if (!message) return [];
		return outgoingTeamAttachments(message, thread?.replyAttachments).map((a) => ({
			id: a.id,
			filename: a.filename,
		}));
	}
	return [];
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

/** What a drafter or the coverage check needs, with the values a result binds to. */
export interface PlanForDraft {
	threadRevision: number;
	completeness: BriefCompleteness;
	items: PlanItem<ItemId>[];
	isOverflow: boolean;
	stances: PlanStance<ItemId>[];
	planRevision: number;
	attachments: AttachmentRef[];
	attachmentSetHash: string;
}

export async function planForDraft(
	ctx: ReadCtx,
	ref: ThreadRef,
	draftRef: DraftRef | null,
	options: Parameters<typeof loadPlanState>[3] = {}
): Promise<PlanForDraft> {
	const state = await loadPlanState(ctx, ref, draftRef, options);
	const attachments = await draftAttachments(ctx, draftRef, ref);
	return {
		threadRevision: state.threadRevision,
		completeness: state.completeness,
		items: state.items,
		isOverflow: state.isOverflow,
		stances: state.stances,
		planRevision: state.planRevision,
		attachments,
		attachmentSetHash: await attachmentSetHashOf(attachments.map((a) => a.id)),
	};
}
