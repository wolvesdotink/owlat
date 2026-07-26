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
import { parseCfblAddress, parseCfblToken, type CfblRejectionReason } from './cfblAddress.js';
import { cfblAttributionsTotal, cfblRejectionsTotal } from '../monitoring/collector.js';
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
 * The machine-readable fields of an RFC 5965 ARF report.
 *
 * An ARF report is a `multipart/report; report-type=feedback-report` body with
 * three sub-parts (RFC 5965 §2):
 *   1. `text/plain` — a human-readable description (ignored for attribution).
 *   2. `message/feedback-report` — the STRUCTURED, key:value report fields
 *      (`Feedback-Type`, `Original-Mail-From`, `Original-Rcpt-To`,
 *      `Reported-Domain`, `Source-IP`, …). This is the authoritative signal.
 *   3. `message/rfc822` (or `text/rfc822-headers`) — an untrusted copy of the
 *      original message. It is never an attribution source.
 *
 * We retain only structured feedback fields here. Outbound organization and
 * campaign attribution comes later from signed, server-persisted provenance.
 */
interface ArfParts {
	/** Decoded text of the `message/feedback-report` part (structured fields). */
	feedbackReport: string;
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
 * Where a verified RFC 9477 attribution came from.
 *
 * - `rcpt_to` — the report was DELIVERED TO the signed CFBL address. Strongest:
 *   the address is unguessable, so possession of it is proof the sender saw our
 *   message (or a report generator acting on it).
 * - `feedback_id` — the report echoed the signed `CFBL-Feedback-ID` we emitted,
 *   which RFC 9477 §4.2 asks report generators to copy into the ARF's
 *   `Feedback-ID` field. Same MAC, so the same forgery resistance.
 */
export type CfblAttributionSource = 'rcpt_to' | 'feedback_id';

export interface CfblAttribution {
	/** The attributed internal message id, when a signature verified. */
	readonly messageId?: string;
	readonly source?: CfblAttributionSource;
	/**
	 * Verification failures worth counting. A value that simply isn't a CFBL
	 * token (`not_cfbl`) is NOT listed — a DSN arriving at `bounce+…`, or an ARF
	 * carrying Gmail's unrelated `Feedback-ID`, is normal traffic, not an attack.
	 */
	readonly rejections: readonly CfblRejectionReason[];
}

/**
 * UTF-16 code units of report text scanned for a `CFBL-Feedback-ID` /
 * `Feedback-ID` field.
 *
 * Units, not bytes: the bound is applied with `String.prototype.slice`, which
 * counts code units. Since a UTF-8 encoding is never SHORTER than the unit
 * count, the byte-wise bound it implies is at least as tight — the point is that
 * inbound reports are attacker-reachable and may be arbitrarily large, and the
 * fields we want are header-shaped and sit at the top of the machine-readable
 * part, so a bounded prefix is sufficient and a multi-megabyte report cannot
 * turn a regex scan into a CPU/allocation amplifier.
 */
const MAX_CFBL_SCAN_UNITS = 64 * 1024;

/**
 * Resolve a TRUSTED RFC 9477 attribution for an inbound report.
 *
 * Pure: takes the (already bounded) inputs plus an injectable clock/key and
 * returns a verdict. Never throws — a hostile input yields a counted rejection.
 *
 * The precedence is strongest-evidence-first: the envelope recipient the report
 * was actually delivered to, then the echoed signed feedback id.
 */
export function resolveCfblAttribution(
	input: { rcptTo?: string | undefined; reportText: string },
	key?: string,
	now?: number
): CfblAttribution {
	const rejections: CfblRejectionReason[] = [];

	const record = (reason: CfblRejectionReason): void => {
		// `not_cfbl` means "this simply isn't one of our tokens" — ordinary
		// traffic, not a verification failure worth alerting on.
		if (reason !== 'not_cfbl') rejections.push(reason);
	};

	if (input.rcptTo) {
		const viaRcpt = parseCfblAddress(input.rcptTo, key, now);
		if (viaRcpt.ok) return { messageId: viaRcpt.messageId, source: 'rcpt_to', rejections };
		record(viaRcpt.reason);
	}

	const scanned = input.reportText.slice(0, MAX_CFBL_SCAN_UNITS);
	for (const field of ['CFBL-Feedback-ID', 'Feedback-ID'] as const) {
		const presented = matchField(scanned, field);
		if (!presented) continue;
		// Every token we emit carries the `{encodedId}+{mac}` separator. On this
		// path the field name proves nothing about intent — `Feedback-ID` is also
		// Gmail's own unrelated aggregation anchor, and a plain alnum/dash value
		// from a non-participating provider is ordinary traffic. Counting it as
		// `unsigned` would let routine FBL mail inflate the very metric that exists
		// to surface forged complaints, so a MAC-less value is simply not one of
		// ours. (The `fbl+…@` envelope path keeps `unsigned`: there the prefix is
		// ours, so a missing MAC IS a hand-built address.)
		if (!presented.includes('+')) continue;
		const viaFeedbackId = parseCfblToken(presented, key, now);
		if (viaFeedbackId.ok) {
			return { messageId: viaFeedbackId.messageId, source: 'feedback_id', rejections };
		}
		record(viaFeedbackId.reason);
	}

	return { rejections };
}

/** Options threaded from the intake pipeline into ARF classification. */
export interface TryParseArfOptions {
	/**
	 * The SMTP envelope recipient this report was delivered to. When it is a
	 * verified `fbl+…@` CFBL address it is the highest-trust attribution handle
	 * available, and the ONLY one that works when the mailbox provider redacts
	 * the original message entirely.
	 */
	readonly rcptTo?: string | undefined;
}

/**
 * Attempt to parse an incoming email as an ARF feedback report.
 * Returns the classification if it's an ARF report, null otherwise.
 */
export function tryParseARF(
	parsed: ParsedMessage,
	reportParts: ReportPart[],
	options: TryParseArfOptions = {}
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

	// RFC 9477 first: a report delivered to our SIGNED `fbl+…@` address (or
	// echoing our signed `CFBL-Feedback-ID`) is authenticated by the same
	// BATV-style MAC the VERP token uses, and — unlike `Original-Mail-From` — it
	// survives providers that redact the original message. Rejections are
	// COUNTED, never thrown, so a forged-complaint campaign is observable.
	const cfbl = resolveCfblAttribution({
		rcptTo: options.rcptTo,
		reportText: parts.feedbackReport,
	});
	for (const reason of cfbl.rejections) {
		cfblRejectionsTotal.inc({ reason });
	}
	if (cfbl.messageId && cfbl.source) {
		originalMessageId = cfbl.messageId;
		cfblAttributionsTotal.inc({ source: cfbl.source });
	}

	// Then the authenticated VERP return-path (Original-Mail-From). Per RFC 5965
	// §3.2 this lives in the structured feedback-report part. It is verified
	// against the HMAC, so it is trusted — but it is weaker evidence than the
	// CFBL envelope, so it only fills a gap CFBL left.
	const originalMailFrom = matchField(parts.feedbackReport, 'Original-Mail-From');
	if (!originalMessageId && isVerpSigningEnabled() && originalMailFrom) {
		const verifiedId = parseVerpAddress(originalMailFrom);
		if (verifiedId) {
			originalMessageId = verifiedId;
		}
	}

	// Never copy Feedback-ID or X-Owlat-Org-Id from the re-attached original
	// message. ARF bytes are internet-controlled and syntactic validation cannot
	// bound label/key cardinality. attachFeedbackProvenance resolves both values
	// from the server-persisted outbound record only after this parser verifies a
	// signed VERP Message-ID.

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
			cfblSource: cfbl.source,
			cfblRejections: cfbl.rejections,
			recipient,
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
		recipient,
		feedbackType,
		reportedDomain,
		sourceIp,
		sourceIsp,
	};
}

/**
 * Recover the ARF `message/feedback-report` structured fields by MIME type.
 *
 * mailparser flattens both `message/*` sub-parts into `parsed.attachments`,
 * each tagged with its `contentType`, so we can route by type rather than
 * scanning blindly. A mislabeled part carrying `Feedback-Type:` is accepted;
 * the top-level body is folded in for inline reports. Re-attached original
 * message bytes are intentionally ignored for attribution.
 */
function splitArfParts(reportParts: ReportPart[], bodyText: string): ArfParts {
	let feedbackReport = '';

	for (const part of reportParts) {
		const content = part.content.toString('utf-8');
		const type = part.contentType;

		if (type === 'message/feedback-report') {
			feedbackReport += `\n${content}`;
		} else if (/^\s*Feedback-Type:/im.test(content)) {
			// Mislabeled/untyped part that is clearly the feedback-report.
			feedbackReport += `\n${content}`;
		}
	}

	// The top-level body carries the report fields for inline (non-multipart)
	// reports and for ISPs that don't attach a typed feedback-report part.
	feedbackReport += `\n${bodyText}`;

	return { feedbackReport };
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
