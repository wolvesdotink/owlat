/**
 * Read on arrival: how far an arriving message is read. Pure.
 *
 * Only a source the interpretation run classifies as display-only (no reply
 * candidate, no item it could move, nothing else in flight) is ever read less
 * than in full; everything else keeps today's eager full read and today's
 * budget behaviour, so open work is never lowered by memory, rules or budget.
 *
 * The first matching row of the decision table wins:
 *
 *   1  AI off or not eligible                                  none
 *   2  not display-only                                        full
 *   3  read on arrival off                                     deferred
 *   4  sender unsubscribed or auto-archived                    none
 *   5  security mail                                           none
 *   6  budget refused                                          count
 *   7  override digest (a message-scope Fix)                   count
 *   8  a sendToDigest rule or sender digest, no exact wording  count
 *   9  override needs_me or today                              full
 *  10  override updates, no exact-wording candidate            gist
 *  11  exact-wording candidate                                 full
 *  12  newsletter or promotion                                 count
 *  13  notification or receipt                                 gist
 *  14  anything else (person, other)                           full
 *
 * The budget row comes before the overrides, so an override can never buy a
 * read past the budget, and the overrides come before the category. An
 * exact-wording candidate (changed bank details, a legal notice, an invoice
 * with payment details) is never counted for its category, a digest rule or
 * the sender's digest status: only the budget and the person's own
 * message-scope digest Fix still count it, and only a Fix made after the
 * candidate arrived (the caller drops an older one: `doesThreadOverrideHold`).
 *
 * A gist or count from rows 6–13 is upgradeable: a later source
 * of the thread that needs a full read reads it first. Rows 1, 4 and 5 are terminal
 * exclusions, never upgraded and never in anyone's way.
 */

import type {
	ArrivalReasonKey,
	ChooseArrivalDepthInput,
	ChooseArrivalDepthResult,
	ReasonKey,
} from './arrival';

/** The reason keys this decision writes (rendered from `postbox.arrival.reason.*`). */
export const ARRIVAL_DEPTH_REASONS = {
	aiOff: 'arrival.reason.aiOff',
	ineligible: 'arrival.reason.ineligible',
	openWork: 'arrival.reason.openWork',
	readOnArrivalOff: 'arrival.reason.readOnArrivalOff',
	senderStatus: 'arrival.reason.senderStatus',
	security: 'arrival.reason.security',
	budget: 'arrival.reason.budget',
	digest: 'arrival.reason.digest',
	override: 'arrival.reason.override',
	category: 'arrival.reason.category',
	exactWording: 'arrival.reason.exactWording',
} as const satisfies Record<string, ArrivalReasonKey | `arrival.reason.${string}`>;

/** {@link chooseArrivalDepth}'s answer with the row's upgrade rule. */
export interface ArrivalDepthChoice extends ChooseArrivalDepthResult {
	/** A gist or count of rows 6–13: a later full read of the thread reads this source first. */
	isUpgradeable: boolean;
}

function choice(
	depth: ChooseArrivalDepthResult['depth'],
	reasonKeys: ReasonKey[],
	isUpgradeable = false
): ArrivalDepthChoice {
	return { depth, reasonKeys, isUpgradeable };
}

function categoryReason(i: ChooseArrivalDepthInput): ReasonKey {
	return {
		key: ARRIVAL_DEPTH_REASONS.category,
		params: { category: i.category, source: i.categorySource },
	};
}

/** The decision table of the module doc. Pure. */
export function chooseArrivalDepth(i: ChooseArrivalDepthInput): ArrivalDepthChoice {
	// 1. Nothing is read at all.
	if (!i.isAiOn) return choice('none', [{ key: ARRIVAL_DEPTH_REASONS.aiOff }]);
	if (!i.isEligible) return choice('none', [{ key: ARRIVAL_DEPTH_REASONS.ineligible }]);
	// 2. Open work: today's eager path, untouched.
	if (!i.isDisplayOnly) return choice('full', [{ key: ARRIVAL_DEPTH_REASONS.openWork }]);
	// 3. The preference is off: the caller defers screen-only work to the open.
	if (!i.isReadOnArrival) {
		return choice('deferred', [{ key: ARRIVAL_DEPTH_REASONS.readOnArrivalOff }]);
	}
	// 4–5. Terminal exclusions.
	if (i.senderStatus === 'unsubscribed' || i.senderStatus === 'auto_archive') {
		return choice('none', [
			{ key: ARRIVAL_DEPTH_REASONS.senderStatus, params: { status: i.senderStatus } },
		]);
	}
	if (i.isSecurityMail) return choice('none', [{ key: ARRIVAL_DEPTH_REASONS.security }]);
	// 6. Budget before every override.
	if (i.budget === 'refused') return choice('count', [{ key: ARRIVAL_DEPTH_REASONS.budget }], true);
	// 7–10. Overrides before the category. A message-scope digest Fix is the
	// person's own choice for this conversation; a digest rule or the sender's
	// digest status never counts an exact-wording candidate.
	if (i.placementOverride === 'digest') {
		return choice(
			'count',
			[{ key: ARRIVAL_DEPTH_REASONS.digest, params: { by: 'override' } }],
			true
		);
	}
	if (!i.isExactWordingCandidate && i.ruleDepthHint === 'count') {
		return choice('count', [{ key: ARRIVAL_DEPTH_REASONS.digest, params: { by: 'rule' } }], true);
	}
	if (!i.isExactWordingCandidate && i.senderStatus === 'digest') {
		return choice('count', [{ key: ARRIVAL_DEPTH_REASONS.digest, params: { by: 'sender' } }], true);
	}
	if (i.placementOverride === 'needs_me' || i.placementOverride === 'today') {
		const reason = {
			key: ARRIVAL_DEPTH_REASONS.override,
			params: { placement: i.placementOverride },
		};
		return choice('full', [reason]);
	}
	if (i.placementOverride === 'updates' && !i.isExactWordingCandidate) {
		const reason = { key: ARRIVAL_DEPTH_REASONS.override, params: { placement: 'updates' } };
		return choice('gist', [reason], true);
	}
	// 11. The wording itself matters: read in full, whatever the category.
	if (i.isExactWordingCandidate) {
		return choice('full', [categoryReason(i), { key: ARRIVAL_DEPTH_REASONS.exactWording }]);
	}
	// 12–14. The category.
	if (i.category === 'newsletter' || i.category === 'promotion') {
		return choice('count', [categoryReason(i)], true);
	}
	if (i.category === 'notification' || i.category === 'receipt') {
		return choice('gist', [categoryReason(i)], true);
	}
	return choice('full', [categoryReason(i)]);
}
