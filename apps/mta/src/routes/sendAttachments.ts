/**
 * The send intake's attachment boundary.
 *
 * Only `/send/system` carries files: a booking's `.ics` invite is the one
 * producer, and it is a few KB. The tenant and Postbox intakes never did, so a
 * body that sets `attachments` there is refused rather than silently dropped.
 * Each entry becomes a MIME part, so its filename and type must not be able to
 * carry a header break, and the decoded bytes are capped well below the queue's
 * per-job budget.
 */

import type { MtaSendAttachment } from '@owlat/mta-protocol';
import type { EmailAttachment } from '../types.js';

const MAX_SYSTEM_ATTACHMENTS = 4;
const MAX_SYSTEM_ATTACHMENT_BYTES = 512 * 1024;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
/** `type/subtype` plus optional printable-ASCII parameters; no CR, LF or quote breaks out. */
const CONTENT_TYPE_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?: *;[\x20-\x7e]*)?$/i;

/** 1-128 characters, none of them a control character, a quote, a slash or a backslash. */
function isSafeFilename(name: string): boolean {
	if (name.length < 1 || name.length > 128) return false;
	for (const char of name) {
		const code = char.charCodeAt(0);
		if (code < 0x20 || code === 0x7f || char === '"' || char === '/' || char === '\\') return false;
	}
	return true;
}

type AttachmentsReading =
	| { ok: true; attachments: EmailAttachment[] | undefined }
	| { ok: false; error: string };

/**
 * Read `attachments` off an unvalidated body. Absent or empty reads as none;
 * anything else must be a short list of well-formed entries.
 */
export function readSystemAttachments(
	value: unknown,
	mode: 'governed' | 'postbox' | 'system'
): AttachmentsReading {
	if (value === undefined || (Array.isArray(value) && value.length === 0)) {
		return { ok: true, attachments: undefined };
	}
	if (mode !== 'system') {
		return { ok: false, error: 'attachments are only accepted on /send/system' };
	}
	if (!Array.isArray(value) || value.length > MAX_SYSTEM_ATTACHMENTS) {
		return {
			ok: false,
			error: `attachments must be an array of at most ${MAX_SYSTEM_ATTACHMENTS} entries`,
		};
	}
	let totalBytes = 0;
	const attachments: EmailAttachment[] = [];
	for (const entry of value as Partial<MtaSendAttachment>[]) {
		if (
			!entry ||
			typeof entry.filename !== 'string' ||
			typeof entry.contentType !== 'string' ||
			typeof entry.contentBase64 !== 'string' ||
			!isSafeFilename(entry.filename) ||
			entry.contentType.length > 200 ||
			!CONTENT_TYPE_RE.test(entry.contentType) ||
			entry.contentBase64.length % 4 !== 0 ||
			!BASE64_RE.test(entry.contentBase64)
		) {
			return { ok: false, error: 'attachments contain a malformed entry' };
		}
		totalBytes += Buffer.byteLength(entry.contentBase64, 'base64');
		if (totalBytes > MAX_SYSTEM_ATTACHMENT_BYTES) {
			return { ok: false, error: 'attachments exceed the 512 KiB limit' };
		}
		attachments.push({
			filename: entry.filename,
			contentType: entry.contentType,
			contentBase64: entry.contentBase64,
		});
	}
	return { ok: true, attachments };
}
