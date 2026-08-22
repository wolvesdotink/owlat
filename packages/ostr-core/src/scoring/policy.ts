/**
 * `ostr-policy-v1` — every tunable of the scoring policy, in one frozen
 * object (plan §6). The policy identifier is part of every `ScoreResult`, so
 * a consumer can tell which constants produced a number; changing any value
 * here is a policy version bump (plan §6.2, D5), never an in-place edit.
 *
 * Invariant enforced by convention and by the tests: no scoring module may
 * contain a bare numeric literal that is a policy decision. Structural
 * constants of arithmetic (0, 1, 2, 10, 100) are the only exceptions.
 */

export const POLICY_VERSION = 'ostr-policy-v1';

/** Score bands, low to high. A score below `flaggedBelow` is `flagged`. */
export interface TierBoundaries {
	readonly flaggedBelow: number;
	readonly warnedBelow: number;
	readonly unknownBelow: number;
	readonly establishingBelow: number;
}

export const POLICY_V1 = Object.freeze({
	version: POLICY_VERSION,

	/**
	 * Score of a subject with no admissible evidence: mid-`unknown`. Positive
	 * signals lift it, negative signals push it down; both directions have
	 * room, so a clean newcomer and a burnt domain are not the same number.
	 */
	baseScore: 40,
	minScore: 0,
	maxScore: 100,

	/** Boundaries are exclusive upper bounds; `trusted` is the open top band. */
	tiers: Object.freeze({
		flaggedBelow: 15,
		warnedBelow: 30,
		unknownBelow: 45,
		establishingBelow: 70,
	}) satisfies TierBoundaries,

	/** Maximum magnitude, in score points, each signal can contribute. */
	weights: Object.freeze({
		complaintRate: 45,
		trapHits: 30,
		authConsistency: 18,
		historyVolume: 25,
		posture: 12,
		vouch: 10,
		bounceRate: 15,
	}),

	/**
	 * Complaint rate is a rate, not a count (plan §6.2): 10 reports on 1M
	 * messages is not 10 reports on 200. Below `freeRate` the signal is silent;
	 * at `saturationRate` it contributes its full weight.
	 *
	 * The rate is computed *per observer*, against that observer's own attested
	 * volume for the window it reported on (plan §7.3): a report batch is
	 * admissible only alongside its author's own traffic-summary, so
	 * under-attesting volume shrinks the attacker's own denominator and nobody
	 * else's. `minVolume` is the denominator floor that stops a handful of
	 * reports against a nearly empty window from saturating instantly. Both
	 * numerator and denominator are decayed on `negativeHalfLifeDays`, so they
	 * describe the same period.
	 */
	complaint: Object.freeze({
		freeRate: 0.0005,
		saturationRate: 0.01,
		minVolume: 100,
	}),

	/**
	 * Trap hits saturate on a decade scale. `singleObserverCapPoints` is the
	 * §6.3 bound on trap evidence that only one witness has seen.
	 */
	trap: Object.freeze({
		saturationHits: 100,
		singleObserverCapPoints: 8,
	}),

	/**
	 * Authentication is the hygiene floor: `floorPassRate` earns nothing, a
	 * perfect pass rate earns the full weight, and the resulting 0..1 quality
	 * factor also gates the history signal — a domain that cannot authenticate
	 * cannot accrue positive history at all (plan §6.2).
	 */
	auth: Object.freeze({
		floorPassRate: 0.8,
		dmarcShare: 0.5,
		dkimShare: 0.3,
		spfShare: 0.2,
	}),

	/**
	 * History length × volume, both log-scaled so megasenders do not drown
	 * everyone (plan §6.2). The signal is the product of the two factors, so
	 * volume without time and time without volume both stay small.
	 *
	 * History is measured against the log's own clock, never against an author's
	 * `window.from` alone (see `resolveHistory` in `facts.ts`), and `trusted` —
	 * "sustained clean history across diverse observers" — additionally requires
	 * `sustainedDays` of it. Without that floor a ring of fresh domains reaches
	 * `trusted` on the day it is registered: perfect self-reported
	 * authentication, self-published posture and mutual corroboration are all
	 * available immediately, and time is the one input that is not.
	 */
	history: Object.freeze({
		saturationDays: 365,
		saturationMessages: 1_000_000,
		sustainedDays: 90,
		maxTierWithoutSustainedHistory: 'establishing',
	}),

	/**
	 * Observer diversity is a multiplier on *observed* positive evidence only
	 * (auth consistency and history); self-asserted posture and vouches are
	 * excluded, so diversity can never help a subject that nobody has watched.
	 * Observers are counted by control group, not by name, so a wildcard DNS
	 * record does not buy corroboration (plan §6.3, §7.3).
	 */
	diversity: Object.freeze({
		minObservers: 2,
		stepPerObserver: 0.1,
		maxMultiplier: 1.5,
	}),

	/**
	 * Posture is cheap to obtain, so it is bounded twice: by
	 * `maxLiftPoints`, and by `maxTierWithoutObservedEvidence` — posture alone
	 * lifts `unknown` → `establishing` and never further (plan §6.2). Only the
	 * subject's own posture is scored (plan §5 lists the subject as its author),
	 * so it is neither a free-points nor a griefing primitive for third parties.
	 */
	posture: Object.freeze({
		maxLiftPoints: 12,
		maxTierWithoutObservedEvidence: 'establishing',
		dmarcRejectPoints: 4,
		dmarcQuarantinePoints: 2,
		strictAlignmentPoints: 1,
		dnssecPoints: 3,
		mtaStsPoints: 2,
		tlsRptPoints: 1,
		declaredIpsPoints: 1,
		registeredBeforePoints: 2,
		/** A registration older than this many days scores `registeredBeforePoints`. */
		registeredBeforeMinAgeDays: 365,
	}),

	/**
	 * Vouches are bounded positive (plan §6.4): each voucher's stake is scaled
	 * by its own standing, expired vouches are ignored and revoked ones are
	 * excluded, and the sum is capped regardless of how many vouchers pile in.
	 *
	 * `maxStakePoints` is the §6.4 stake bound — the total at-risk points one
	 * voucher of neutral standing may have outstanding *across all subjects*.
	 * A voucher underwriting a thousand tenants dilutes each vouch to a
	 * thousandth: reputation it only has once cannot be spent a thousand times.
	 */
	vouch: Object.freeze({
		pointsPerVouch: 4,
		capPoints: 10,
		maxStakePoints: 10,
	}),

	/**
	 * Bounce buckets are the log10 decade of the bounce rate in percent
	 * (`0` → under 1%, `1` → 1-10%, `2` → 10% and above). Below `freeBucket`
	 * the signal is silent; at `saturationBucket` it contributes full weight.
	 * A published bucket outside `[freeBucket, saturationBucket]` is clamped
	 * into it at fold time, so an absurd reading is worth exactly as much as
	 * the worst honest one and no more.
	 *
	 * NOTE: `types.ts` documents `bounceRateBucket` only as "bucketed in percent
	 * steps"; this block is the normative encoding for scoring purposes.
	 */
	bounce: Object.freeze({
		freeBucket: 0,
		saturationBucket: 2,
	}),

	/** Half-life, in days, of negative evidence. Redemption is possible (plan §6.2). */
	negativeHalfLifeDays: 60,

	/**
	 * Per-observer cap (plan §6.3, §7.3): the summed contribution of any one
	 * observer is scaled back to this magnitude, in either direction. No single
	 * witness, however good, moves a subject more than this.
	 */
	perObserverCapPoints: 15,

	/**
	 * Observer standing (plan §6.3). An observer's weight is its own score
	 * relative to `neutralScore`, clamped, then reduced by each upheld
	 * audit-finding against it and by each appeal it left unanswered.
	 *
	 * A finding counts once per (author control group, finding kind) and is
	 * scaled by its author's own standing, so neutralizing an observer costs
	 * standing rather than six throwaway records. `upheldAfterDays` is the v1
	 * reading of "upheld": the accused had at least the response window to
	 * contest the finding, and did not get it excluded.
	 */
	observerStanding: Object.freeze({
		neutralScore: 40,
		minWeight: 0.25,
		maxWeight: 1.5,
		/** Weight used for every witness at recursion depth 1 (see standing.ts). */
		baseWeight: 1,
		auditFindingPenalty: 0.5,
		auditPenaltyFloorWeight: 0.05,
		upheldAfterDays: 14,
		/**
		 * Responsiveness (plan §9.3). The first unanswered appeal in the visible
		 * evidence set is free — "volunteer operators go on holiday, and the
		 * penalty exists to deter fabrication, not participation" — and every
		 * further lapse costs `unansweredAppealPenalty` of the observer's weight.
		 */
		unansweredAppealGrace: 1,
		unansweredAppealPenalty: 0.75,
		/** Cost to an appellant of each appeal the named observer substantiated. */
		failedAppealPenalty: 0.9,
	}),

	/**
	 * `flagged` needs strong, multi-observer negative evidence (plan §6.3):
	 * fewer than `flaggedMinDistinctObservers` distinct negative witnesses caps
	 * the tier at `warned`, whatever the score says.
	 */
	flaggedMinDistinctObservers: 3,

	/** A contribution smaller than this counts as no evidence at all. */
	evidenceEpsilonPoints: 0.01,

	/**
	 * Appeals (plan §9.3). An appeal is only admissible within
	 * `filingWindowDays` of the contested attestation's inclusion; the named
	 * observer then has `responseWindowDays` to substantiate or retract, and
	 * silence past that window excludes the contested evidence.
	 *
	 * The two flooding guards: at most `maxPerSubjectPerWindow` appeals per
	 * subject per `rateWindowDays`, and at most one appeal per contested
	 * attestation — a subject cannot restart an observer's clock by re-filing.
	 */
	appeals: Object.freeze({
		responseWindowDays: 14,
		filingWindowDays: 60,
		rateWindowDays: 30,
		maxPerSubjectPerWindow: 5,
	}),

	/** Contributions and the score are rounded to this many decimals / to an integer. */
	contributionDecimals: 2,
});

export type PolicyV1 = typeof POLICY_V1;
