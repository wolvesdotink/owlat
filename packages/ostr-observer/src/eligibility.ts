/**
 * The §7.4 observer gate.
 *
 * For a single-mailbox observer the observer identity IS the user identity:
 * `mx.hinterland.camp` attesting "received mail from X, one report" names the
 * person who reported, and no amount of window-widening fixes that — the
 * k-anonymity floor has a floor of its own. Observer mode therefore ships off
 * by default and hard-disables below a mailbox-count threshold; small instances
 * consume the registry without contributing until pooled submission through an
 * aggregation relay exists (plan §7.4, D6).
 *
 * This module is the whole gate. It is pure so the decision can be logged,
 * tested and shown in the UI; Wave 3 wires `enabled` and `mailboxCount` to
 * instance config and refuses to construct the observer pipeline when the
 * answer is `eligible: false`.
 */

/** Default mailbox floor below which observer mode is hard-disabled (§7.4). */
export const OBSERVER_MIN_MAILBOXES = 5;

export type ObserverIneligibilityReason =
	/** The operator has not opted in. Observer mode is off by default. */
	| 'disabled'
	/** The caller could not say how many mailboxes the instance serves; an
	 *  unproven count cannot clear the floor. */
	| 'unknown-mailbox-count'
	/** Fewer mailboxes than the threshold: publishing would expose the user. */
	| 'below-mailbox-threshold';

export interface ObserverEligibilityInput {
	/** Operator opt-in. */
	enabled: boolean;
	/** Distinct mailboxes whose mail this instance observes. */
	mailboxCount: number;
	/** Override for deployments with a stricter floor; never a looser one —
	 *  a value below {@link OBSERVER_MIN_MAILBOXES} is ignored. */
	minMailboxes?: number;
}

export type ObserverEligibility =
	| { eligible: true; mailboxCount: number; minMailboxes: number }
	| { eligible: false; reason: ObserverIneligibilityReason; minMailboxes: number };

/**
 * Decide whether this instance may act as an observer at all.
 *
 * Named `assert…` for the role it plays at the composition root — it is the one
 * call standing between an opt-in flag and the log — but it returns a verdict
 * rather than throwing, because "you are one mailbox short" is something a UI
 * has to be able to explain.
 */
export function assertObserverEligible(input: ObserverEligibilityInput): ObserverEligibility {
	const requested = input.minMailboxes;
	const minMailboxes =
		typeof requested === 'number' && Number.isSafeInteger(requested)
			? Math.max(requested, OBSERVER_MIN_MAILBOXES)
			: OBSERVER_MIN_MAILBOXES;

	if (input.enabled !== true) return { eligible: false, reason: 'disabled', minMailboxes };

	const count = input.mailboxCount;
	if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
		return { eligible: false, reason: 'unknown-mailbox-count', minMailboxes };
	}
	if (count < minMailboxes) {
		return { eligible: false, reason: 'below-mailbox-threshold', minMailboxes };
	}
	return { eligible: true, mailboxCount: count, minMailboxes };
}
