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

export interface ExtractedAttachment {
	filename: string;
	contentType: string;
	contentId?: string;
	disposition: 'attachment' | 'inline';
	bytes: Uint8Array;
}

function unfold(headerText: string): string {
	return headerText.replace(/\r?\n[ \t]+/g, ' ');
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

function decodeRfc2231(v: string): string {
	const m = v.match(/^[^']*'[^']*'(.*)$/);
	const enc = m ? m[1]! : v;
	try {
		return decodeURIComponent(enc);
	} catch {
		return enc;
	}
}

function getParam(headerValue: string | undefined, name: string): string | undefined {
	if (!headerValue) return undefined;
	const continued: string[] = [];
	// `(?:^|[;\s])` so `getParam(..., 'name')` can't match inside `filename`.
	const contRe = new RegExp(
		`(?:^|[;\\s])${name}\\*(\\d+)\\*?\\s*=\\s*("([^"]*)"|([^;\\r\\n]+))`,
		'gi'
	);
	let cm: RegExpExecArray | null;
	while ((cm = contRe.exec(headerValue))) {
		continued[Number.parseInt(cm[1]!, 10)] = (cm[3] ?? cm[4] ?? '').trim();
	}
	if (continued.length > 0) return decodeRfc2231(continued.join(''));
	const re = new RegExp(`(?:^|[;\\s])${name}\\*?\\s*=\\s*("([^"]*)"|([^;\\r\\n]+))`, 'i');
	const m = headerValue.match(re);
	const value = m ? (m[2] ?? m[3] ?? '') : undefined;
	return value ? decodeRfc2231(value.trim()) : undefined;
}

/**
 * Decode `=HH` hex escapes (quoted-printable / RFC 2047 Q-encoding) into their
 * raw bytes-as-chars. Callers apply their own pre-step first: Q-encoding maps
 * `_`→space, the QP body strips soft line breaks (`=\r?\n`).
 */
function decodeQpHexEscapes(s: string): string {
	return s.replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) =>
		String.fromCharCode(Number.parseInt(h, 16))
	);
}

/**
 * Decode RFC 2047 encoded-words (`=?charset?B|Q?payload?=`), honoring the
 * DECLARED charset — a previous version always decoded as UTF-8, which
 * mangled ISO-8859-1 / Shift_JIS subjects. Falls back utf-8 → raw payload
 * when the charset is unknown. Canonical implementation: the IMAP server
 * had its own charset-aware copy; both now live here.
 */
export function decodeEncodedWords(s: string): string {
	return s.replace(
		/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
		(whole, charset: string, enc: string, text: string) => {
			try {
				let bin: string;
				if (enc.toUpperCase() === 'B') {
					bin = atob(text);
				} else {
					bin = decodeQpHexEscapes(text.replace(/_/g, ' '));
				}
				const bytes = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
				const cs = charset.toLowerCase() === 'utf8' ? 'utf-8' : charset;
				try {
					return new TextDecoder(cs).decode(bytes);
				} catch {
					return new TextDecoder('utf-8').decode(bytes);
				}
			} catch {
				return whole;
			}
		}
	);
}

function getBoundary(contentType: string): string | null {
	return getParam(contentType, 'boundary') ?? null;
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
		getParam(headers.get('content-disposition'), 'filename') ??
		getParam(headers.get('content-type'), 'name');
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
		getParam(headers.get('content-disposition'), 'filename') ??
		getParam(headers.get('content-type'), 'name');
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
