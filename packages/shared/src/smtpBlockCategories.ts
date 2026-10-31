/**
 * SMTP failure categories — THE ONE VOCABULARY, shared by the classifier that
 * produces them (apps/mta/src/intelligence/smtpClassifier.ts) and the ramp gate
 * that consumes them (apps/api/convex/delivery/ramp/trailingBaselineGates.ts).
 *
 * WHY THIS LIVES IN `shared`. Standalone mode is meant to lean
 * hardest on what receivers tell us in their own 4xx/5xx text: with no reference
 * arm and no third-party placement API, the SMTP conversation is the fastest
 * signal available to it. That makes the producer and the consumer of these
 * category names two halves of one contract across two deployables, and a
 * contract with two independent spellings is a contract that drifts silently —
 * the MTA would keep classifying `content_rejected` while the gate quietly
 * stopped recognising it, and the hard stop would simply never fire again.
 *
 * THE CONTRACT IS AGREED AND THE WIRE BETWEEN ITS TWO HALVES IS BUILT (issue
 * #501). The MTA classifies and puts the category on an `smtp.classified`
 * webhook as a TYPED field; Convex counts it per (cell, arm, UTC day) in
 * `analytics/smtpResponseCategories.ts` and the block clause divides. The
 * category NEVER travels as prose — a consumer re-parsing a sentence would be a
 * second classifier, free to disagree with this one, which is the drift this
 * module exists to prevent. Both halves read the category names and the block
 * set from here, which is what keeps them from drifting apart.
 *
 * PURE DATA. No regexes, no classification, no I/O: the pattern matching stays in
 * the MTA where the SMTP session is. This module only names the categories, says
 * which of them mean "the receiver is refusing this sending identity".
 */

/**
 * Every category the shipped classifier can return. The MTA's classifier
 * re-exports this type rather than declaring its own copy.
 */
export type SmtpFailureCategory =
	/** Temporary — try again in a few minutes. */
	| 'greylisted'
	/** Too many connections/messages — back off. */
	| 'rate_limited'
	/** Message content blocked (spam/virus) — no retry. */
	| 'content_rejected'
	/** Sender policy violation (DMARC/SPF/PTR) — no retry. */
	| 'policy_rejected'
	/** Recipient mailbox full — soft, retry later. */
	| 'mailbox_full'
	/** Authentication issue — defer. */
	| 'auth_required'
	/** DNS/connection issue — retry after backoff. */
	| 'network_error'
	| 'gmail_rate_limited'
	| 'gmail_ip_identity'
	| 'gmail_tls_required'
	| 'yahoo_ts03'
	| 'yahoo_tss04'
	| 'microsoft_resource_throttle'
	/** Unclassified — use default behavior. */
	| 'unknown';

/**
 * THE WHOLE VOCABULARY, as a set — the narrowing a stored `v.array(v.string())`
 * needs at the row-read boundary.
 *
 * DISTINCT FROM THE BLOCK SET BELOW, and the distinction matters: this answers
 * "is this string a category the classifier can emit?", which is the question a
 * row read has to answer before it may hand the array to anything typed. The
 * block set answers "is this category a refusal?", which is the question the
 * ramp's hard stop asks. Narrowing a row with the block set would silently drop
 * every rate-pressure category the gate is designed to receive and audit, so the
 * two guards are named for the two questions rather than reused for both.
 */
export const SMTP_FAILURE_CATEGORIES: ReadonlySet<SmtpFailureCategory> =
	new Set<SmtpFailureCategory>([
		'greylisted',
		'rate_limited',
		'content_rejected',
		'policy_rejected',
		'mailbox_full',
		'auth_required',
		'network_error',
		'gmail_rate_limited',
		'gmail_ip_identity',
		'gmail_tls_required',
		'yahoo_ts03',
		'yahoo_tss04',
		'microsoft_resource_throttle',
		'unknown',
	]);

/** Is this string a category the shipped classifier can emit? */
export function isSmtpFailureCategory(value: string): value is SmtpFailureCategory {
	return SMTP_FAILURE_CATEGORIES.has(value as SmtpFailureCategory);
}

/**
 * THE BLOCK SET: categories that mean the receiver is REFUSING THIS SENDING
 * IDENTITY, as opposed to asking us to slow down.
 *
 * The distinction is the whole point, and getting it wrong in either direction
 * is a defect:
 *
 *   - Rate pressure (`rate_limited`, `greylisted`, `yahoo_ts03`, `yahoo_tss04`,
 *     `gmail_rate_limited`, `microsoft_resource_throttle`) is NOT a block. It is
 *     already measured — every one of those responses lands in the deferral
 *     counter, and the deferral gate's own ceiling is the right instrument for
 *     it. Treating throttling as a block would halt a cell for succeeding.
 *   - `mailbox_full`, `auth_required` and `network_error` are about one
 *     recipient, our own credentials or the wire, not about our reputation.
 *   - What remains is the receiver saying our CONTENT is spam, our SENDER
 *     IDENTITY is not authorised, or our IP is not one it will take mail from.
 *     Those do not get better by sending more, so they are a hard stop rather
 *     than a multiplicative decrease.
 */
export const SMTP_BLOCK_CATEGORIES: ReadonlySet<SmtpFailureCategory> = new Set<SmtpFailureCategory>(
	[
		'content_rejected',
		'policy_rejected',
		// 4.7.23: "the IP you are sending from does not have the required
		// identity" — Gmail refusing the sending IP, not throttling it.
		'gmail_ip_identity',
	]
);
