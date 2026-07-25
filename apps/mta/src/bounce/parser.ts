/**
 * Bounce DSN (Delivery Status Notification) parser
 *
 * Handles RFC 3464 DSN messages and non-standard bounce formats.
 * Extracts the original message ID and bounce classification.
 */

import type { ParsedMessage } from '@owlat/mail-message';
import type { BounceClassification } from '../types.js';
import { classifyBounce } from './classifier.js';
import { parseVerpAddress, isVerpSigningEnabled } from './verp.js';
import { addressText } from '../inbound/parsedAddress.js';
import type { ReportPart } from './reportParts.js';
import { logger } from '../monitoring/logger.js';

// Track unattributed bounce counts for monitoring
let unattributedBounceCount = 0;

/**
 * Get the count of unattributed bounces since process start (for metrics/monitoring)
 */
export function getUnattributedBounceCount(): number {
	return unattributedBounceCount;
}

/**
 * Pull the text of the RFC 3464 message/delivery-status MIME part out of a DSN's
 * recovered report parts. The authoritative Status:/Action:/Diagnostic-Code:
 * fields live in that machine-readable part — never in `parsed.text` — and it
 * routinely carries no Content-Disposition, so it is recovered from the MIME tree
 * ({@link ReportPart}) rather than `parsed.attachments`. Concatenates all
 * delivery-status parts found.
 */
function extractDeliveryStatusPart(reportParts: ReportPart[]): string | undefined {
	const parts: string[] = [];
	for (const part of reportParts) {
		if (part.contentType === 'message/delivery-status') {
			parts.push(part.content.toString('utf-8'));
		}
	}
	return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * Parse a bounce DSN message and extract classification details.
 *
 * `reportParts` are the message's recovered non-body MIME parts (the
 * `message/delivery-status` / `message/rfc822` parts mailparser used to surface
 * as `attachments`; see {@link extractReportParts}) — the header-scrape fallbacks
 * and the delivery-status classifier read them.
 */
export function parseBounce(
	parsed: ParsedMessage,
	reportParts: ReportPart[],
	envelopeRcptTo?: string
): BounceClassification | null {
	// 1. Try to extract messageId from VERP envelope recipient
	let messageId: string | null = null;
	if (isVerpSigningEnabled() && envelopeRcptTo) {
		messageId = parseVerpAddress(envelopeRcptTo);
	}

	// The X-Owlat-Message-Id header-scrape fallbacks (steps 2 and 3) read an
	// attacker-controllable plaintext value: genuine DSNs echo our outbound
	// headers back, but a forged null-sender DSN can simply embed
	// `X-Owlat-Message-Id: <guessed-id>` in its body/attachment. Attributing
	// from it would let a forged report suppress a healthy recipient and would
	// bypass the VERP HMAC entirely. So once signing is configured, the ONLY
	// trusted attribution source is the verified VERP token (step 1); the
	// unauthenticated fallbacks are skipped and the bounce is treated as
	// unattributed below.
	if (!messageId) {
		unattributedBounceCount++;

		// Log full details for debugging — these bounces are lost feedback
		// that could be hiding deliverability issues
		logger.warn(
			{
				subject: parsed.subject,
				from: addressText(parsed.from),
				envelopeRcptTo,
				hasAttachments: reportParts.length > 0,
				textPreview: parsed.text?.slice(0, 500),
				unattributedTotal: unattributedBounceCount,
			},
			'Unattributed bounce — could not extract message ID from DSN'
		);
		return null;
	}

	// 2. Extract organization ID if available
	let organizationId: string | undefined;
	const fullText = `${parsed.text ?? ''} ${reportParts.map((p) => p.content.toString('utf-8')).join(' ')}`;
	const orgMatch = fullText.match(/X-Owlat-Org-Id:\s*(.+)/i);
	if (orgMatch?.[1]) {
		organizationId = orgMatch[1].trim();
	}

	// 3. Classify the bounce.
	//
	// The authoritative RFC 3464 per-recipient fields (Status:/Action:/
	// Diagnostic-Code:) live in the machine-readable message/delivery-status
	// MIME part — not in `parsed.text`. A minimal standards DSN may carry the only
	// enhanced code there, so feed that part to the classifier (ahead of the
	// human-readable text) and let it parse the structured fields first.
	const deliveryStatus = extractDeliveryStatusPart(reportParts);
	const humanReadable = parsed.text ?? parsed.subject ?? '';
	const bodyText = deliveryStatus ? `${deliveryStatus}\n${humanReadable}` : humanReadable;
	const contentType = parsed.headers?.get('content-type');
	const classification = classifyBounce(
		bodyText,
		parsed.subject,
		typeof contentType === 'string' ? contentType : String(contentType ?? '')
	);

	return {
		...classification,
		originalMessageId: messageId,
		organizationId,
	};
}
