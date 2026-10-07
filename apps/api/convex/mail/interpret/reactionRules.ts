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
 *     An unconfirmed claim's held changes to a tracked item
 *     (`pendingUpdate`: quotes, deadline, amount, options) are applied and
 *     cleared, on a proposal item or on a tracked one ("Check this change").
 *     Both record the `confirmed` correction, which an ordered replay keeps,
 *     and a `confirmedFrom` snapshot: which kind of confirmation it was, the
 *     item's verify, correction, deadline, amount, options and held update
 *     before it, and the quotes it added. The status does not change.
 *   - undo reverses the item's standing correction, so the item is as it was
 *     before the statement and the model may move it again:
 *       markedDone (done) → open, completion cleared;
 *       untracked / notARequest (untracked) → open;
 *       confirmed → the `confirmedFrom` snapshot, exactly: a confirmed
 *         proposal is a proposal again, a confirmed held change gets its old
 *         deadline, amount and options back with the held update pending
 *         again, the added quotes go, and the correction before the
 *         confirmation is restored. (A confirmation with no snapshot, written
 *         before snapshots existed, goes back to `verify: proposal`.)
 *     A Mark done or Stop tracking made on a confirmed item, once undone,
 *     puts the `confirmed` correction back rather than clearing it, so the
 *     confirmation (and its snapshot) still stands.
 *     With no correction to reverse, undo on an item the model closed (done,
 *     declined) reopens it and records a `reopened` correction, which then
 *     keeps the model from closing it again (a confirmation that stood on it
 *     is superseded: its snapshot is dropped). Anything else (an open item with
 *     no correction, a replaced item) has nothing to undo.
 *
 * Undo acts on the item's correction whoever made it: every reader of the
 * thread may correct the item, so every reader may take a correction back
 * (the activity row says who did).
 */

import type { Doc } from '../../_generated/dataModel';
import type { ActivityType, ItemStatus } from '@owlat/shared/threadBrief';
import { isLegalStatusEdge } from '@owlat/shared/threadBriefRules';
import { evidenceKey } from './reducePlan';

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
	| 'status'
	| 'completion'
	| 'correction'
	| 'verify'
	| 'responsibility'
	| 'evidence'
	| 'pendingUpdate'
	| 'due'
	| 'amount'
	| 'options'
	| 'confirmedFrom'
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
	evidence?: Doc<'threadItems'>['evidence'];
	due?: Doc<'threadItems'>['due'];
	amount?: Doc<'threadItems'>['amount'];
	options?: Doc<'threadItems'>['options'];
	pendingUpdate?: Doc<'threadItems'>['pendingUpdate'];
	confirmedFrom?: Doc<'threadItems'>['confirmedFrom'];
}

/** Keys a plan may remove from the item. */
type ClearableKey =
	| 'completion'
	| 'correction'
	| 'pendingUpdate'
	| 'confirmedFrom'
	| 'due'
	| 'amount'
	| 'options';

export type ReactionPlan =
	| {
			ok: true;
			patch: ReactionPatch;
			/** Keys of `patch` that clear their field. */
			clears: ClearableKey[];
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

function reopen(item: ReactionItem, given: Correction | null): ReactionPlan {
	if (!isLegalStatusEdge(item.status, 'open', 'user')) {
		return refuse(`An item that is ${item.status} cannot be reopened`);
	}
	// Taking back a statement made on a confirmed item leaves the confirmation.
	const correction = given ?? item.confirmedFrom?.confirmation ?? null;
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
		case 'confirmProposal': {
			const isProposal = item.verify === 'proposal';
			if (!isProposal && !item.pendingUpdate) {
				return refuse('This item is not waiting to be confirmed');
			}
			// The `confirmed` correction is what an ordered replay keeps
			// (`replay.preserveHumanState`): the confirmed deadline, amount and
			// options survive a rebuild of the thread.
			const confirmation = correction('confirmed');
			return {
				ok: true,
				patch: {
					...heldChanges(item),
					...(isProposal ? { verify: 'passed' as const } : {}),
					correction: confirmation,
					confirmedFrom: snapshotBeforeConfirm(
						item,
						isProposal ? 'proposal' : 'heldChange',
						confirmation
					),
				},
				clears: item.pendingUpdate ? ['pendingUpdate'] : [],
				activity: 'proposal_confirmed',
			};
		}
		case 'undo':
			return planUndo(item, correction('reopened'));
	}
}

/** A held update folded into the item: new quotes appended, fields replaced. Pure. */
export function heldChanges(item: Pick<ReactionItem, 'evidence' | 'pendingUpdate'>): ReactionPatch {
	const held = item.pendingUpdate;
	if (!held) return {};
	const seen = new Set(item.evidence.map(evidenceKey));
	return {
		evidence: [...item.evidence, ...held.evidence.filter((e) => !seen.has(evidenceKey(e)))],
		...(held.due ? { due: held.due } : {}),
		...(held.amount ? { amount: held.amount } : {}),
		...(held.options ? { options: held.options } : {}),
	};
}

type ConfirmedFrom = NonNullable<Doc<'threadItems'>['confirmedFrom']>;

/** What a confirmation is about to change, for {@link planUndo}. Pure. */
export function snapshotBeforeConfirm(
	item: ReactionItem,
	kind: ConfirmedFrom['kind'],
	confirmation: Correction
): ConfirmedFrom {
	const seen = new Set(item.evidence.map(evidenceKey));
	const added = (item.pendingUpdate?.evidence ?? [])
		.map(evidenceKey)
		.filter((key) => !seen.has(key));
	return {
		kind,
		confirmation,
		verify: item.verify,
		...(item.correction ? { correction: item.correction } : {}),
		...(item.due ? { due: item.due } : {}),
		...(item.amount ? { amount: item.amount } : {}),
		...(item.options ? { options: item.options } : {}),
		...(item.pendingUpdate ? { pendingUpdate: heldFields(item.pendingUpdate) } : {}),
		addedEvidenceKeys: [...new Set(added)],
	};
}

function heldFields(held: NonNullable<ReactionItem['pendingUpdate']>) {
	return {
		...(held.due ? { due: held.due } : {}),
		...(held.amount ? { amount: held.amount } : {}),
		...(held.options ? { options: held.options } : {}),
	};
}

/**
 * Undo a confirmation from its snapshot: every value back as it was, and the
 * quotes it moved onto the item back into the held update. Pure.
 */
function undoConfirmation(item: ReactionItem, from: ConfirmedFrom): ReactionPlan {
	const added = new Set(from.addedEvidenceKeys);
	const moved = item.evidence.filter((e) => added.has(evidenceKey(e)));
	const patch: ReactionPatch = {
		verify: from.verify,
		evidence: item.evidence.filter((e) => !added.has(evidenceKey(e))),
	};
	const clears: ClearableKey[] = ['confirmedFrom'];
	if (from.correction) patch.correction = from.correction;
	else clears.push('correction');
	if (from.due) patch.due = from.due;
	else clears.push('due');
	if (from.amount) patch.amount = from.amount;
	else clears.push('amount');
	if (from.options) patch.options = from.options;
	else clears.push('options');
	if (from.pendingUpdate) patch.pendingUpdate = { ...from.pendingUpdate, evidence: moved };
	else clears.push('pendingUpdate');
	return { ok: true, patch, clears, activity: 'item_corrected' };
}

function planUndo(item: ReactionItem, reopened: Correction): ReactionPlan {
	const kind = item.correction?.kind;
	if (kind === 'markedDone' && item.status === 'done') return reopen(item, null);
	if ((kind === 'untracked' || kind === 'notARequest') && item.status === 'untracked') {
		return reopen(item, null);
	}
	if (kind === 'confirmed' && item.status === 'open' && item.confirmedFrom) {
		return undoConfirmation(item, item.confirmedFrom);
	}
	if (kind === 'confirmed' && item.status === 'open' && item.verify === 'passed') {
		return {
			ok: true,
			patch: { verify: 'proposal' },
			clears: ['correction'],
			activity: 'item_corrected',
		};
	}
	if (item.status === 'done' || item.status === 'declined') {
		// The model closed it: reopen and lock. A confirmation that stood is
		// superseded by this statement, so its snapshot goes.
		const plan = reopen(item, reopened);
		if (plan.ok && item.confirmedFrom) plan.clears.push('confirmedFrom');
		return plan;
	}
	return refuse('There is nothing to undo on this item');
}

/** The patch as a Convex `db.patch` argument: cleared keys set to undefined. */
export function toDbPatch(plan: Extract<ReactionPlan, { ok: true }>): ReactionPatch {
	const patch: ReactionPatch = { ...plan.patch };
	for (const key of plan.clears) patch[key] = undefined;
	return patch;
}
