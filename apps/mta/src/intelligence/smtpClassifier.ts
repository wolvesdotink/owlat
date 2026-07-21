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

import type { DestinationProviderKey } from '../types.js';

export type SmtpFailureCategory =
	| 'greylisted' // Temporary — try again in a few minutes
	| 'rate_limited' // Too many connections/messages — back off
	| 'content_rejected' // Message content blocked (spam/virus) — no retry
	| 'policy_rejected' // Sender policy violation (DMARC/SPF fail) — no retry
	| 'mailbox_full' // Recipient mailbox full — soft, retry later
	| 'auth_required' // Authentication issue — defer
	| 'network_error' // DNS/connection issue — retry after backoff
	| 'gmail_rate_limited'
	| 'gmail_ip_identity'
	| 'gmail_tls_required'
	| 'yahoo_ts03'
	| 'yahoo_tss04'
	| 'microsoft_resource_throttle'
	| 'unknown'; // Unclassified — use default behavior

export interface SmtpClassification {
	/** Failure category */
	category: SmtpFailureCategory;
	/** Whether this failure should be retried */
	retryable: boolean;
	/** Suggested delay in milliseconds before retrying */
	suggestedDelayMs: number;
	/** Whether to count this as a bounce for circuit breaker purposes */
	countAsBounce: boolean;
	/** Short operator-facing dashboard explanation for recognized provider feedback. */
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
		return {
			category: 'greylisted',
			retryable: true,
			suggestedDelayMs: extractGreylistDelay(text),
			countAsBounce: false,
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

/**
 * Extract delay from greylisting messages that specify a wait time
 * e.g., "try again in 120 seconds" → 120000ms
 * Falls back to 2 minutes if no specific time found
 */
function extractGreylistDelay(text: string): number {
	const secondsMatch = text.match(/try again in (\d+) second/i);
	if (secondsMatch?.[1]) {
		return Math.max(parseInt(secondsMatch[1], 10) * 1000, 30_000); // At least 30s
	}

	const minutesMatch = text.match(/try again in (\d+) minute/i);
	if (minutesMatch?.[1]) {
		return Math.max(parseInt(minutesMatch[1], 10) * 60 * 1000, 30_000);
	}

	return 120_000; // Default 2 minutes for greylisting
}
