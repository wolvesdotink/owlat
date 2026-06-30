/**
 * Bounce classification engine
 *
 * Classifies bounce messages into hard/soft/complaint categories
 * using RFC 3464 DSN codes and heuristic pattern matching.
 */

import type { BounceClassification } from '../types.js';
// Hard/soft free-text patterns are shared with the Resend webhook adapter so the
// two can't drift. The DSN-code precedence + complaint detection below stay local.
import { classifyBounceMessage } from '@owlat/shared/bounceClassification';

// Complaint patterns — spam report
const COMPLAINT_PATTERNS = /feedback-report|feedback-type:\s*abuse|spam complaint|complaint about message/i;

/**
 * Classify a bounce/DSN message
 *
 * Order of precedence:
 * 1. Check for ARF complaint indicators
 * 2. Parse the structured RFC 3464 per-recipient fields (Status:/Action:/
 *    Diagnostic-Code:) — the authoritative machine-readable codes that live in
 *    the message/delivery-status MIME part (RFC 3464 §2.3)
 * 3. Fall back to a loose enhanced-status-code scan over the whole body
 * 4. Pattern match against known hard/soft bounce messages
 * 5. Default to soft bounce (safer — doesn't auto-blocklist)
 */
export function classifyBounce(
	bodyText: string,
	subject?: string,
	contentType?: string
): BounceClassification {
	const combined = `${bodyText} ${subject ?? ''} ${contentType ?? ''}`;

	// 1. Check for ARF/complaint
	if (COMPLAINT_PATTERNS.test(combined)) {
		return {
			type: 'complained',
			bounceType: 'hard',
			message: truncate(bodyText),
		};
	}

	// 2. Parse the structured RFC 3464 per-recipient fields first. These are the
	// authoritative codes (in the message/delivery-status part); a standards DSN
	// may carry the only enhanced code here and leave the human-readable text
	// without one, so this must take precedence over the loose free-text scan.
	const structured = parseStructuredDsn(bodyText);
	if (structured.status) {
		const classification = classifyByEnhancedCode(structured.status, bodyText, structured.action);
		if (classification) return classification;
	}
	// An explicit `Action: failed` with no enhanced status code is still a
	// permanent failure per RFC 3464 §2.3.3.
	if (structured.action === 'failed') {
		return { type: 'bounced', bounceType: 'hard', message: truncate(bodyText), diagnosticCode: structured.diagnosticCode };
	}

	// 3. Fall back to a loose enhanced-status-code scan over the whole body.
	const enhancedCode = structured.status ?? extractEnhancedCode(bodyText);
	if (enhancedCode) {
		const classification = classifyByEnhancedCode(enhancedCode, bodyText, structured.action);
		if (classification) return classification;
	}

	// 4. Free-text pattern matching (shared with the Resend adapter), then
	// 5. default to soft (safer) — both handled by classifyBounceMessage.
	return {
		type: 'bounced',
		bounceType: classifyBounceMessage(combined),
		message: truncate(bodyText),
		diagnosticCode: enhancedCode ?? structured.diagnosticCode,
	};
}

/**
 * Structured RFC 3464 per-recipient fields parsed out of the
 * message/delivery-status MIME part (RFC 3464 §2.3).
 */
interface StructuredDsn {
	/** Enhanced status code from the `Status:` field, e.g. "5.1.1". */
	status?: string;
	/** Normalized `Action:` field value, e.g. "failed", "delayed". */
	action?: string;
	/** Raw `Diagnostic-Code:` field value, if present. */
	diagnosticCode?: string;
}

/**
 * Parse the authoritative RFC 3464 per-recipient fields. These are
 * field-name-anchored (`Status:`, `Action:`, `Diagnostic-Code:`) so they only
 * match the machine-readable DSN part, not arbitrary numbers in prose.
 */
function parseStructuredDsn(text: string): StructuredDsn {
	const statusMatch = text.match(/^[ \t]*Status:[ \t]*([245]\.\d{1,3}\.\d{1,3})\b/im);
	const actionMatch = text.match(/^[ \t]*Action:[ \t]*([A-Za-z-]+)/im);
	const diagMatch = text.match(/^[ \t]*Diagnostic-Code:[ \t]*(.+)$/im);
	return {
		status: statusMatch?.[1],
		action: actionMatch?.[1]?.toLowerCase(),
		diagnosticCode: diagMatch?.[1]?.trim(),
	};
}

/**
 * Extract RFC 3464 enhanced status code from bounce message
 * e.g., "5.1.1", "4.2.2"
 */
function extractEnhancedCode(text: string): string | undefined {
	const match = text.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/);
	return match?.[1];
}

/**
 * Classify based on RFC 3464 enhanced status codes
 * See https://www.iana.org/assignments/smtp-enhanced-status-codes/
 *
 * The enhanced-code class is the primary driver. The `action` argument (from the
 * RFC 3464 `Action:` field, when present) is informational here: a `4.x` code is
 * temporary regardless, and a `5.x` code is permanent regardless, so the code
 * itself already encodes the disposition. `action` is only used as a tiebreaker
 * by the caller when no `Status:` code is present.
 */
function classifyByEnhancedCode(
	code: string,
	bodyText: string,
	_action?: string
): BounceClassification | null {
	const [classDigit, subject] = code.split('.').map(Number);

	// Class 5 = permanent failure
	if (classDigit === 5) {
		// 5.1.x = address-related
		if (subject === 1) {
			return { type: 'bounced', bounceType: 'hard', message: truncate(bodyText), diagnosticCode: code };
		}
		// 5.2.2 = mailbox full (soft despite 5xx class)
		if (code === '5.2.2') {
			return { type: 'bounced', bounceType: 'soft', message: truncate(bodyText), diagnosticCode: code };
		}
		// 5.7.x = security/policy
		if (subject === 7) {
			return { type: 'bounced', bounceType: 'hard', message: truncate(bodyText), diagnosticCode: code };
		}
		// Other 5.x.x = hard bounce
		return { type: 'bounced', bounceType: 'hard', message: truncate(bodyText), diagnosticCode: code };
	}

	// Class 4 = temporary failure
	if (classDigit === 4) {
		return { type: 'bounced', bounceType: 'soft', message: truncate(bodyText), diagnosticCode: code };
	}

	return null;
}

function truncate(text: string, maxLen = 500): string {
	return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}
