/**
 * Minimal MIME attachment extractor for raw RFC822 messages.
 *
 * Postbox stores each received message's body inside the raw `.eml` blob; to
 * let the reader download an attachment we fetch that blob and pull the
 * requested part out here (in the browser), avoiding a server-side MIME parser.
 *
 * Handles nested `multipart/*`, base64 / quoted-printable / 7bit / 8bit /
 * binary transfer encodings, Content-Disposition + name/filename params (with a
 * pragmatic RFC2047 encoded-word and RFC2231 continuation decode), and
 * Content-ID. Attachment leaves are returned in document order — the same order
 * mailparser assigns the `partIndex` recorded on each message's attachment
 * metadata. Input should be a binary string (one char per byte, e.g. via
 * `new TextDecoder('latin1').decode(bytes)`) so binary parts survive.
 */

// The RFC 2047 / 2231 header helpers now live in `@owlat/mail-message` (the
// in-house parser that replaces mailparser). This module keeps re-exporting
// them from their new home so every existing importer of
// `@owlat/shared/mailMime` — including `decodeEncodedWords` — keeps working
// unchanged. We import from the `/headers` subpath (which pulls in nothing
// else) so the web bundle that consumes this extractor is not enlarged.
import {
	unfold,
	decodeQpHexEscapes,
	decodeEncodedWords,
	decodeRfc2231,
	getRawParam,
} from '@owlat/mail-message/headers';

export { unfold, decodeEncodedWords, decodeRfc2231 };

export interface ExtractedAttachment {
	filename: string;
	contentType: string;
	contentId?: string;
	disposition: 'attachment' | 'inline';
	bytes: Uint8Array;
}

function parseHeaders(headerText: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of unfold(headerText).split(/\r?\n/)) {
		const idx = line.indexOf(':');
		if (idx < 0) continue;
		map.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
	}
	return map;
}

function splitHeadersBody(raw: string): { headers: Map<string, string>; body: string } {
	const m = raw.match(/\r?\n\r?\n/);
	if (!m || m.index == null) return { headers: parseHeaders(raw), body: '' };
	return {
		headers: parseHeaders(raw.slice(0, m.index)),
		body: raw.slice(m.index + m[0].length),
	};
}

// The whitespace-anchored param scanner now lives in `@owlat/mail-message`
// (imported above) so it has ONE home shared with the in-house MIME walker.
function getBoundary(contentType: string): string | null {
	return getRawParam(contentType, 'boundary') ?? null;
}

function decodeBody(body: string, encoding: string): Uint8Array {
	const enc = encoding.toLowerCase().trim();
	if (enc === 'base64') {
		const clean = body.replace(/[^A-Za-z0-9+/=]/g, '');
		let bin: string;
		try {
			bin = atob(clean);
		} catch {
			// One malformed base64 part must not abort extraction of the others.
			return new Uint8Array(0);
		}
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}
	if (enc === 'quoted-printable') {
		const decoded = decodeQpHexEscapes(body.replace(/=\r?\n/g, ''));
		const out = new Uint8Array(decoded.length);
		for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i) & 0xff;
		return out;
	}
	const out = new Uint8Array(body.length);
	for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
	return out;
}

function stripBrackets(s: string | undefined): string | undefined {
	return s ? s.replace(/[<>]/g, '').trim() || undefined : undefined;
}

function splitMultipart(body: string, boundary: string): string[] {
	const open = `--${boundary}`;
	const close = `${open}--`;
	const parts: string[] = [];
	let current: string[] | null = null;
	for (const line of body.split(/\r?\n/)) {
		const t = line.replace(/[ \t]+$/, '');
		if (t === open || t === close) {
			if (current) parts.push(current.join('\n'));
			if (t === close) {
				current = null;
				break;
			}
			current = [];
			continue;
		}
		if (current) current.push(line);
	}
	if (current) parts.push(current.join('\n'));
	return parts;
}

function walk(raw: string, out: ExtractedAttachment[]): void {
	const { headers, body } = splitHeadersBody(raw);
	const contentType = headers.get('content-type') ?? 'text/plain';
	const mainType = (contentType.split(';')[0] ?? '').trim().toLowerCase();

	if (mainType.startsWith('multipart/')) {
		const boundary = getBoundary(contentType);
		if (!boundary) return;
		for (const part of splitMultipart(body, boundary)) walk(part, out);
		return;
	}

	const disposition = (headers.get('content-disposition') ?? '').toLowerCase().trim();
	const rawName =
		getRawParam(headers.get('content-disposition'), 'filename') ??
		getRawParam(headers.get('content-type'), 'name');
	const filename = rawName ? decodeEncodedWords(rawName) : '';
	const isAttachment = disposition.startsWith('attachment') || filename.length > 0;
	if (!isAttachment) return;

	out.push({
		filename: filename || 'attachment',
		contentType: mainType,
		contentId: stripBrackets(headers.get('content-id')),
		disposition: disposition.startsWith('inline') ? 'inline' : 'attachment',
		bytes: decodeBody(body, headers.get('content-transfer-encoding') ?? '7bit'),
	});
}

/** All attachment leaves of a raw message, in document order. */
export function extractAttachments(rawEml: string): ExtractedAttachment[] {
	const out: ExtractedAttachment[] = [];
	walk(rawEml, out);
	return out;
}

function findByType(raw: string, typePrefix: string): ExtractedAttachment | null {
	const { headers, body } = splitHeadersBody(raw);
	const contentType = headers.get('content-type') ?? 'text/plain';
	const mainType = (contentType.split(';')[0] ?? '').trim().toLowerCase();

	if (mainType.startsWith('multipart/')) {
		const boundary = getBoundary(contentType);
		if (!boundary) return null;
		for (const part of splitMultipart(body, boundary)) {
			const found = findByType(part, typePrefix);
			if (found) return found;
		}
		return null;
	}
	if (!mainType.startsWith(typePrefix)) return null;

	const rawName =
		getRawParam(headers.get('content-disposition'), 'filename') ??
		getRawParam(headers.get('content-type'), 'name');
	const disposition = (headers.get('content-disposition') ?? '').toLowerCase().trim();
	return {
		filename: (rawName ? decodeEncodedWords(rawName) : '') || 'part',
		contentType: mainType,
		contentId: stripBrackets(headers.get('content-id')),
		disposition: disposition.startsWith('inline') ? 'inline' : 'attachment',
		bytes: decodeBody(body, headers.get('content-transfer-encoding') ?? '7bit'),
	};
}

/**
 * Find the first MIME leaf whose content-type starts with `typePrefix` (e.g.
 * `text/calendar`), INCLUDING inline parts that carry no disposition/filename —
 * which `extractAttachments` skips. Google/Outlook ship invites as an inline
 * `text/calendar` part, so the RSVP card relies on this rather than a partIndex.
 */
export function extractFirstPartByType(
	rawEml: string,
	typePrefix: string
): ExtractedAttachment | null {
	return findByType(rawEml, typePrefix.toLowerCase());
}

/**
 * Pick one attachment by the recorded `partIndex` (mailparser order), with a
 * filename fallback for robustness against minor ordering drift.
 */
export function extractAttachmentAt(
	rawEml: string,
	partIndex: string,
	filename?: string
): ExtractedAttachment | null {
	const all = extractAttachments(rawEml);
	const idx = Number.parseInt(partIndex, 10);
	if (Number.isInteger(idx) && idx >= 0 && idx < all.length) {
		const byIdx = all[idx]!;
		if (!filename || byIdx.filename === filename) return byIdx;
	}
	if (filename) {
		const byName = all.find((a) => a.filename === filename);
		if (byName) return byName;
	}
	return Number.isInteger(idx) && idx >= 0 && idx < all.length ? all[idx]! : null;
}
