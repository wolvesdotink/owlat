/**
 * Feedback Loop (FBL) / ARF Abuse Report Processor
 *
 * Parses ARF (Abuse Reporting Format) reports from ISPs
 * when users click "Report Spam". These arrive as multipart/report
 * MIME messages with feedback-type: abuse.
 *
 * Includes deduplication to prevent the same complaint from being
 * counted twice in reputation metrics.
 */

import type { ParsedMessage } from '@owlat/mail-message';
import type { BounceClassification } from '../types.js';
import { logger } from '../monitoring/logger.js';
import { parseVerpAddress, isVerpSigningEnabled } from './verp.js';
import { addressText } from '../inbound/parsedAddress.js';
import type { ReportPart } from './reportParts.js';
import { parseCampaignFromFeedbackId } from '../intelligence/campaignComplaintRate.js';
import { createHash } from 'crypto';
export {
	completeComplaint,
	releaseComplaint,
	reserveComplaint,
	runComplaintEffect,
} from './complaintDedupStore.js';
export type { ComplaintDedupReservation, ComplaintDedupResult } from './complaintDedupStore.js';

/**
 * Generate a deduplication key from complaint content.
 * Uses a hash of the original message ID (if available) or content fingerprint.
 */
export function generateDedupKey(parsed: ParsedMessage, originalMessageId?: string): string {
	if (originalMessageId) {
		return originalMessageId;
	}
	// Fallback: hash subject + from + first 200 chars of body
	const fingerprint = `${parsed.subject ?? ''}|${addressText(parsed.from) ?? ''}|${(parsed.text ?? '').slice(0, 200)}`;
	return createHash('sha256').update(fingerprint).digest('hex').slice(0, 32);
}

/**
 * The two machine-readable MIME parts of an RFC 5965 ARF report.
 *
 * An ARF report is a `multipart/report; report-type=feedback-report` body with
 * three sub-parts (RFC 5965 §2):
 *   1. `text/plain` — a human-readable description (ignored for attribution).
 *   2. `message/feedback-report` — the STRUCTURED, key:value report fields
 *      (`Feedback-Type`, `Original-Mail-From`, `Original-Rcpt-To`,
 *      `Reported-Domain`, `Source-IP`, …). This is the authoritative signal.
 *   3. `message/rfc822` (or `text/rfc822-headers`) — a copy of the ORIGINAL
 *      message we sent, which carries our `Feedback-ID` / `X-Owlat-*` headers.
 *
 * The previous implementation substring-scanned every part indiscriminately,
 * so a `Feedback-ID` in the original message and a `Original-Rcpt-To` in the
 * feedback-report part were read from whichever attachment happened to contain
 * them. We now split the two parts by content-type so each field is read from
 * the part RFC 5965 actually defines it in. When an ISP fails to set the
 * sub-part content-types, both fall back to a heuristic split / the raw body so
 * a malformed-but-genuine report still attributes.
 */
interface ArfParts {
	/** Decoded text of the `message/feedback-report` part (structured fields). */
	feedbackReport: string;
	/** Decoded text of the `message/rfc822` original-message part. */
	originalMessage: string;
}

/**
 * Flatten a `content-type` header (string, or mailparser's structured
 * `{ value, params }` object) to a lowercase `type; k=v; …` string so the
 * `report-type=feedback-report` param survives the ARF detection. A plain
 * `String(obj)` would collapse the structured form to `[object Object]` and
 * drop the param — the very reason the multipart/report part went undetected.
 */
function flattenContentType(raw: unknown): string {
	if (typeof raw === 'string') return raw.toLowerCase();
	if (raw && typeof raw === 'object') {
		const obj = raw as { value?: unknown; params?: Record<string, unknown> };
		const value = typeof obj.value === 'string' ? obj.value : '';
		const params = obj.params ?? {};
		const paramStr = Object.entries(params)
			.map(([k, v]) => `${k}=${String(v)}`)
			.join('; ');
		return `${value}${paramStr ? `; ${paramStr}` : ''}`.toLowerCase();
	}
	return String(raw ?? '').toLowerCase();
}

/**
 * Attempt to parse an incoming email as an ARF feedback report.
 * Returns the classification if it's an ARF report, null otherwise.
 */
export function tryParseARF(
	parsed: ParsedMessage,
	reportParts: ReportPart[]
): BounceClassification | null {
	// Check for ARF content type indicator. mailparser returns the parsed
	// `content-type` header as a structured object (`{ value, params }`), so a
	// naive `String(obj)` yields `[object Object]` and the `report-type` param is
	// lost — flatten it to text including the params first.
	const contentTypeStr = flattenContentType(parsed.headers?.get('content-type'));

	// A `report-type=feedback-report` param already contains the `feedback-report`
	// substring, so this single `includes` covers both the bare token and the
	// structured `multipart/report; report-type=feedback-report` param form.
	const isARF = contentTypeStr.includes('feedback-report');

	const bodyText = parsed.text ?? '';

	if (!isARF) {
		// Also check body text for ARF indicators (some ISPs don't set content-type correctly)
		const lowerBody = bodyText.toLowerCase();
		if (!lowerBody.includes('feedback-type:') || !lowerBody.includes('abuse')) {
			return null;
		}
	}

	logger.info('Processing ARF feedback report');

	// Split the report into its structured feedback-report part and the
	// original-message part so each RFC 5965 field is read from the right place.
	const parts = splitArfParts(reportParts, bodyText);

	// `Feedback-Type` is the registry field that names the report class (abuse,
	// fraud, virus, …). We surface it so downstream can distinguish a spam
	// complaint from e.g. a `not-spam` / `auth-failure` report (RFC 5965 §7.3).
	const feedbackType = matchField(parts.feedbackReport, 'Feedback-Type');

	// The X-Owlat-Message-Id / Message-ID header scrapes below read
	// attacker-controllable plaintext: a forged null-sender ARF report can embed
	// any value, and a genuine report echoes our outbound headers back. Once VERP
	// signing is configured, the ONLY trusted attribution source is a verified
	// signed VERP token (the `Original-Mail-From` return-path) — the
	// unauthenticated header scrapes are skipped so a forged complaint cannot
	// suppress a healthy recipient.
	let originalMessageId: string | undefined;

	// First, prefer the authenticated VERP return-path (Original-Mail-From). Per
	// RFC 5965 §3.2 this lives in the structured feedback-report part. It is the
	// only source verified against the HMAC, so it is always trusted.
	const originalMailFrom = matchField(parts.feedbackReport, 'Original-Mail-From');
	if (isVerpSigningEnabled() && originalMailFrom) {
		const verifiedId = parseVerpAddress(originalMailFrom);
		if (verifiedId) {
			originalMessageId = verifiedId;
		}
	}

	// Per-campaign attribution: the ORIGINAL message carries a Gmail FBL
	// `Feedback-ID` header (`<streamType>:<campaignId>:<audienceType>:<senderId>`,
	// see delivery/sendComposition/feedbackId.ts). Read it back from the
	// `message/rfc822` part once it lands outbound. This is only a metric label
	// (never a suppression handle), so it is not gated behind the VERP-signing
	// header-fallback guard. Some ISPs instead surface the Feedback-ID inline in
	// the report body, so fall back to that.
	let campaignId = extractCampaignIdFromFeedbackId(parts.originalMessage);
	if (!campaignId) {
		campaignId = extractCampaignIdFromFeedbackId(bodyText);
	}

	// Our X-Owlat-Org-Id is echoed in the original message we sent.
	let organizationId = matchField(parts.originalMessage, 'X-Owlat-Org-Id');
	if (!organizationId) {
		// Some reports embed it inline rather than as a re-attached rfc822 part.
		organizationId = matchField(bodyText, 'X-Owlat-Org-Id');
	}

	// Extract the complained recipient address. RFC 5965 §3.2 puts it in the
	// machine-readable feedback-report part as `Original-Rcpt-To` (the field
	// most ISPs emit), with `Removed-Recipient` and `Original-Recipient` as
	// alternates. Gmail and several other large ISPs redact the original
	// Message-ID but still emit the recipient, so this address is frequently
	// the ONLY attribution handle on a real complaint — without it the
	// complaint would never reach the blocklist.
	const recipient = extractComplainedRecipient(reportParts, bodyText);

	// Derive the source ISP. RFC 5965 §3.2 puts structured `Reported-Domain` /
	// `Source-IP` fields in the feedback-report part and most ISPs brand the
	// `User-Agent`; prefer those over guessing from the `Received` trace, which
	// is forgeable and frequently absent on a relayed FBL.
	const reportedDomain = matchField(parts.feedbackReport, 'Reported-Domain');
	const sourceIp = matchField(parts.feedbackReport, 'Source-IP');
	const sourceIsp =
		isp(matchField(parts.feedbackReport, 'User-Agent')) ??
		isp(reportedDomain) ??
		isp(sourceIp) ??
		extractSourceIsp(String(parsed.headers?.get('received') ?? ''));

	logger.info(
		{
			feedbackType,
			originalMessageId,
			organizationId,
			recipient,
			campaignId,
			sourceIsp,
			reportedDomain,
			sourceIp,
		},
		'ARF report parsed'
	);

	return {
		type: 'complained',
		bounceType: 'hard',
		// NOTE: the `from <isp>` shape is load-bearing — reduceFbl() in
		// outcome.ts re-extracts the ISP from this message via /from (\w+)/, so
		// the ISP token must stay a single \w+ word.
		message: `Spam complaint via ARF from ${sourceIsp ?? 'unknown ISP'}`,
		originalMessageId,
		organizationId,
		recipient,
		campaignId,
		feedbackType,
		reportedDomain,
		sourceIp,
		sourceIsp,
	};
}

/**
 * Split an ARF report into its `message/feedback-report` (structured fields)
 * and `message/rfc822` (original message) parts by MIME content-type.
 *
 * mailparser flattens both `message/*` sub-parts into `parsed.attachments`,
 * each tagged with its `contentType`, so we can route by type rather than
 * scanning blindly. ISPs that mislabel or omit the sub-part content-types fall
 * back to: any attachment that looks like a feedback-report (carries
 * `Feedback-Type:`) → feedbackReport, the rest → originalMessage; and the
 * top-level body text is always folded into the feedbackReport scan so an
 * inline (non-multipart) report still parses.
 */
function splitArfParts(reportParts: ReportPart[], bodyText: string): ArfParts {
	let feedbackReport = '';
	let originalMessage = '';

	for (const part of reportParts) {
		const content = part.content.toString('utf-8');
		const type = part.contentType;

		if (type === 'message/feedback-report') {
			feedbackReport += `\n${content}`;
		} else if (type === 'message/rfc822' || type === 'text/rfc822-headers') {
			originalMessage += `\n${content}`;
		} else if (/^\s*Feedback-Type:/im.test(content)) {
			// Mislabeled/untyped part that is clearly the feedback-report.
			feedbackReport += `\n${content}`;
		} else {
			// Anything else (typically the re-attached original message).
			originalMessage += `\n${content}`;
		}
	}

	// The top-level body carries the report fields for inline (non-multipart)
	// reports and for ISPs that don't attach a typed feedback-report part.
	feedbackReport += `\n${bodyText}`;

	return { feedbackReport, originalMessage };
}

/**
 * Match a single `Header-Name: value` field (first occurrence), trimmed.
 *
 * Field names are RFC 5322 header names (`[A-Za-z-]+`), but we still escape
 * regex metacharacters defensively so a future caller can't inject a pattern.
 */
function matchField(text: string, field: string): string | undefined {
	const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(`^${escaped}:\\s*(.+)$`, 'im');
	const match = text.match(re);
	const value = match?.[1]?.trim();
	return value && value.length > 0 ? value : undefined;
}

/**
 * Extract the complained recipient from an ARF report (RFC 5965 §3.2).
 *
 * The feedback-report part carries the affected address in one of three
 * fields; we try them in the order ISPs prefer:
 *   - `Original-Rcpt-To:` — the SMTP RCPT TO, emitted by Gmail / most ISPs
 *   - `Removed-Recipient:` — used by some bulk senders' FBL relays
 *   - `Original-Recipient:` — RFC 3464-style `rfc822;addr` form
 *
 * The report can arrive either as a parsed `message/feedback-report`
 * attachment part or inline in the report body (when the ISP doesn't set the
 * MIME content-type correctly), so we scan both. Addresses may be wrapped in
 * angle brackets or carry an `rfc822;` address-type prefix; both are stripped.
 */
function extractComplainedRecipient(
	reportParts: ReportPart[],
	bodyText: string
): string | undefined {
	const sources: string[] = [bodyText];
	for (const part of reportParts) {
		sources.push(part.content.toString('utf-8'));
	}

	for (const source of sources) {
		const recipient = matchRecipientField(source);
		if (recipient) return recipient;
	}

	return undefined;
}

const RECIPIENT_FIELD_RE = /^(?:Original-Rcpt-To|Removed-Recipient|Original-Recipient):\s*(.+)$/im;

function matchRecipientField(text: string): string | undefined {
	const match = text.match(RECIPIENT_FIELD_RE);
	if (!match?.[1]) return undefined;
	return normalizeRecipient(match[1]);
}

/** Strip an `rfc822;`/`addr-type;` prefix and surrounding angle brackets. */
function normalizeRecipient(raw: string): string | undefined {
	let value = raw.trim();
	// Drop a leading RFC 3464 address-type label, e.g. "rfc822; user@host".
	const semicolon = value.indexOf(';');
	if (semicolon !== -1 && /^[A-Za-z0-9-]+$/.test(value.slice(0, semicolon))) {
		value = value.slice(semicolon + 1).trim();
	}
	// Unwrap <addr>.
	const angle = value.match(/<([^>]+)>/);
	if (angle?.[1]) {
		value = angle[1].trim();
	}
	return value.length > 0 ? value : undefined;
}

/**
 * Scrape a `Feedback-ID:` header line out of raw message text and return the
 * campaignId it carries (field 2 of the `campaign` stream), delegating the
 * value parsing to the shared `parseCampaignFromFeedbackId` so the inbound
 * bounce path and the outbound delivery path agree on the format.
 */
function extractCampaignIdFromFeedbackId(content: string): string | undefined {
	const match = content.match(/Feedback-ID:\s*([^\r\n]+)/i);
	return parseCampaignFromFeedbackId(match?.[1]);
}

/**
 * Map a free-text hint (a feedback-report `User-Agent`, `Reported-Domain`, or
 * `Source-IP` reverse hint, or a `Received` trace line) to a known ISP token.
 *
 * The returned value MUST be a single `\w+` word: `reduceFbl()` in outcome.ts
 * re-parses the ISP out of the classification `message` with `/from (\w+)/`,
 * and the ISP becomes a bounded Prometheus label, so this is intentionally a
 * fixed enum of the large FBL providers rather than free text.
 */
function isp(hint: string | undefined): string | undefined {
	if (!hint) return undefined;
	const lower = hint.toLowerCase();
	if (lower.includes('microsoft') || lower.includes('outlook') || lower.includes('hotmail')) {
		return 'microsoft';
	}
	if (lower.includes('yahoo')) return 'yahoo';
	if (lower.includes('aol')) return 'aol';
	if (lower.includes('comcast')) return 'comcast';
	if (lower.includes('google') || lower.includes('gmail')) return 'google';
	if (lower.includes('mail.ru')) return 'mailru';
	return undefined;
}

/**
 * Try to identify the source ISP from received headers. Kept as the last-resort
 * fallback for reports that carry no structured `User-Agent`/`Reported-Domain`.
 */
function extractSourceIsp(receivedHeader: string): string | undefined {
	return isp(receivedHeader);
}
