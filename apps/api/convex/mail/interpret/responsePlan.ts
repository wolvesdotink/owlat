/**
 * Response plans (SPEC §6): the store.
 *
 * A plan belongs to one draft (`draftResponsePlans`, a Postbox draft or the
 * draft on a team inbound message) and holds one stance per open item the
 * reply should cover, the self-check's coverage of the draft, the files it
 * says are attached and the promises it makes. Coverage is bound to the draft
 * hash, the thread's interpretation revision and every item's revision.
 *
 *   - `get({threadRef, draftRef?})`: what Answer mode shows. Without a stored
 *     plan (or without a draft yet) it still returns the default stances.
 *   - `setStances`: the owner's stance per item; `skip` deselects an item.
 *     Every write bumps the plan revision, so a coverage result computed for
 *     the stances before it no longer counts (review D1).
 *   - `adoptArrivalPlan`: the Reply Queue's prepared reply became a Postbox
 *     draft; its plan (and its check, still bound to the prepared text's hash)
 *     moves to that draft.
 *   - The node drafters' and the coverage check's reads and write are in
 *     `responsePlanDraft.ts`, the shared helpers in `responsePlanState.ts`
 *     (`deletePlansForDraft`: a discarded or sent draft's plans go with it).
 *
 * Reader rule: the thread's (mailbox access, or the shared-inbox reader gate).
 * Item text is read here unsealed for the prompt; claims and promises are
 * sealed at rest like every other derived text.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { PlanVerdict } from '@owlat/shared/threadBrief';
import { openMessageBody } from '../../lib/messageBody';
import { throwInvalidInput, throwNotFound } from '../../_utils/errors';
import { requireMailboxAccess } from '../permissions';
import { answerModeQuery, threadBriefMutation } from '../_helpers';
import { draftRefValidator, type DraftRef } from '../../lib/validators/responsePlan';
import type { MutationCtx } from '../../_generated/server';
import type { MutationSessionContext } from '../../lib/sessionOrganization';
import { rowMatchesThreadRef, threadRefValidator } from '../../lib/validators/threadRef';
import { requireThreadReader } from './threadAccess';
import type { PlanStance } from './responsePlanRules';
import {
	canRead,
	givenStanceValidator,
	deletePlansForDraft,
	isDraftLive,
	isDraftOfThread,
	loadPlanState,
	readPlanRow,
	upsertPlan,
	type PlanState,
} from './responsePlanState';

type ItemId = Id<'threadItems'>;

/** What Answer mode reads. Claim and promise texts are unsealed. */
export interface PlanView {
	threadRevision: number;
	stances: PlanStance<ItemId>[];
	coverage: Doc<'draftResponsePlans'>['coverage'];
	fileClaims: { text: string; spans: { start: number; end: number }[]; isMatched: boolean }[];
	newPromises: { text: string; spans: { start: number; end: number }[]; itemId?: ItemId }[];
	/** The stance revision now; a coverage result counts only for this revision. */
	planRevision: number;
	/** The stance revision the stored coverage was computed for. */
	checkedPlanRevision?: number;
	/** The draft text the stored coverage was computed for. */
	draftHash?: string;
	/** The thread revision and the COMPLETE item set the stored coverage read (review r3 F1). */
	checkedThreadRevision?: number;
	checkedItemRevisions: { itemId: ItemId; revision: number }[];
	verdict: PlanVerdict;
	/** The stored coverage was checked against other item revisions. */
	isStale: boolean;
	isCheckIncomplete: boolean;
}

async function toView(state: PlanState): Promise<PlanView> {
	const row = state.row;
	if (!row) {
		return {
			threadRevision: state.threadRevision,
			stances: state.stances,
			coverage: [],
			fileClaims: [],
			newPromises: [],
			planRevision: 0,
			checkedItemRevisions: [],
			verdict: 'pending',
			isStale: false,
			isCheckIncomplete: state.isOverflow,
		};
	}
	// The complete set: an item closed or removed since the check counts too.
	const revisions = new Map(row.itemRevisions.map((r) => [r.itemId as string, r.revision]));
	const isStale =
		row.threadRevision !== state.threadRevision ||
		row.itemRevisions.length !== state.items.length ||
		state.items.some((i) => revisions.get(i.id) !== i.revision);
	const isChecked = row.checkedPlanRevision === state.planRevision;
	return {
		threadRevision: state.threadRevision,
		stances: state.stances,
		coverage: row.coverage,
		fileClaims: await Promise.all(
			row.fileClaims.map(async (c) => ({
				text: await openMessageBody(c.text),
				spans: c.spans,
				isMatched: c.isMatched,
			}))
		),
		newPromises: await Promise.all(
			row.newPromises.map(async (p) => ({
				text: await openMessageBody(p.text),
				spans: p.spans,
				...(p.itemId ? { itemId: p.itemId } : {}),
			}))
		),
		planRevision: state.planRevision,
		...(row.checkedPlanRevision !== undefined
			? { checkedPlanRevision: row.checkedPlanRevision }
			: {}),
		...(row.draftHash ? { draftHash: row.draftHash } : {}),
		checkedThreadRevision: row.threadRevision,
		checkedItemRevisions: row.itemRevisions,
		verdict: isStale ? 'stale' : isChecked ? row.verdict : 'pending',
		isStale,
		isCheckIncomplete: state.isOverflow || row.isCheckIncomplete === true,
	};
}

// authz: the thread's reader rule (`canRead`: requireMailboxAccess for a
// Postbox thread, isSharedInboxReader + the inbox flag for a team thread),
// and the draft must reply in that thread.
export const get = answerModeQuery({
	args: { threadRef: threadRefValidator, draftRef: v.optional(draftRefValidator) },
	handler: async (ctx, args, session): Promise<PlanView | null> => {
		if (!(await canRead(ctx, args.threadRef, session))) return null;
		const draftRef = args.draftRef ?? null;
		if (draftRef && !(await isDraftOfThread(ctx, draftRef, args.threadRef))) return null;
		return toView(await loadPlanState(ctx, args.threadRef, draftRef));
	},
});

/** The caller may write this draft's plan: the thread's reader, and the draft's mailbox. */
async function requireDraftWriter(
	ctx: MutationCtx,
	threadRef: Parameters<typeof requireThreadReader>[1],
	draftRef: DraftRef,
	session: MutationSessionContext
): Promise<void> {
	await requireThreadReader(ctx, threadRef, session);
	if (draftRef.kind === 'arrivalDraft' || !(await isDraftOfThread(ctx, draftRef, threadRef))) {
		throwInvalidInput('That draft is not part of this thread');
	}
	if (draftRef.kind === 'mailDraft') {
		const draft = await ctx.db.get(draftRef.id);
		if (!draft || !(await requireMailboxAccess(ctx, draft.mailboxId, 'member', session)).ok) {
			throwInvalidInput('That draft is not part of this thread');
		}
	}
	if (!(await isDraftLive(ctx, draftRef))) throwNotFound('Draft');
}

/**
 * The owner's stance per item for one draft (`skip` leaves an item out of the
 * reply). Every given item must be open in the thread; stances the owner did
 * not touch keep their default. The write bumps the plan revision: the stored
 * coverage was computed for the stances before it and reads as pending until
 * the next check (review D1). Returns the new revision.
 */
// authz: requireDraftWriter: the thread's reader rule (requireThreadReader) and,
// for a Postbox draft, requireMailboxAccess on the draft's mailbox.
export const setStances = threadBriefMutation({
	args: {
		threadRef: threadRefValidator,
		draftRef: draftRefValidator,
		stances: v.array(givenStanceValidator),
	},
	handler: async (ctx, args, session): Promise<{ planRevision: number }> => {
		await requireDraftWriter(ctx, args.threadRef, args.draftRef, session);
		const state = await loadPlanState(ctx, args.threadRef, args.draftRef);
		const open = new Set<string>(state.items.map((i) => i.id));
		// An item of this thread that was closed since the choice was made is
		// skipped, not refused: a reply cannot cover it any more, and refusing
		// the whole write would block every later one (review r4 F1). An item
		// that is not this reply's to cover (another thread's, the other side's)
		// is still refused.
		const kept: PlanStance<ItemId>[] = [];
		for (const s of args.stances) {
			if (open.has(s.itemId)) {
				kept.push({ itemId: s.itemId, stance: s.stance, source: 'owner' });
				continue;
			}
			const item = await ctx.db.get(s.itemId);
			const isClosedHere =
				!!item && item.status !== 'open' && rowMatchesThreadRef(item, args.threadRef);
			if (!isClosedHere) throwInvalidInput('That item is not open in this thread');
		}
		const next = await loadPlanState(ctx, args.threadRef, args.draftRef, { chosen: kept });
		const planRevision = next.planRevision + 1;
		await upsertPlan(ctx, args.threadRef, args.draftRef, {
			threadRevision: next.row?.threadRevision ?? next.threadRevision,
			itemRevisions:
				next.row?.itemRevisions ?? next.items.map((i) => ({ itemId: i.id, revision: i.revision })),
			stances: next.stances,
			ownerInputs: next.row?.ownerInputs ?? [],
			coverage: next.row?.coverage ?? [],
			newPromises: next.row?.newPromises ?? [],
			fileClaims: next.row?.fileClaims ?? [],
			draftHash: next.row?.draftHash ?? '',
			verdict: 'pending',
			planRevision,
			...(next.row?.checkedPlanRevision !== undefined
				? { checkedPlanRevision: next.row.checkedPlanRevision }
				: {}),
			...(next.row?.attachmentSetHash ? { attachmentSetHash: next.row.attachmentSetHash } : {}),
			updatedAt: Date.now(),
		});
		return { planRevision };
	},
});

/**
 * The Reply Queue's prepared reply went into a Postbox draft (Answer mode put
 * it in the composer): its plan moves to that draft (review F16). The check
 * stays bound to the prepared text's hash, so it counts only while the draft
 * still says exactly that. A draft that already has a plan keeps its own.
 */
// authz: requireDraftWriter, as for setStances.
export const adoptArrivalPlan = threadBriefMutation({
	args: { threadRef: threadRefValidator, draftId: v.id('mailDrafts') },
	handler: async (ctx, args, session): Promise<null> => {
		if (args.threadRef.kind !== 'mail') throwInvalidInput('Only a Postbox thread prepares replies');
		const draftRef: DraftRef = { kind: 'mailDraft', id: args.draftId };
		await requireDraftWriter(ctx, args.threadRef, draftRef, session);
		const arrivalRef: DraftRef = { kind: 'arrivalDraft', id: args.threadRef.id };
		const arrival = await readPlanRow(ctx, arrivalRef);
		if (!arrival || (await readPlanRow(ctx, draftRef))) return null;
		const {
			_id: _rowId,
			_creationTime: _created,
			threadKind: _kind,
			mailThreadId: _thread,
			conversationThreadId: _conversation,
			draftKind: _draftKind,
			mailDraftId: _draft,
			inboundMessageId: _inbound,
			createdAt: _createdAt,
			...fields
		} = arrival;
		await upsertPlan(ctx, args.threadRef, draftRef, { ...fields, updatedAt: Date.now() });
		await deletePlansForDraft(ctx, arrivalRef);
		return null;
	},
});
