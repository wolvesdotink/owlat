/**
 * Enhanced SMTP Response Classifier
 *
 * Classifies outbound SMTP error responses using pattern matching
 * to distinguish between different failure types (greylisting, rate limiting,
 * content rejection, etc.) and determine optimal retry strategies.
 *
 * Used by the handler to make smarter retry decisions:
 * - Greylisted: retry sooner (2-5 minutes)
 * - Rate limited: back off more (15-30 minutes)
 * - Content rejected: don't retry (permanent)
 * - Policy rejection: don't retry (permanent)
 * - Authentication required: defer with longer delay
 */

import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';

/**
 * The category vocabulary now lives in `@owlat/shared/smtpBlockCategories`,
 * re-exported here so every existing importer keeps working unchanged.
 *
 * It moved because it grew a SECOND consumer in another deployable: the ramp
 * controller's standalone gate suite treats a subset of these
 * categories — the ones that mean "the receiver is refusing this sending
 * identity" rather than "slow down" — as a hard stop. Two independent spellings
 * of the same names across two apps would drift silently, and the failure mode
 * is the hard stop quietly never firing again. Same names, same values, no
 * behaviour change here.
 */
export type { SmtpFailureCategory } from '@owlat/shared/smtpBlockCategories';
import type { SmtpFailureCategory } from '@owlat/shared/smtpBlockCategories';

export interface SmtpClassification {
	/** Failure category */
	category: SmtpFailureCategory;
	/** Whether this failure should be retried */
	retryable: boolean;
	/** Suggested delay in milliseconds before retrying */
	suggestedDelayMs: number;
	/** Whether to count this as a bounce for circuit breaker purposes */
	countAsBounce: boolean;
	/**
	 * Short operator-facing explanation of what the receiver said and what we
	 * did about it — recognized provider feedback, or a remote-requested retry
	 * interval this classifier had to clamp. Surfaced on the deferral's
	 * delivery-log event, so a clamp is never silent.
	 */
	annotation?: string;
}

interface ProviderFeedbackSignature {
	category: SmtpFailureCategory;
	provider: DestinationProviderKey;
	enhancedCode?: string;
	responsePattern: RegExp;
	delayMs: number;
	annotation: string;
}

const PROVIDER_FEEDBACK: readonly ProviderFeedbackSignature[] = [
	{
		provider: 'gmail',
		category: 'gmail_rate_limited',
		enhancedCode: '4.7.28',
		responsePattern: /(?:^|\s)4\.7\.28(?:\s|$)/,
		delayMs: 30 * 60_000,
		annotation:
			'Gmail is limiting delivery volume; the shared Gmail throttle bucket was tightened.',
	},
	{
		provider: 'gmail',
		category: 'gmail_ip_identity',
		enhancedCode: '4.7.23',
		responsePattern: /(?:^|\s)4\.7\.23(?:\s|$)/,
		delayMs: 60 * 60_000,
		annotation:
			'Gmail rejected the sending IP identity; verify PTR, forward DNS, and EHLO alignment.',
	},
	{
		provider: 'gmail',
		category: 'gmail_tls_required',
		enhancedCode: '4.7.29',
		responsePattern: /(?:^|\s)4\.7\.29(?:\s|$)/,
		delayMs: 45 * 60_000,
		annotation:
			'Gmail reported an unencrypted delivery attempt; its provider profile requires TLS.',
	},
	{
		provider: 'yahoo',
		category: 'yahoo_ts03',
		responsePattern: /(?:^|[\s[(])ts03(?:[\s\])]|$)/i,
		delayMs: 30 * 60_000,
		annotation:
			'Yahoo temporarily deferred this sender (TS03); the Yahoo throttle bucket was tightened.',
	},
	{
		provider: 'yahoo',
		category: 'yahoo_tss04',
		responsePattern: /(?:^|[\s[(])tss04(?:[\s\])]|$)/i,
		delayMs: 60 * 60_000,
		annotation:
			'Yahoo imposed an extended sender deferral (TSS04); delivery will resume cautiously.',
	},
	{
		provider: 'microsoft',
		category: 'microsoft_resource_throttle',
		enhancedCode: '4.3.2',
		responsePattern: /(?:^|\s)4\.3\.2(?:\s|$)/,
		delayMs: 20 * 60_000,
		annotation:
			'Microsoft reported temporary system throttling (4.3.2); the Microsoft bucket was slowed.',
	},
];

// Greylisting patterns — ISPs asking us to try again later
const GREYLIST_PATTERNS =
	/greylist|graylist|try again later|please try again|try again in \d+ (second|minute)|temporarily deferred|temporarily rejected|not yet authorized|come back later/i;

// Rate limiting patterns — too many connections or messages
const RATE_LIMIT_PATTERNS =
	/too many connections|too many (simultaneous|concurrent)|rate limit|too many (messages|recipients|emails)|connection rate|throttl|too fast|slow down|exceeded.*limit|limit exceeded|too many session|message rate|sending rate|over quota.*connection/i;

// Content rejection patterns — message flagged as spam/phishing
const CONTENT_REJECT_PATTERNS =
	/spam|phishing|malware|virus|blocked.*content|content.*rejected|message.*rejected.*policy|banned.*content|url.*blacklist|url.*blocklist|dnsbl.*listed|rbl.*listed|spamhaus|barracuda/i;

// Policy rejection patterns — sender not authorized (SPF/DMARC/DKIM fail)
const POLICY_REJECT_PATTERNS =
	/spf.*fail|dmarc.*fail|dkim.*fail|not authorized|authentication.*required|sender.*verify|sender.*rejected|domain.*not.*allowed|from.*not.*permitted|reverse dns|rdns|ptr.*record|no ptr|helo.*rejected|ehlo.*rejected/i;

// Authentication patterns
const AUTH_PATTERNS =
	/authentication required|auth.*required|credentials.*required|starttls.*required|must.*authenticate|tls.*required/i;

// Mailbox full patterns (some ISPs return 4xx for this)
const MAILBOX_FULL_PATTERNS =
	/mailbox.*full|over.*quota|quota.*exceeded|insufficient.*storage|disk.*full|storage.*limit|no space/i;

/**
 * Classify an SMTP error response for optimal retry behavior
 *
 * @param smtpCode - SMTP response code (4xx or 5xx)
 * @param response - Full SMTP response string
 * @param enhancedCode - Optional RFC 3464 enhanced status code (e.g., "4.7.1")
 */
export function classifySmtpResponse(
	smtpCode: number | undefined,
	response: string,
	enhancedCode?: string,
	providerKey: DestinationProviderKey = 'other'
): SmtpClassification {
	const text = response.toLowerCase();
	const providerSignatures = PROVIDER_FEEDBACK.filter(
		(signature) => signature.provider === providerKey
	);
	// Prefer the separately parsed enhanced status code over tokens embedded in
	// free-form response text when a provider returns conflicting signals.
	const providerFeedback =
		providerSignatures.find(
			(signature) => signature.enhancedCode !== undefined && signature.enhancedCode === enhancedCode
		) ?? providerSignatures.find((signature) => signature.responsePattern.test(text));
	if (providerFeedback) {
		return {
			category: providerFeedback.category,
			retryable: true,
			suggestedDelayMs: providerFeedback.delayMs,
			countAsBounce: false,
			annotation: providerFeedback.annotation,
		};
	}

	// Check mailbox full first (can appear as 4xx or 5xx)
	if (MAILBOX_FULL_PATTERNS.test(text) || enhancedCode === '5.2.2' || enhancedCode === '4.2.2') {
		return {
			category: 'mailbox_full',
			retryable: true,
			suggestedDelayMs: 3600_000, // 1 hour
			countAsBounce: false,
		};
	}

	// Greylisting: retry sooner
	if (GREYLIST_PATTERNS.test(text)) {
		const greylist = extractGreylistDelay(text);
		return {
			category: 'greylisted',
			retryable: true,
			suggestedDelayMs: greylist.delayMs,
			countAsBounce: false,
			...(greylist.clampedFromMs === undefined
				? {}
				: { annotation: greylistClampAnnotation(greylist.clampedFromMs) }),
		};
	}

	// Rate limiting: back off significantly
	if (RATE_LIMIT_PATTERNS.test(text)) {
		return {
			category: 'rate_limited',
			retryable: true,
			suggestedDelayMs: 900_000, // 15 minutes
			countAsBounce: false,
		};
	}

	// Authentication required (check BEFORE policy rejection, since both share "authentication" keyword)
	if (AUTH_PATTERNS.test(text)) {
		return {
			category: 'auth_required',
			retryable: true,
			suggestedDelayMs: 600_000, // 10 minutes
			countAsBounce: false,
		};
	}

	// Content rejection: permanent for this message
	if (CONTENT_REJECT_PATTERNS.test(text)) {
		return {
			category: 'content_rejected',
			retryable: false,
			suggestedDelayMs: 0,
			countAsBounce: true,
		};
	}

	// Policy rejection (SPF/DKIM/DMARC): permanent
	if (POLICY_REJECT_PATTERNS.test(text)) {
		return {
			category: 'policy_rejected',
			retryable: false,
			suggestedDelayMs: 0,
			countAsBounce: true,
		};
	}

	// Fallback: use SMTP code class
	if (smtpCode && smtpCode >= 500) {
		return {
			category: 'unknown',
			retryable: false,
			suggestedDelayMs: 0,
			countAsBounce: true,
		};
	}

	if (smtpCode && smtpCode >= 400) {
		return {
			category: 'unknown',
			retryable: true,
			suggestedDelayMs: 30_000, // 30 seconds (default)
			countAsBounce: false,
		};
	}

	// Connection-level error (no SMTP code)
	return {
		category: 'network_error',
		retryable: true,
		suggestedDelayMs: 60_000, // 1 minute
		countAsBounce: false,
	};
}

/** A greylist wait must be at least this long — the shipped floor. */
const MIN_GREYLIST_DELAY_MS = 30_000;

/** No specific interval in the response text. */
const DEFAULT_GREYLIST_DELAY_MS = 120_000;

/**
 * CEILING FOR A RETRY INTERVAL DICTATED BY REMOTE RESPONSE TEXT.
 *
 * `extractGreylistDelay` is the ONLY delay in this MTA whose value comes from a
 * stranger. Every other rung is ours: the provider signatures above top out at
 * 60 minutes, a spent daily warming cap defers by at most `MAX_CAP_DEFER_MS`
 * (also 60 minutes), and a pressure-lengthened rung is capped at
 * `maximumPressureRetryDelayMs` (4 hours). Only this one was parsed unbounded,
 * so `try again in 999999 minutes` bought a ~694-day defer — three things go
 * wrong at once, none of them recoverable:
 *
 *  1. The successor sits in GroupMQ's `:delayed` ZSET holding its payload for
 *     the whole interval, in a Redis running `noeviction` under a memory cap.
 *  2. Its defer-handoff receipt is written with a `GOVERNED_MTA_MAX_MESSAGE_AGE_MS`
 *     TTL, so any wake beyond four days finds the receipt gone and
 *     `promoteDeferredHandoff` throws — the message dead-letters with the
 *     Convex Send left `queued` and no terminal edge ever emitted.
 *  3. A digit run long enough to overflow to `Infinity` came back out of
 *     `pressureAdjustedDelayMs` as `0`: an immediate re-enqueue, i.e. the hot
 *     loop, not a long wait.
 *
 * One hour is the ceiling because it is the longest rung this MTA asks for
 * anywhere else, and because greylisting (RFC 6647) is a per-message challenge
 * measured in minutes — no real implementation asks for more. A clamped rung
 * can still be lengthened to the shipped 4-hour pressure ceiling, and at hourly
 * rungs a message still gets ~96 attempts inside its four-day lifetime.
 */
export const MAX_GREYLIST_DELAY_MS = 60 * 60 * 1000;

interface GreylistDelay {
	delayMs: number;
	/** Set only when the remote asked for longer than the ceiling allows. */
	clampedFromMs?: number;
}

/** Apply the floor, then the ceiling, reporting whether the ceiling bit. */
function boundGreylistDelay(requestedMs: number): GreylistDelay {
	const floored = Math.max(requestedMs, MIN_GREYLIST_DELAY_MS);
	// Written as "inside the ceiling" rather than "over" it so a `NaN` or an
	// `Infinity` from an overlong digit run fails into the ceiling too.
	if (floored <= MAX_GREYLIST_DELAY_MS) return { delayMs: floored };
	return { delayMs: MAX_GREYLIST_DELAY_MS, clampedFromMs: requestedMs };
}

/**
 * Extract delay from greylisting messages that specify a wait time
 * e.g., "try again in 120 seconds" → 120000ms
 * Falls back to 2 minutes if no specific time found
 */
function extractGreylistDelay(text: string): GreylistDelay {
	const secondsMatch = text.match(/try again in (\d+) second/i);
	if (secondsMatch?.[1]) {
		return boundGreylistDelay(parseInt(secondsMatch[1], 10) * 1000);
	}

	const minutesMatch = text.match(/try again in (\d+) minute/i);
	if (minutesMatch?.[1]) {
		return boundGreylistDelay(parseInt(minutesMatch[1], 10) * 60 * 1000);
	}

	return { delayMs: DEFAULT_GREYLIST_DELAY_MS };
}

/** Name the clamp in the operator's own units, without leaking response text. */
function greylistClampAnnotation(requestedMs: number): string {
	const asked = Number.isFinite(requestedMs)
		? `${Math.round(requestedMs / 60_000)} minutes`
		: 'an interval too large to read';
	return `The receiver asked us to wait ${asked} before retrying; clamped to Owlat's ${MAX_GREYLIST_DELAY_MS / 60_000}-minute greylist ceiling.`;
}
