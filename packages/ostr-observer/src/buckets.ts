/**
 * The published-count bucketing of plan §7.4, in the encoding spec 02 §2.3.1
 * makes normative.
 *
 * A `traffic-summary` carries raw counts for the auth signals (they are only
 * meaningful as ratios) but recipient counts and bounce rates are bucketed
 * before publication: a log entry is permanent, and "9 unique recipients last
 * Tuesday" is a much sharper instrument for correlating one mailbox than "fewer
 * than ten".
 *
 * ONE ENCODING, THE ONE THE SCORER READS. Both functions produce exactly what
 * `@owlat/ostr-core`'s scoring consumes, and `__tests__/traffic.test.ts` pins
 * that agreement against the live `POLICY_V1` — a producer and a scorer that
 * disagree about what a number means do not fail loudly, they quietly mis-score
 * honest senders for as long as the log lives, and every entry already written
 * stays wrong. The caps come from core too, so an observer cannot mint a bucket
 * the log would reject; clamping here is not defensive dressing, it is what
 * keeps an absurd input from turning into an unbounded weight in an arithmetic
 * that runs years later.
 */
import { MAX_BOUNCE_RATE_BUCKET, MAX_UNIQUE_RECIPIENTS_BUCKET } from '@owlat/ostr-core';

/**
 * Spec 02 §2.3.1 exactly: `0` for `0 ≤ n < 10`, `floor(log10(n))` for `n ≥ 10`,
 * capped at {@link MAX_UNIQUE_RECIPIENTS_BUCKET}. So bucket `1` is 10-99,
 * bucket `2` is 100-999, and an order of magnitude is `10^bucket`.
 *
 * The value is the POWER-OF-TEN EXPONENT, not the digit count. The two readings
 * differ by one, and this side must publish the one core reads: a thousand
 * recipients is `3`, never `4`.
 *
 * Bucket `0` therefore covers silence and nine recipients alike. That collapse
 * is the point rather than a lost distinction — "nothing" and "fewer than ten"
 * are indistinguishable at the k-anonymity floor anyway, and spending a bucket
 * on the difference would publish exactly the sharp small-number reading the
 * bucketing exists to blunt.
 *
 * Computed from the decimal length rather than `Math.log10`, because
 * floating-point rounding at exact powers of ten would otherwise put `1000` in
 * the `100-999` bucket on some inputs. Past `Number.MAX_SAFE_INTEGER` the
 * decimal length stops being trustworthy — `String(1e21)` is `'1e+21'`, five
 * characters — so anything that large takes the cap.
 */
export function logScaleBucket(count: number): number {
	if (!Number.isFinite(count) || count < 10) return 0;
	const whole = Math.floor(count);
	if (whole > Number.MAX_SAFE_INTEGER) return MAX_UNIQUE_RECIPIENTS_BUCKET;
	return Math.min(String(whole).length - 1, MAX_UNIQUE_RECIPIENTS_BUCKET);
}

/**
 * The three bounce bands of spec 02 §2.3.1. `POLICY_V1.bounce` reads the same
 * values back (`freeBucket` 0, `saturationBucket` 2); the tie between the two
 * sides is pinned by a test against the live policy object rather than by
 * importing scoring knobs into a producer, because where the *signal* goes
 * silent or saturates is a policy tunable while what the *number means* on the
 * wire is not.
 */
const BOUNCE_UNDER_ONE_PERCENT = 0;
const BOUNCE_ONE_TO_TEN_PERCENT = 1;
const BOUNCE_TEN_PERCENT_OR_MORE = 2;

/**
 * The DECADE OF THE BOUNCE PERCENTAGE — spec 02 §2.3.1 and `POLICY_V1.bounce`:
 * `0` is under 1%, `1` is 1% to under 10%, `2` is 10% and above. No value above
 * `2` is defined, and a producer whose rate exceeds the top band MUST publish
 * `2`.
 *
 * Not whole percent. `TrafficSummaryBody.bounceRateBucket` is validated against
 * {@link MAX_BOUNCE_RATE_BUCKET} (100), which is only the ceiling the log
 * refuses to store past; scoring clamps whatever arrives into `[0, 2]`, so a
 * whole-percent 7 would be read as "10% and above" and earn an honest sender
 * the maximum bounce penalty, indistinguishable from bouncing every message.
 *
 * Compared by cross-multiplication, not by dividing into a percentage: for
 * integer counts under 2^53 the comparison is exact, so a subject sitting on a
 * band edge (`1` bounce in `100`) lands in the same bucket every window instead
 * of flickering with the last bit of a quotient.
 *
 * A zero denominator is bucket 0: a subject that sent nothing bounced nothing.
 */
export function bounceRateBucket(bounced: number, messages: number): number {
	if (!Number.isFinite(bounced) || !Number.isFinite(messages) || messages <= 0) {
		return BOUNCE_UNDER_ONE_PERCENT;
	}
	const bad = Math.max(bounced, 0);
	if (bad * 100 < messages) return BOUNCE_UNDER_ONE_PERCENT;
	if (bad * 10 < messages) return BOUNCE_ONE_TO_TEN_PERCENT;
	return BOUNCE_TEN_PERCENT_OR_MORE;
}

export { MAX_BOUNCE_RATE_BUCKET, MAX_UNIQUE_RECIPIENTS_BUCKET };
