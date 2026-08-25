/**
 * Trap hits (plan §5, §6.3, D-row "traps").
 *
 * A spam trap is an address that never subscribed to anything, so mail arriving
 * at one was never requested — the cleanest list-hygiene negative there is. The
 * attestation publishes a COUNT and nothing else: the addresses themselves are
 * never published, because a published trap is a burnt trap, and rotating traps
 * is a cost the observer pays, not the registry.
 *
 * The same three rules that govern a spam-report batch govern this:
 *
 * 1. IT TRAVELS WITH ITS DENOMINATOR. "12 trap hits" means nothing without
 *    "…out of 4 000 messages"; the matching `traffic-summary` for the same
 *    subject and window is required, exactly as in §7.3, and hits may not
 *    exceed the messages the observer itself attested.
 * 2. IT HAS A K-FLOOR. One hit names one trap address as surely as a single
 *    report names one reporter, and a challenged hit burns that trap. Below
 *    `minTrapHits` the count is HELD for a wider window (§7.4).
 * 3. IT IS CAPPED AT SCORING TIME, NOT HERE. Single-observer trap evidence is
 *    weighted down by `@owlat/ostr-core`'s scoring (§6.3); an observer's job is
 *    to report honestly and let diversity weighting do the rest.
 */
import type {
	AttestationWindow,
	SubjectRef,
	TrafficSummaryBody,
	TrapHitBody,
} from '@owlat/ostr-core';
import { resolveKThresholds, type KThresholdOverrides } from './thresholds.js';
import { sameSubject, sameWindow, type AttestationDraft } from './types.js';

export interface TrapHitBatchInput {
	subject: SubjectRef;
	window: AttestationWindow;
	/** Messages delivered to never-subscribed trap addresses in the window. */
	hits: number;
	/** The traffic-summary for the same subject and window — the denominator. */
	summary: AttestationDraft<TrafficSummaryBody> | null | undefined;
	/** Operator overrides for the §7.4 floors. Raise-only: values below
	 *  {@link DEFAULT_K_THRESHOLDS} are clamped back up to it. */
	kThresholds?: KThresholdOverrides;
}

export type TrapHitRefusal =
	/** `hits` is not a non-negative safe integer. */
	| 'invalid-hit-count'
	/** No traffic-summary for this window (the §7.3 rule, applied to traps). */
	| 'missing-traffic-summary'
	/** The summary is about a different party. */
	| 'subject-mismatch'
	/** The summary covers a different window. */
	| 'window-mismatch'
	/** More trap hits than the observer's own attested volume for the subject. */
	| 'hits-exceed-attested-messages'
	/** Below the k-threshold: held for a wider window, not published (§7.4). */
	| 'below-trap-hit-threshold';

export type TrapHitBatchResult =
	| {
			ok: true;
			/** Submit both, together — the summary is the denominator. */
			drafts: [AttestationDraft<TrafficSummaryBody>, AttestationDraft<TrapHitBody>];
	  }
	| { ok: false; reason: TrapHitRefusal; held?: { hits: number; minTrapHits: number } };

/**
 * Draft a `trap-hit` alongside its traffic-summary, or say why not.
 *
 * `below-trap-hit-threshold` is a hold rather than an error, and `held` says how
 * far short the window is, so the caller can carry the count into a wider one.
 */
export function buildTrapHitBatch(input: TrapHitBatchInput): TrapHitBatchResult {
	const hits = input.hits;
	if (typeof hits !== 'number' || !Number.isSafeInteger(hits) || hits < 0) {
		return { ok: false, reason: 'invalid-hit-count' };
	}
	const summary = input.summary;
	if (summary === null || summary === undefined || summary.kind !== 'traffic-summary') {
		return { ok: false, reason: 'missing-traffic-summary' };
	}
	if (!sameSubject(summary.subject, input.subject)) {
		return { ok: false, reason: 'subject-mismatch' };
	}
	if (summary.window === undefined || !sameWindow(summary.window, input.window)) {
		return { ok: false, reason: 'window-mismatch' };
	}

	const { minTrapHits } = resolveKThresholds(input.kThresholds);
	if (hits < minTrapHits) {
		return { ok: false, reason: 'below-trap-hit-threshold', held: { hits, minTrapHits } };
	}
	if (hits > summary.body.messages) {
		return { ok: false, reason: 'hits-exceed-attested-messages' };
	}
	return {
		ok: true,
		drafts: [
			summary,
			{ kind: 'trap-hit', subject: input.subject, window: input.window, body: { hits } },
		],
	};
}
