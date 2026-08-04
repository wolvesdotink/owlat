/**
 * SMTP failure categories — THE ONE VOCABULARY, shared by the classifier that
 * produces them (apps/mta/src/intelligence/smtpClassifier.ts) and the ramp gate
 * that consumes them (apps/api/convex/delivery/ramp/trailingBaselineGates.ts).
 *
 * WHY THIS LIVES IN `shared`. Standalone mode (plan D2/D14) is meant to lean
 * hardest on what receivers tell us in their own 4xx/5xx text: with no reference
 * arm and no third-party placement API, the SMTP conversation is the fastest
 * signal available to it. That makes the producer and the consumer of these
 * category names two halves of one contract across two deployables, and a
 * contract with two independent spellings is a contract that drifts silently —
 * the MTA would keep classifying `content_rejected` while the gate quietly
 * stopped recognising it, and the hard stop would simply never fire again.
 *
 * THE CONTRACT IS AGREED; THE WIRE BETWEEN ITS TWO HALVES IS NOT (issue #501).
 * The MTA classifies, and the ramp's block clause consumes — but no row carries
 * the per-category counts from one deployable to the other per (cell, arm), so
 * the clause is dormant in every shipped deployment and the ramp's fast signal
 * is the deferral RATE alone. Both suites still pin themselves to the samples
 * below, which is what keeps the halves from drifting apart while the transport
 * telemetry that joins them is built.
 *
 * PURE DATA. No regexes, no classification, no I/O: the pattern matching stays in
 * the MTA where the SMTP session is. This module only names the categories, says
 * which of them mean "the receiver is refusing this sending identity", and
 * carries the real response shapes both sides' tests pin themselves to.
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

/** Is this category a REFUSAL (a ramp hard stop), rather than rate pressure? */
export function isSmtpBlockCategory(value: string): value is SmtpFailureCategory {
	return SMTP_BLOCK_CATEGORIES.has(value as SmtpFailureCategory);
}

/**
 * One real 4xx/5xx response shape and the category the shipped classifier must
 * assign it.
 */
export interface SmtpBlockMessageSample {
	readonly smtpCode: number;
	readonly response: string;
	readonly enhancedCode?: string;
	readonly provider: 'gmail' | 'microsoft' | 'yahoo' | 'apple' | 'other';
	readonly category: SmtpFailureCategory;
	/** Whether this sample is a BLOCK (a ramp hard stop) or mere rate pressure. */
	readonly isBlock: boolean;
}

/**
 * THE PINNING FIXTURE, exported from production code ON PURPOSE.
 *
 * The MTA classifies these strings; the Convex gate halts on the categories they
 * produce. Neither side can import the other (they are separate deployables and
 * the cross-package import gate forbids it), so a fixture duplicated in two test
 * files would drift exactly as the vocabulary would. Both suites read THIS array
 * instead: `apps/mta` asserts `classifySmtpResponse` still maps each string to
 * its stated category, and `apps/api` asserts the block subset still produces the
 * ramp hard stop. A change to either side that breaks the pairing fails the
 * build on the other.
 *
 * Response text is taken from the shapes real receivers return; nothing here is
 * invented to make a regex pass.
 */
export const SMTP_BLOCK_MESSAGE_SAMPLES: readonly SmtpBlockMessageSample[] = [
	{
		smtpCode: 550,
		response:
			'550-5.7.1 [203.0.113.10] Our system has detected that this message is likely unsolicited mail. To reduce the amount of spam sent to Gmail, this message has been blocked.',
		enhancedCode: '5.7.1',
		provider: 'gmail',
		category: 'content_rejected',
		isBlock: true,
	},
	{
		smtpCode: 550,
		response:
			'550 5.7.1 Service unavailable, Client host [203.0.113.10] blocked using Spamhaus; To request removal from this list see https://www.spamhaus.org/query/ip/203.0.113.10',
		enhancedCode: '5.7.1',
		provider: 'microsoft',
		category: 'content_rejected',
		isBlock: true,
	},
	{
		smtpCode: 550,
		response: '550 5.7.23 Sender address rejected: SPF fail for sender domain example.com',
		enhancedCode: '5.7.23',
		provider: 'microsoft',
		category: 'policy_rejected',
		isBlock: true,
	},
	{
		smtpCode: 550,
		response:
			'550 5.7.25 [203.0.113.10] The IP address sending this message does not have a PTR record setup, or the corresponding forward DNS entry does not point to the sending IP.',
		enhancedCode: '5.7.25',
		provider: 'microsoft',
		category: 'policy_rejected',
		isBlock: true,
	},
	{
		smtpCode: 421,
		response:
			'421-4.7.23 The IP address sending this message does not have a PTR record setup, or the 421-4.7.23 corresponding forward DNS entry does not point to the sending IP.',
		enhancedCode: '4.7.23',
		provider: 'gmail',
		category: 'gmail_ip_identity',
		isBlock: true,
	},
	// ---- rate pressure, deliberately NOT blocks ----
	{
		smtpCode: 421,
		response:
			'421-4.7.28 Our system has detected an unusual rate of unsolicited mail originating from your IP address.',
		enhancedCode: '4.7.28',
		provider: 'gmail',
		category: 'gmail_rate_limited',
		isBlock: false,
	},
	{
		smtpCode: 421,
		response: '421 4.7.0 [TS03] All messages from 203.0.113.10 will be permanently deferred',
		provider: 'yahoo',
		category: 'yahoo_ts03',
		isBlock: false,
	},
	{
		smtpCode: 451,
		response: '451 4.3.2 The maximum number of concurrent connections has exceeded a limit',
		enhancedCode: '4.3.2',
		provider: 'microsoft',
		category: 'microsoft_resource_throttle',
		isBlock: false,
	},
	{
		smtpCode: 451,
		response: '451 4.7.1 Greylisting in effect, please try again later',
		provider: 'other',
		category: 'greylisted',
		isBlock: false,
	},
	{
		smtpCode: 452,
		response: '452 4.2.2 The email account that you tried to reach is over quota',
		enhancedCode: '4.2.2',
		provider: 'other',
		category: 'mailbox_full',
		isBlock: false,
	},
];
