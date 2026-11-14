/**
 * Complaint attribution from the re-attached original message.
 *
 * Some feedback loops send a complaint as a plain forward of the message the
 * user reported, with no ARF part, and some ARF reports omit
 * `Original-Mail-From`. Either way the original still carries the
 * `Return-Path:` its final receiver stamped from our envelope sender, which is
 * the signed VERP token. That token is verified with the same HMAC as every
 * other handle; nothing else in the original (headers, org ids, recipients) is
 * read, so the send-time record remains the only source of who and which
 * organisation the complaint is about.
 */

import type { ParsedMessage } from '@owlat/mail-message';
import type { BounceClassification } from '../types.js';
import { addressText } from '../inbound/parsedAddress.js';
import { extractSourceIsp, isp } from './fblSourceIsp.js';
import type { ReportPart } from './reportParts.js';
import { isVerpSigningEnabled, parseVerpAddress } from './verp.js';

const ORIGINAL_MESSAGE_TYPES: ReadonlySet<string> = new Set([
	'message/rfc822',
	'text/rfc822-headers',
]);

/**
 * UTF-16 code units of each original's header section that are scanned, and the
 * most `Return-Path` values verified per report. Report bytes are
 * internet-controlled; both bounds keep the HMAC work per message constant.
 */
const MAX_HEADER_SCAN_UNITS = 64 * 1024;
const MAX_RETURN_PATH_CANDIDATES = 8;

const RETURN_PATH_RE = /^Return-Path:[ \t]*<?([^<>\s]+)>?[ \t\r]*$/gim;

/**
 * The message id from a verified signed VERP in the `Return-Path` header of a
 * re-attached original, or `undefined`. Only the header section is read, so a
 * `Return-Path:` line in a quoted body cannot stand in for one.
 */
export function verifiedOriginalReturnPath(reportParts: readonly ReportPart[]): string | undefined {
	if (!isVerpSigningEnabled()) return undefined;
	let candidates = 0;
	for (const part of reportParts) {
		if (!ORIGINAL_MESSAGE_TYPES.has(part.contentType)) continue;
		const text = part.content.toString('utf-8').slice(0, MAX_HEADER_SCAN_UNITS);
		const headerEnd = text.search(/\r?\n\r?\n/);
		const headers = headerEnd === -1 ? text : text.slice(0, headerEnd);
		for (const match of headers.matchAll(RETURN_PATH_RE)) {
			if (++candidates > MAX_RETURN_PATH_CANDIDATES) return undefined;
			const messageId = match[1] ? parseVerpAddress(match[1]) : null;
			if (messageId) return messageId;
		}
	}
	return undefined;
}

/**
 * A complaint that is a forward of one of our messages, or `null`.
 *
 * The caller decides that the message was sent to a complaint mailbox; a
 * forward anywhere else is ordinary mail. A delivery report is never read as
 * a complaint, because a DSN also returns the original.
 */
export function tryParseForwardedComplaint(
	parsed: ParsedMessage,
	reportParts: readonly ReportPart[]
): BounceClassification | null {
	if (reportParts.some((part) => part.contentType === 'message/delivery-status')) return null;
	const originalMessageId = verifiedOriginalReturnPath(reportParts);
	if (!originalMessageId) return null;
	const sourceIsp =
		isp(addressText(parsed.from)) ??
		extractSourceIsp(String(parsed.headers?.get('received') ?? ''));
	return {
		type: 'complained',
		bounceType: 'hard',
		// The `from <isp>` shape is read back by reduceFbl() with /from (\w+)/.
		message: `Spam complaint via forwarded original from ${sourceIsp ?? 'unknown ISP'}`,
		originalMessageId,
		...(sourceIsp ? { sourceIsp } : {}),
	};
}
