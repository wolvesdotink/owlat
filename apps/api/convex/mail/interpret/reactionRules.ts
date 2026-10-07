/**
 * What a person's statement about an item does to it (SPEC §5 "Reactions"),
 * pure. `reactions.ts` loads the item, checks who may act, applies the plan
 * returned here and records it.
 *
 * Every lifecycle reaction is a human correction (`correction: {by, at,
 * kind}`), and the reducer never flips a corrected item's status: new
 * conflicting evidence only sets `isReviewNeeded` (`reducePlan.ts`). Status
 * moves follow `isLegalStatusEdge` with the `user` actor.
 *
 *   - markDone: open → done, completion `asserted` ("Marked done by you"),
 *     correction `markedDone`. Reversible with undo.
 *   - markReceived (them-items only): the same as markDone. The completion is
 *     `asserted`, not `recorded`: the person says it arrived, no operation of
 *     ours recorded it. That keeps it undoable like Mark done.
 *   - untrack ("Stop tracking"): open → untracked, correction `untracked`.
 *   - notARequest: open → untracked, correction `notARequest` (the model was
 *     wrong to make an item of it; `reactions.ts` also logs it for the eval).
 *     On an item already untracked only the correction changes.
 *   - confirmProposal: `verify: proposal` → `passed`, correction `confirmed`.
 *     The item is tracked from now on; its status does not change.
 *   - undo reverses the item's standing correction and clears it, so the item
 *     is as it was before the statement and the model may move it again:
 *       markedDone (done) → open, completion cleared;
 *       untracked / notARequest (untracked) → open;
 *       confirmed (open) → back to `verify: proposal`.
 *     With no correction to reverse, undo on an item the model closed (done,
 *     declined) reopens it and records a `reopened` correction, which then
 *     keeps the model from closing it again. Anything else (an open item with
 *     no correction, a replaced item) has nothing to undo.
 *
 * Undo acts on the item's correction whoever made it: every reader of the
 * thread may correct the item, so every reader may take a correction back
 * (the activity row says who did).
 */

import type { Doc } from '../../_generated/dataModel';
import type { ActivityType, ItemStatus } from '@owlat/shared/threadBrief';
import { isLegalStatusEdge } from '@owlat/shared/threadBriefRules';

/** The lifecycle reactions this module plans. */
export type LifecycleReaction =
	| 'markDone'
	| 'markReceived'
	| 'untrack'
	| 'notARequest'
	| 'confirmProposal'
	| 'undo';

/** The item fields a plan reads. */
export type ReactionItem = Pick<
	Doc<'threadItems'>,
	'status' | 'completion' | 'correction' | 'verify' | 'responsibility'
>;

type Correction = NonNullable<Doc<'threadItems'>['correction']>;

/**
 * The fields to write. `undefined` on `completion` / `correction` removes the
 * field (a Convex patch drops a key set to undefined); a key that is absent
 * from the object is left alone.
 */
export interface ReactionPatch {
	status?: ItemStatus;
	completion?: Doc<'threadItems'>['completion'];
	correction?: Correction;
	verify?: Doc<'threadItems'>['verify'];
}

export type ReactionPlan =
	| {
			ok: true;
			patch: ReactionPatch;
			/** Keys of `patch` that clear their field. */
			clears: Array<'completion' | 'correction'>;
			activity: ActivityType;
			statusFrom?: ItemStatus;
			statusTo?: ItemStatus;
	  }
	| { ok: false; reason: string };

function refuse(reason: string): ReactionPlan {
	return { ok: false, reason };
}

function close(
	item: ReactionItem,
	to: 'done' | 'untracked',
	correction: Correction,
	activity: ActivityType
): ReactionPlan {
	if (!isLegalStatusEdge(item.status, to, 'user')) {
		return refuse(`An item that is ${item.status} cannot become ${to}`);
	}
	return {
		ok: true,
		patch: { status: to, correction, ...(to === 'done' ? { completion: 'asserted' } : {}) },
		clears: to === 'done' ? [] : ['completion'],
		activity,
		statusFrom: item.status,
		statusTo: to,
	};
}

function reopen(item: ReactionItem, correction: Correction | null): ReactionPlan {
	if (!isLegalStatusEdge(item.status, 'open', 'user')) {
		return refuse(`An item that is ${item.status} cannot be reopened`);
	}
	return {
		ok: true,
		patch: { status: 'open', ...(correction ? { correction } : {}) },
		clears: correction ? ['completion'] : ['completion', 'correction'],
		activity: 'item_reopened',
		statusFrom: item.status,
		statusTo: 'open',
	};
}

/** Plan one lifecycle reaction by `userId` at `now`. Pure. */
export function planReaction(
	item: ReactionItem,
	reaction: LifecycleReaction,
	actor: { userId: string; now: number }
): ReactionPlan {
	const correction = (kind: Correction['kind']): Correction => ({
		by: actor.userId,
		at: actor.now,
		kind,
	});
	switch (reaction) {
		case 'markDone':
			return close(item, 'done', correction('markedDone'), 'item_closed');
		case 'markReceived':
			if (item.responsibility !== 'them') {
				return refuse('Only something someone else owes can be marked received');
			}
			return close(item, 'done', correction('markedDone'), 'item_closed');
		case 'untrack':
			return close(item, 'untracked', correction('untracked'), 'item_closed');
		case 'notARequest':
			if (item.status === 'untracked') {
				return {
					ok: true,
					patch: { correction: correction('notARequest') },
					clears: [],
					activity: 'item_corrected',
				};
			}
			return close(item, 'untracked', correction('notARequest'), 'item_corrected');
		case 'confirmProposal':
			if (item.verify !== 'proposal') return refuse('This item is not waiting to be confirmed');
			return {
				ok: true,
				patch: { verify: 'passed', correction: correction('confirmed') },
				clears: [],
				activity: 'proposal_confirmed',
			};
		case 'undo':
			return planUndo(item, correction('reopened'));
	}
}

function planUndo(item: ReactionItem, reopened: Correction): ReactionPlan {
	const kind = item.correction?.kind;
	if (kind === 'markedDone' && item.status === 'done') return reopen(item, null);
	if ((kind === 'untracked' || kind === 'notARequest') && item.status === 'untracked') {
		return reopen(item, null);
	}
	if (kind === 'confirmed' && item.verify === 'passed') {
		return {
			ok: true,
			patch: { verify: 'proposal' },
			clears: ['correction'],
			activity: 'item_corrected',
		};
	}
	if (item.status === 'done' || item.status === 'declined') return reopen(item, reopened);
	return refuse('There is nothing to undo on this item');
}

/** The patch as a Convex `db.patch` argument: cleared keys set to undefined. */
export function toDbPatch(plan: Extract<ReactionPlan, { ok: true }>): ReactionPatch {
	const patch: ReactionPatch = { ...plan.patch };
	for (const key of plan.clears) patch[key] = undefined;
	return patch;
}
