/**
 * The §7.4 publication floors, in one place because every publishable observer
 * document is gated on one of them and they have to be explainable together.
 *
 * Policy, not spec: an operator may RAISE any of these and only raise them. The
 * defaults are the smallest values that keep a published, permanently logged
 * count from describing one person's mail — or one person's complaint — so a
 * configuration that lowers one is not a stricter deployment with different
 * taste, it is a deployment publishing its own users. {@link
 * resolveKThresholds} therefore clamps every override up to the default, the
 * way `assertObserverEligible` clamps `minMailboxes`.
 *
 * The plan states the rule for both halves of a batch: "enough distinct traffic
 * and enough distinct reporters that log-bucketed counts never expose a single
 * user's action". {@link KThresholds.minMessages}/{@link
 * KThresholds.minRecipients} carry the traffic half; {@link
 * KThresholds.minReports}/{@link KThresholds.minReporters} carry the reporter
 * half, and a batch has to clear both.
 */

export interface KThresholds {
	/** Messages a subject must contribute before its counts are publishable. */
	minMessages: number;
	/** Distinct recipients those messages must have reached. */
	minRecipients: number;
	/** Reports a `spam-report-batch` must carry (used by `spamBatch.ts`). */
	minReports: number;
	/**
	 * DISTINCT reporters those reports must come from. Counting reports alone is
	 * not a k-floor: three reports from one mailbox tell the accused that one of
	 * its recipients at this observer complained three times, which is exactly
	 * the single-user exposure the floor exists to prevent.
	 */
	minReporters: number;
	/** Trap hits a `trap-hit` attestation must carry (used by `trapHit.ts`). A
	 *  hit count of one names one trap address as surely as it names one
	 *  message, and a burnt trap is a rotation cost the observer pays. */
	minTrapHits: number;
}

export const DEFAULT_K_THRESHOLDS: KThresholds = {
	minMessages: 20,
	minRecipients: 5,
	minReports: 3,
	minReporters: 3,
	minTrapHits: 3,
};

export interface KThresholdOverrides extends Partial<KThresholds> {
	/**
	 * TEST-ONLY. Lets the overrides go BELOW {@link DEFAULT_K_THRESHOLDS}, which
	 * ordinary configuration may never do.
	 *
	 * It exists because this package's own tests have to drive the publish path
	 * with two messages instead of twenty, and it is spelled `unsafe…` and kept
	 * off the operator config path on purpose: whoever wires instance settings
	 * into these thresholds in Wave 3 has to type the word "unsafe" to disable a
	 * k-anonymity floor, which is exactly the amount of friction that decision
	 * deserves.
	 */
	unsafeAllowBelowDefaultFloors?: boolean;
}

/**
 * Fill in the operator's overrides.
 *
 * Two rules, both refusals to publish more than asked:
 *
 * 1. A value that is not a non-negative safe integer is ignored — a threshold
 *    that will not compare is a threshold that silently publishes.
 * 2. A value below the default is raised to the default. Overrides ratchet the
 *    floors UP; the defaults are the §7.4 minimum, not a suggestion.
 *    {@link KThresholdOverrides.unsafeAllowBelowDefaultFloors} opts out, for
 *    tests.
 */
export function resolveKThresholds(overrides?: KThresholdOverrides): KThresholds {
	const clamp = overrides?.unsafeAllowBelowDefaultFloors !== true;
	const pick = (value: number | undefined, fallback: number): number => {
		if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fallback;
		return clamp ? Math.max(value, fallback) : value;
	};
	return {
		minMessages: pick(overrides?.minMessages, DEFAULT_K_THRESHOLDS.minMessages),
		minRecipients: pick(overrides?.minRecipients, DEFAULT_K_THRESHOLDS.minRecipients),
		minReports: pick(overrides?.minReports, DEFAULT_K_THRESHOLDS.minReports),
		minReporters: pick(overrides?.minReporters, DEFAULT_K_THRESHOLDS.minReporters),
		minTrapHits: pick(overrides?.minTrapHits, DEFAULT_K_THRESHOLDS.minTrapHits),
	};
}
