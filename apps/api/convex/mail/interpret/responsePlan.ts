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
import { throwInvalidInput } from '../../_utils/errors';
import { requireMailboxAccess } from '../permissions';
import { answerModeQuery, threadBriefMutation } from '../_helpers';
import { draftRefValidator } from '../../lib/validators/threadBrief';
import { threadRefValidator } from '../../lib/validators/threadRef';
import { requireThreadReader } from './threadAccess';
import type { PlanStance } from './responsePlanRules';
import {
	canRead,
	givenStanceValidator,
	isDraftOfThread,
	loadPlanState,
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
	draftHash?: string;
	verdict: PlanVerdict;
	/** The stored coverage was checked against other item revisions. */
	isStale: boolean;
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
			verdict: 'pending',
			isStale: false,
		};
	}
	const revisions = new Map(row.itemRevisions.map((r) => [r.itemId as string, r.revision]));
	const isStale =
		row.threadRevision !== state.threadRevision ||
		state.items.some((i) => revisions.get(i.id) !== i.revision);
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
		...(row.draftHash ? { draftHash: row.draftHash } : {}),
		verdict: isStale ? 'stale' : row.verdict,
		isStale,
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

/**
 * The owner's stance per item for one draft (`skip` leaves an item out of the
 * reply). Every given item must be open in the thread; stances the owner did
 * not touch keep their default. The draft's stored coverage stays as it was
 * checked and reads as pending until the next check.
 */
export const setStances = threadBriefMutation({
	args: {
		threadRef: threadRefValidator,
		draftRef: draftRefValidator,
		stances: v.array(givenStanceValidator),
	},
	handler: async (ctx, args, session) => {
		await requireThreadReader(ctx, args.threadRef, session);
		if (!(await isDraftOfThread(ctx, args.draftRef, args.threadRef))) {
			throwInvalidInput('That draft is not part of this thread');
		}
		if (args.draftRef.kind === 'mailDraft') {
			const draft = await ctx.db.get(args.draftRef.id);
			if (!draft || !(await requireMailboxAccess(ctx, draft.mailboxId, 'member', session)).ok) {
				throwInvalidInput('That draft is not part of this thread');
			}
		}
		const given = args.stances.map((s): PlanStance<ItemId> => ({
			itemId: s.itemId,
			stance: s.stance,
			source: 'owner',
		}));
		const state = await loadPlanState(ctx, args.threadRef, args.draftRef, { chosen: given });
		const open = new Set<string>(state.items.map((i) => i.id));
		if (given.some((s) => !open.has(s.itemId))) {
			throwInvalidInput('That item is not open in this thread');
		}
		await upsertPlan(ctx, args.threadRef, args.draftRef, {
			threadRevision: state.row?.threadRevision ?? state.threadRevision,
			itemRevisions:
				state.row?.itemRevisions ??
				state.items.map((i) => ({ itemId: i.id, revision: i.revision })),
			stances: state.stances,
			ownerInputs: state.row?.ownerInputs ?? [],
			coverage: state.row?.coverage ?? [],
			newPromises: state.row?.newPromises ?? [],
			fileClaims: state.row?.fileClaims ?? [],
			draftHash: state.row?.draftHash ?? '',
			verdict: 'pending',
			updatedAt: Date.now(),
		});
		return null;
	},
});
