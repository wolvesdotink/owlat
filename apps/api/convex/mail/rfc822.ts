'use node';

/**
 * Pure RFC 5322 / RFC 2045 message construction for personal-mail drafts.
 *
 * These helpers take plain data and return strings / Buffers — no `ctx`, no
 * db, no network, no `await`. They build the exact bytes that get stored as
 * the raw `.eml` and shipped to the MTA, so the postbox tests assert on their
 * output structure. Keep them deterministic w.r.t. their inputs (the only
 * impurity is `randomBytes` for boundaries/Message-IDs and `Date.now()`).
 *
 * The orchestration that calls these — scanning, storage, lifecycle, transport
 * — lives in `outbound.ts`.
 */

import { randomBytes } from 'crypto';
import type { Id } from '../_generated/dataModel';

/**
 * The subset of a draft row the RFC822 builder reads. `outbound.ts` fetches
 * the full row via the lifecycle query and passes it straight through.
 */
export interface DraftRow {
	_id: Id<'mailDrafts'>;
	mailboxId: Id<'mailboxes'>;
	inReplyToMessageId?: Id<'mailMessages'>;
	threadId?: Id<'mailThreads'>;
	toAddresses: string[];
	ccAddresses: string[];
	bccAddresses: string[];
	fromAddress: string;
	subject: string;
	bodyHtml: string;
	bodyText?: string;
	/**
	 * Rendered AMP4Email body. Present only for block-designed drafts that use
	 * an interactive block (accordion/carousel). When set, the multipart message
	 * carries it as a `text/x-amp-html` alternative for AMP-capable clients,
	 * with the HTML part as the fallback. Not stored on the draft row itself —
	 * `outbound.ts` renders it at dispatch time and mutates it onto the row.
	 */
	bodyAmp?: string;
	bodyBlocks?: string;
	composerMode?: 'simple' | 'full';
	attachments: Array<{
		storageId: Id<'_storage'>;
		filename: string;
		contentType: string;
		size: number;
		isInline: boolean;
		contentId?: string;
	}>;
	state: 'draft' | 'pending_send' | 'scheduled';
	undoToken?: string;
	scheduledSendAt?: number;
}

export function randomBoundary(): string {
	// crypto-random so a hostile body cannot collide with the boundary
	return `--_owlat_${randomBytes(12).toString('hex')}`;
}

export function escapeHeader(value: string): string {
	// Strip CRLF to prevent header injection
	return value.replace(/[\r\n]+/g, ' ');
}

/**
 * RFC 2047 encoded-word for a header value that may contain non-ASCII
 * characters. Plain-ASCII strings round-trip unchanged so most subjects
 * stay readable on the wire.
 *
 * For non-ASCII values the text is emitted as one or more base64 encoded-words.
 * RFC 2047 §2 caps a single encoded-word at 75 octets *including* the
 * `=?UTF-8?B?` … `?=` delimiters, and RFC 5322 §2.2.3 caps a header line at
 * 998 octets (78 SHOULD). A single encoded-word for a long subject blows both
 * limits, so we chunk the UTF-8 payload onto multiple encoded-words and fold
 * the header with CRLF + SP between them (a "folding white space" per RFC 5322
 * §2.2.3). A receiver concatenates adjacent encoded-words, dropping the
 * intervening whitespace, so the original value round-trips exactly.
 *
 * Chunking happens on whole UTF-8 characters so a multi-byte codepoint is never
 * split across two encoded-words (which RFC 2047 §5 forbids — each encoded-word
 * must decode independently).
 *
 * A pure-ASCII value is normally left verbatim so the subject stays readable on
 * the wire, but RFC 5322 §2.1.1 still caps a physical header line at 998 octets.
 * The longest header prefix that routes through this helper is `Subject: `
 * (9 octets), so an ASCII value that — with that prefix — would exceed the cap
 * is routed through the same encoded-word folding as non-ASCII values. Base64
 * encoded-words are ASCII, fold with CRLF+SP, and decode back to the original
 * string, so the rendered line stays well under the limit without corrupting
 * the value (a whitespace-free 2000-char ASCII subject can't be folded on FWS).
 */
const MAX_HEADER_LINE_OCTETS = 998;
// Worst-case prefix for a value passed to encodeHeaderValue (`Subject: `).
const HEADER_PREFIX_OCTETS = 'Subject: '.length;

export function encodeHeaderValue(value: string): string {
	const stripped = escapeHeader(value);
	// eslint-disable-next-line no-control-regex
	if (/^[\x00-\x7F]*$/.test(stripped)) {
		// ASCII stays verbatim unless the rendered `Header: value` line would blow
		// the 998-octet hard line limit; then fold it via encoded-words.
		if (HEADER_PREFIX_OCTETS + stripped.length <= MAX_HEADER_LINE_OCTETS) {
			return stripped;
		}
	}
	return encodeWords(stripped).join('\r\n ');
}

/**
 * Build the list of RFC 2047 base64 encoded-words for a non-ASCII string, each
 * <=75 octets including delimiters. Returned un-folded so callers can join them
 * with whatever folding white space their header position requires.
 */
function encodeWords(text: string): string[] {
	const prefix = '=?UTF-8?B?';
	const suffix = '?=';
	// Octets available for base64 payload inside one <=75-octet encoded-word.
	const maxB64 = 75 - prefix.length - suffix.length;
	// Base64 emits 4 chars per 3 source octets; keep the source chunk a multiple
	// of 3 octets so each encoded-word's base64 is unpadded-until-the-last and
	// never overflows maxB64.
	const maxSrcBytes = Math.floor(maxB64 / 4) * 3;

	const words: string[] = [];
	let chunkBytes = 0;
	let chunk = '';
	const flush = () => {
		if (chunk.length === 0) return;
		words.push(`${prefix}${Buffer.from(chunk, 'utf-8').toString('base64')}${suffix}`);
		chunk = '';
		chunkBytes = 0;
	};
	// Iterate by codepoint (the spread operator splits on full Unicode chars, so
	// surrogate pairs and combining sequences stay whole within a word).
	for (const ch of text) {
		const chBytes = Buffer.byteLength(ch, 'utf-8');
		if (chunkBytes + chBytes > maxSrcBytes) flush();
		chunk += ch;
		chunkBytes += chBytes;
	}
	flush();
	return words;
}

/**
 * Encode an address-list header value (From / To / Cc) per RFC 5322 §3.4.
 *
 * Each address may be a bare `addr-spec` (`m@x.test`) or a `name-addr`
 * (`Display Name <m@x.test>`). The addr-spec is left literal — encoding it as a
 * 2047 word would make it unroutable — while a non-ASCII display-name phrase is
 * RFC-2047 encoded (RFC 2047 §5 allows encoded-words in a `phrase`). ASCII
 * phrases pass through unchanged.
 */
export function encodeAddressHeader(addresses: string[]): string {
	const encoded: string[] = [];
	for (const raw of addresses) {
		const one = encodeSingleAddress(escapeHeader(raw));
		if (one.length > 0) encoded.push(one);
	}
	return encoded.join(', ');
}

function encodeSingleAddress(addr: string): string {
	const trimmed = addr.trim();
	if (trimmed.length === 0) return '';
	// `name-addr` form: `phrase <addr-spec>`. Split on the last '<' so a '<' in
	// the display name doesn't confuse the parse (display names are rare to
	// contain one, but be defensive).
	const lt = trimmed.lastIndexOf('<');
	const gt = trimmed.lastIndexOf('>');
	if (lt > 0 && gt > lt) {
		const phrase = trimmed.slice(0, lt).trim();
		const addrSpec = trimmed.slice(lt, gt + 1); // includes the angle brackets
		const encodedPhrase = encodePhrase(phrase);
		return encodedPhrase ? `${encodedPhrase} ${addrSpec}` : addrSpec;
	}
	// Bare addr-spec (no display name) — leave literal.
	return trimmed;
}

function encodePhrase(phrase: string): string {
	// eslint-disable-next-line no-control-regex
	if (/^[\x00-\x7F]*$/.test(phrase)) {
		// ASCII phrase: keep readable. (Surrounding quotes, if any, are preserved
		// as the composer wrote them.)
		return phrase;
	}
	return encodeWords(phrase).join('\r\n ');
}

/** Filenames in `Content-Disposition: …; filename="…"` — strip CRLF, quotes, control chars. */
export function safeAttachmentFilename(name: string): string {
	// eslint-disable-next-line no-control-regex
	return name.replace(/[\r\n\x00-\x1F\x7F"]/g, '_');
}

export function buildMessageId(domain: string): string {
	return `<${Date.now().toString(36)}.${randomBytes(6).toString('hex')}@${domain}>`;
}

/**
 * Quoted-printable encode per RFC 2045 §6.7.
 *
 * The input is CRLF-normalized first so that hard line breaks are preserved as
 * CRLF and any bare CR/LF the renderer produced is canonicalised. Every output
 * line is kept to at most 76 octets via soft (`=`-terminated) line breaks, which
 * also keeps us comfortably under the RFC 5322 §2.1.1 998-octet hard limit.
 */
export function quotedPrintableEncode(input: string): string {
	// Canonicalise all line endings to CRLF first.
	const normalized = input.replace(/\r\n|\r|\n/g, '\n');
	const lines = normalized.split('\n');
	const out: string[] = [];

	for (const line of lines) {
		const bytes = Buffer.from(line, 'utf-8');
		const tokens: string[] = [];
		for (let i = 0; i < bytes.length; i++) {
			const b = bytes[i]!;
			const isLast = i === bytes.length - 1;
			// Printable ASCII except '=' (0x3D) is literal. Space/tab are literal
			// unless they fall at end of line (then they must be encoded).
			if (b === 0x3d) {
				tokens.push('=3D');
			} else if (b === 0x09 || b === 0x20) {
				tokens.push(isLast ? (b === 0x09 ? '=09' : '=20') : String.fromCharCode(b));
			} else if (b >= 0x21 && b <= 0x7e) {
				tokens.push(String.fromCharCode(b));
			} else {
				tokens.push(`=${b.toString(16).toUpperCase().padStart(2, '0')}`);
			}
		}

		// Fold into <=76-octet output lines using soft line breaks ("=\r\n").
		// A soft break and any escape sequence must never be split, so we track
		// the current line length and break before a token would overflow.
		//
		// RFC 2045 §6.7 rule (3): whitespace must not appear at the end of an
		// encoded line, *including* immediately before a soft line break. Space
		// and tab are emitted literally above (they're only encoded when they're
		// the last byte of the input line), so folding can push a literal space
		// or tab to the end of an output line right before the '='. A
		// whitespace-trimming relay would strip it and corrupt the body / break
		// DKIM, so escape any trailing literal space/tab before the soft break.
		//
		// That whitespace->'=20'/'=09' rewrite grows the line by 2 octets (1 char
		// becomes 3), so we fold at 73 (not 75): worst case a 73-octet `current`
		// ending in a literal space becomes 75 octets after the rewrite, then the
		// trailing '=' brings the physical line to exactly 76 — the RFC 2045 cap.
		let current = '';
		const pushSoftBreak = () => {
			if (current.endsWith(' ')) {
				current = `${current.slice(0, -1)}=20`;
			} else if (current.endsWith('\t')) {
				current = `${current.slice(0, -1)}=09`;
			}
			out.push(current + '=');
			current = '';
		};
		for (const tok of tokens) {
			if (current.length + tok.length > 73) {
				pushSoftBreak();
			}
			current += tok;
		}
		out.push(current);
	}

	return out.join('\r\n');
}

/**
 * Choose a Content-Transfer-Encoding for a text body and return the encoded
 * bytes alongside the CTE token.
 *
 * - Pure-ASCII bodies whose every CRLF-delimited line is <=998 octets stay
 *   7bit (CRLF-normalized) so the common case is human-readable on the wire.
 * - Everything else (non-ASCII, or an over-long line) is quoted-printable,
 *   which guarantees <=76 octets per line and round-trips non-ASCII safely.
 *
 * 8bit is never emitted: it breaks on non-8BITMIME relays (RFC 6152) and a
 * single-line render trivially exceeds the 998-octet line cap (RFC 5322
 * §2.1.1).
 */
export function encodeTextBody(body: string): { cte: '7bit' | 'quoted-printable'; encoded: string } {
	const normalized = body.replace(/\r\n|\r|\n/g, '\r\n');
	// eslint-disable-next-line no-control-regex
	const isAscii = /^[\x00-\x7F]*$/.test(normalized);
	const lineSafe = normalized.split('\r\n').every((line) => Buffer.byteLength(line, 'utf-8') <= 998);
	if (isAscii && lineSafe) {
		return { cte: '7bit', encoded: normalized };
	}
	return { cte: 'quoted-printable', encoded: quotedPrintableEncode(body) };
}

/** Render a single text MIME part: boundary, content-type, chosen CTE, encoded body. */
function textPart(boundary: string, contentType: string, body: string, trailingCrlf: boolean): string {
	const { cte, encoded } = encodeTextBody(body);
	const part =
		`--${boundary}\r\nContent-Type: ${contentType}; charset=utf-8\r\n` +
		`Content-Transfer-Encoding: ${cte}\r\n\r\n${encoded}`;
	return trailingCrlf ? `${part}\r\n` : part;
}

/**
 * A self-contained MIME entity: the header lines that describe it (its
 * Content-Type et al.) plus the already-encoded body that follows the blank
 * line. Composing a message is wrapping one entity inside another (an
 * `alternative` inside a `related` inside a `mixed`), so keeping the two apart
 * lets `asPart` re-emit any entity as a child under a parent boundary.
 */
interface MimeEntity {
	headerLines: string[];
	body: string;
}

/** Emit an entity as a child part under `parentBoundary` (no trailing CRLF). */
function asPart(parentBoundary: string, entity: MimeEntity): string {
	return (
		`--${parentBoundary}\r\n` +
		`${entity.headerLines.join('\r\n')}\r\n\r\n${entity.body}`
	);
}

/** Join child parts with CRLF and close the multipart with its `--boundary--`. */
function closeMultipart(boundary: string, parts: string[]): string {
	return `${parts.join('\r\n')}\r\n--${boundary}--`;
}

/** A base64 attachment/inline entity (Content-Disposition + optional Content-ID). */
function attachmentEntity(att: {
	filename: string;
	contentType: string;
	isInline: boolean;
	data: Buffer;
	contentId?: string;
}): MimeEntity {
	const b64 = att.data.toString('base64').replace(/(.{76})/g, '$1\r\n');
	const dispositionType = att.isInline ? 'inline' : 'attachment';
	const headerLines = [
		`Content-Type: ${att.contentType}`,
		'Content-Transfer-Encoding: base64',
		`Content-Disposition: ${dispositionType}; filename="${safeAttachmentFilename(att.filename)}"`,
	];
	if (att.contentId) headerLines.push(`Content-ID: <${att.contentId}>`);
	return { headerLines, body: b64 };
}

export function buildRfc822(
	draft: DraftRow,
	attachmentBuffers: Array<{ filename: string; contentType: string; isInline: boolean; data: Buffer; contentId?: string }>,
	rfc822MessageId: string,
	inReplyToHeaderValue: string | undefined,
	referencesHeaderValue: string | undefined
): { raw: Buffer; size: number } {
	const headers: string[] = [];
	headers.push(`Message-ID: ${rfc822MessageId}`);
	// RFC 5322 §3.3 date-time uses a numeric `zone` (`+0000`). `toUTCString()`
	// emits the obsolete `GMT` form (RFC 5322 §4.3 obs-zone), so rewrite the
	// trailing zone to the canonical `+0000`.
	headers.push(`Date: ${new Date().toUTCString().replace(/GMT$/, '+0000')}`);
	headers.push(`From: ${encodeAddressHeader([draft.fromAddress])}`);
	headers.push(`To: ${encodeAddressHeader(draft.toAddresses)}`);
	if (draft.ccAddresses.length > 0) {
		headers.push(`Cc: ${encodeAddressHeader(draft.ccAddresses)}`);
	}
	if (draft.bccAddresses.length > 0) {
		// Bcc visible to envelope only; do NOT include in headers
	}
	headers.push(`Subject: ${encodeHeaderValue(draft.subject || '(no subject)')}`);
	if (inReplyToHeaderValue) headers.push(`In-Reply-To: ${inReplyToHeaderValue}`);
	if (referencesHeaderValue) headers.push(`References: ${referencesHeaderValue}`);
	headers.push('MIME-Version: 1.0');

	const amp = draft.bodyAmp;
	// An AMP part always needs a multipart/alternative wrapper so non-AMP
	// clients can fall through to the HTML part.
	const useMultipartAlt = (!!draft.bodyText && !!draft.bodyHtml) || !!amp;
	const text = draft.bodyText ?? stripHtml(draft.bodyHtml ?? '');
	const html = draft.bodyHtml ?? '';

	// Inline images (a `cid:`-referenced `<img>` in the body) ride in a
	// multipart/related next to the HTML that references them; file attachments
	// stay in the outer multipart/mixed. An inline part is one flagged `isInline`
	// AND carrying a Content-ID (the two together are how the send path marks an
	// embedded body image); everything else is a downloadable attachment.
	const inlineBuffers = attachmentBuffers.filter((a) => a.isInline && !!a.contentId);
	const fileBuffers = attachmentBuffers.filter((a) => !(a.isInline && a.contentId));

	// ── The message "content" entity: the body itself, before any attachments.
	// Either a single text/html part, or a multipart/alternative carrying
	// text/plain, an optional text/x-amp-html, and the text/html fallback.
	// RFC 2046: an alternative reader picks the LAST part it can render, so the
	// AMP-email order is text/plain → text/x-amp-html → text/html.
	let content: MimeEntity;
	if (useMultipartAlt) {
		const altBoundary = randomBoundary();
		const altBody =
			textPart(altBoundary, 'text/plain', text, true) +
			(amp ? textPart(altBoundary, 'text/x-amp-html', amp, true) : '') +
			textPart(altBoundary, 'text/html', html, true) +
			`--${altBoundary}--`;
		content = {
			headerLines: [`Content-Type: multipart/alternative; boundary="${altBoundary}"`],
			body: altBody,
		};
	} else {
		// Single-part HTML. CRLF-normalize and pick a CTE that keeps every line
		// <=998 octets and never emits 8bit (RFC 5322 §2.1.1, RFC 6152).
		const { cte, encoded } = encodeTextBody(html || text);
		content = {
			headerLines: ['Content-Type: text/html; charset=utf-8', `Content-Transfer-Encoding: ${cte}`],
			body: encoded,
		};
	}

	// Wrap the body + its inline images in multipart/related (RFC 2387). The
	// `type` parameter names the root part so a reader knows the HTML is the
	// entity the cid: images belong to.
	if (inlineBuffers.length > 0) {
		const relBoundary = randomBoundary();
		const parts = [
			asPart(relBoundary, content),
			...inlineBuffers.map((att) => asPart(relBoundary, attachmentEntity(att))),
		];
		content = {
			headerLines: [
				`Content-Type: multipart/related; type="text/html"; boundary="${relBoundary}"`,
			],
			body: closeMultipart(relBoundary, parts),
		};
	}

	// Wrap everything in multipart/mixed when there are file attachments.
	if (fileBuffers.length > 0) {
		const mixBoundary = randomBoundary();
		const parts = [
			asPart(mixBoundary, content),
			...fileBuffers.map((att) => asPart(mixBoundary, attachmentEntity(att))),
		];
		content = {
			headerLines: [`Content-Type: multipart/mixed; boundary="${mixBoundary}"`],
			body: closeMultipart(mixBoundary, parts),
		};
	}

	const raw = Buffer.from(
		`${headers.join('\r\n')}\r\n${content.headerLines.join('\r\n')}\r\n\r\n${content.body}\r\n`,
		'utf-8',
	);
	return { raw, size: raw.length };
}

export function stripHtml(html: string): string {
	return html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}
