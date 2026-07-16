/**
 * A deliberately small MIME structure walker used ONLY by the differential test
 * harness. mailparser's `simpleParser` is the primary semantic oracle (headers,
 * decoded text/html, attachments), but it flattens the multipart tree and does
 * not surface a `text/x-amp-html` alternative. This walker recovers two things
 * that flattening loses and that the differential suite must compare between our
 * composer and nodemailer's:
 *   - `tree`: the ordered list of media types INCLUDING the multipart wrappers,
 *     so part ordering and nesting (plain -> amp -> html; mixed(related(alt))) is
 *     provable, not just the set of leaves.
 *   - `leaves`: each leaf's decoded body, so the AMP part's bytes are compared.
 *
 * It is not a general MIME parser — it handles exactly the shapes our composer
 * and nodemailer emit (7bit / quoted-printable / base64 leaves, CRLF framing).
 */

export interface LeafPart {
	contentType: string;
	encoding: string;
	/** Decoded body as UTF-8 text (base64 leaves are decoded too). */
	text: string;
}

export interface MimeTree {
	/** Ordered media types, multipart wrappers included, depth-first. */
	tree: string[];
	leaves: LeafPart[];
}

function splitHeadersBody(section: string): { headers: string; body: string } {
	const idx = section.indexOf('\r\n\r\n');
	if (idx === -1) return { headers: section, body: '' };
	return { headers: section.slice(0, idx), body: section.slice(idx + 4) };
}

function headerValue(headers: string, name: string): string {
	// Unfold continuation lines (CRLF + WSP) before matching.
	const unfolded = headers.replace(/\r\n[ \t]+/g, ' ');
	for (const line of unfolded.split('\r\n')) {
		const colon = line.indexOf(':');
		if (colon === -1) continue;
		if (line.slice(0, colon).trim().toLowerCase() === name.toLowerCase()) {
			return line.slice(colon + 1).trim();
		}
	}
	return '';
}

function contentTypeOf(headers: string): { media: string; boundary: string | undefined } {
	const ct = headerValue(headers, 'Content-Type') || 'text/plain';
	const media = (ct.split(';')[0] ?? 'text/plain').trim().toLowerCase();
	const bm = /boundary="?([^";]+)"?/i.exec(ct);
	return { media, boundary: bm ? bm[1] : undefined };
}

function decodeQuotedPrintable(input: string): string {
	const noSoftBreaks = input.replace(/=\r?\n/g, '');
	const bytes: number[] = [];
	for (let i = 0; i < noSoftBreaks.length; i++) {
		const c = noSoftBreaks[i]!;
		if (c === '=') {
			const hex = noSoftBreaks.slice(i + 1, i + 3);
			bytes.push(Number.parseInt(hex, 16));
			i += 2;
		} else {
			bytes.push(c.charCodeAt(0));
		}
	}
	return Buffer.from(bytes).toString('utf-8');
}

function decodeBody(body: string, cte: string): string {
	const enc = cte.toLowerCase();
	if (enc === 'base64') {
		return Buffer.from(body.replace(/\r?\n/g, ''), 'base64').toString('utf-8');
	}
	if (enc === 'quoted-printable') {
		return decodeQuotedPrintable(body);
	}
	return body;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split a multipart body into its child part sections (preamble/epilogue dropped). */
function splitByBoundary(body: string, boundary: string): string[] {
	// Prefix a CRLF so a boundary at the very start of the body is matched by the
	// same `\r\n--boundary` delimiter as the interior ones.
	const segments = ('\r\n' + body).split(new RegExp('\\r\\n--' + escapeRegExp(boundary)));
	const parts: string[] = [];
	for (let i = 1; i < segments.length; i++) {
		const seg = segments[i]!;
		if (seg.startsWith('--')) break; // closing delimiter `--boundary--`
		parts.push(seg.replace(/^\r\n/, ''));
	}
	return parts;
}

function walk(section: string, tree: string[], leaves: LeafPart[]): void {
	const { headers, body } = splitHeadersBody(section);
	const { media, boundary } = contentTypeOf(headers);
	tree.push(media);
	if (media.startsWith('multipart/') && boundary !== undefined) {
		for (const part of splitByBoundary(body, boundary)) {
			walk(part, tree, leaves);
		}
		return;
	}
	const cte = headerValue(headers, 'Content-Transfer-Encoding') || '7bit';
	leaves.push({ contentType: media, encoding: cte.toLowerCase(), text: decodeBody(body, cte) });
}

export function parseMime(raw: Buffer): MimeTree {
	const tree: string[] = [];
	const leaves: LeafPart[] = [];
	walk(raw.toString('utf-8'), tree, leaves);
	return { tree, leaves };
}
