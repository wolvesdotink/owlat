/**
 * Pure RFC 5322 / RFC 2045 message construction.
 *
 * `buildRfc822` takes plain data (a neutral `ComposeInput` plus decoded
 * attachment bytes) and returns the exact `.eml` bytes that get stored and
 * shipped to the MTA — no `ctx`, db, network, or `await`. Deterministic w.r.t.
 * its inputs; the only impurities live in `encoding.randomBoundary` and the
 * caller-supplied `Message-ID` / `Date`.
 *
 * Storage fetching, DraftRow mapping, and transport orchestration live in the
 * Convex adapter (`apps/api/convex/mail/rfc822.ts`) and `outbound.ts`.
 */

import {
	encodeAddressHeader,
	encodeHeaderValue,
	escapeHeader,
	safeAttachmentFilename,
} from './headers';
import { encodeTextBody, randomBoundary } from './encoding';
import { buildMessageId } from './messageId';

/**
 * Attachment content at the package boundary: either decoded `Buffer` bytes or
 * an already-base64-encoded string. Storage fetching / decoding happens in the
 * Convex send path before the bytes reach the composer.
 */
export interface ComposeAttachment {
	filename: string;
	contentType: string;
	isInline: boolean;
	data: Buffer | string;
	contentId?: string;
}

/**
 * The neutral shape the composer reads. The Convex adapter maps its `DraftRow`
 * onto this so the composer never depends on Convex types.
 */
export interface ComposeInput {
	fromAddress: string;
	toAddresses: string[];
	ccAddresses: string[];
	bccAddresses: string[];
	subject: string;
	bodyHtml: string;
	bodyText?: string;
	/**
	 * Rendered AMP4Email body. Present only for block-designed drafts that use an
	 * interactive block. When set, the multipart message carries it as a
	 * `text/x-amp-html` alternative for AMP-capable clients, with the HTML part as
	 * the fallback.
	 */
	bodyAmp?: string;
}

/** Render a single text MIME part: boundary, content-type, chosen CTE, encoded body. */
function textPart(
	boundary: string,
	contentType: string,
	body: string,
	trailingCrlf: boolean
): string {
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
	return `--${parentBoundary}\r\n` + `${entity.headerLines.join('\r\n')}\r\n\r\n${entity.body}`;
}

/** Join child parts with CRLF and close the multipart with its `--boundary--`. */
function closeMultipart(boundary: string, parts: string[]): string {
	return `${parts.join('\r\n')}\r\n--${boundary}--`;
}

/**
 * Matches a string that is nothing but base64 alphabet characters — no
 * whitespace, no CRLF, no padding mid-string. A caller who passes raw text by
 * mistake (instead of a `Buffer` or an already-base64 string) hits this and
 * fails loudly, rather than shipping a MIME part whose 76-char re-chunk regex
 * has miscounted embedded CRLFs into its window.
 */
const BASE64_ONLY = /^[A-Za-z0-9+/]*={0,2}$/;

/** A base64 attachment/inline entity (Content-Disposition + optional Content-ID). */
function attachmentEntity(att: ComposeAttachment): MimeEntity {
	let base64: string;
	if (typeof att.data === 'string') {
		if (!BASE64_ONLY.test(att.data)) {
			throw new Error(
				`attachment "${att.filename}": string data must be base64 ` +
					'(A-Za-z0-9+/=); pass a Buffer for raw bytes'
			);
		}
		base64 = att.data;
	} else {
		base64 = att.data.toString('base64');
	}
	const b64 = base64.replace(/(.{76})/g, '$1\r\n');
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
	input: ComposeInput,
	attachments: ComposeAttachment[],
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
	headers.push(`From: ${encodeAddressHeader([input.fromAddress])}`);
	headers.push(`To: ${encodeAddressHeader(input.toAddresses)}`);
	if (input.ccAddresses.length > 0) {
		headers.push(`Cc: ${encodeAddressHeader(input.ccAddresses)}`);
	}
	// Bcc is visible to the envelope only; it is deliberately never emitted as a header.
	headers.push(`Subject: ${encodeHeaderValue(input.subject || '(no subject)')}`);
	if (inReplyToHeaderValue) headers.push(`In-Reply-To: ${inReplyToHeaderValue}`);
	if (referencesHeaderValue) headers.push(`References: ${referencesHeaderValue}`);
	headers.push('MIME-Version: 1.0');

	const amp = input.bodyAmp;
	// An AMP part always needs a multipart/alternative wrapper so non-AMP
	// clients can fall through to the HTML part.
	const useMultipartAlt = (!!input.bodyText && !!input.bodyHtml) || !!amp;
	const text = input.bodyText ?? stripHtml(input.bodyHtml ?? '');
	const html = input.bodyHtml ?? '';

	// Inline images (a `cid:`-referenced `<img>` in the body) ride in a
	// multipart/related next to the HTML that references them; file attachments
	// stay in the outer multipart/mixed. An inline part is one flagged `isInline`
	// AND carrying a Content-ID (the two together are how the send path marks an
	// embedded body image); everything else is a downloadable attachment.
	const inlineParts = attachments.filter((a) => a.isInline && !!a.contentId);
	const fileParts = attachments.filter((a) => !(a.isInline && a.contentId));

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
	if (inlineParts.length > 0) {
		const relBoundary = randomBoundary();
		const parts = [
			asPart(relBoundary, content),
			...inlineParts.map((att) => asPart(relBoundary, attachmentEntity(att))),
		];
		content = {
			headerLines: [`Content-Type: multipart/related; type="text/html"; boundary="${relBoundary}"`],
			body: closeMultipart(relBoundary, parts),
		};
	}

	// Wrap everything in multipart/mixed when there are file attachments.
	if (fileParts.length > 0) {
		const mixBoundary = randomBoundary();
		const parts = [
			asPart(mixBoundary, content),
			...fileParts.map((att) => asPart(mixBoundary, attachmentEntity(att))),
		];
		content = {
			headerLines: [`Content-Type: multipart/mixed; boundary="${mixBoundary}"`],
			body: closeMultipart(mixBoundary, parts),
		};
	}

	const raw = Buffer.from(
		`${headers.join('\r\n')}\r\n${content.headerLines.join('\r\n')}\r\n\r\n${content.body}\r\n`,
		'utf-8'
	);
	return { raw, size: raw.length };
}

/**
 * The full input surface `composeMessage` accepts — the union of everything the
 * MTA direct-MX sender, the API SMTP-relay adapter, and the postbox composer
 * feed nodemailer today. Address fields are RFC 5322 strings (`m@x.test` or
 * `Display Name <m@x.test>`); the composer formats and RFC-2047-encodes them.
 */
export interface ComposeMessageInput {
	/** RFC 5322 From — a single mailbox (`addr-spec` or `name-addr`). */
	from: string;
	/** Optional Reply-To mailbox. */
	replyTo?: string;
	to: string[];
	cc?: string[];
	/** Bcc recipients — carried into the returned envelope, never emitted as a header. */
	bcc?: string[];
	subject: string;
	html?: string;
	/** Explicit text part. When absent and `html` is present, derived via `stripHtml`. */
	text?: string;
	/**
	 * Rendered AMP4Email body. Emitted as a `text/x-amp-html` alternative ordered
	 * BEFORE the HTML part (plain -> amp -> html) so a non-AMP reader falls through
	 * to the HTML fallback (RFC 2046 alternative: last renderable part wins).
	 */
	amp?: string;
	attachments?: ComposeAttachment[];
	/**
	 * Arbitrary extra headers (e.g. `X-Owlat-*` tracing). CRLF is stripped from
	 * names and values (injection defence) and any header that collides with a
	 * structural header the composer emits itself is dropped.
	 */
	headers?: Record<string, string>;
	/** Explicit `Message-ID` value (including angle brackets). */
	messageId?: string;
	/** Domain used to generate a `Message-ID` when `messageId` is absent. */
	messageIdDomain?: string;
	/** `In-Reply-To` header value (including angle brackets). */
	inReplyTo?: string;
	/** `References` header value. */
	references?: string;
	/**
	 * Seed inputs that make composition deterministic (byte-identical) across
	 * calls — the property DKIM-stable MX retries and golden tests rely on. When
	 * omitted the composer falls back to `new Date()` and crypto-random boundaries.
	 */
	date?: Date;
	boundarySeed?: string;
	/**
	 * Explicit SMTP envelope override. When absent the envelope is derived from
	 * the header addresses: `from` = the From addr-spec, `to` = every To/Cc/Bcc
	 * addr-spec (nodemailer `getEnvelope()` semantics).
	 */
	envelope?: { from: string; to: string[] };
}

/** What `composeMessage` returns: the wire bytes, the Message-ID it used, and the SMTP envelope. */
export interface ComposedMessage {
	raw: Buffer;
	messageId: string;
	envelope: { from: string; to: string[] };
}

/**
 * Structural headers the composer emits from typed input. A caller-supplied
 * extra header colliding with one of these is dropped so the message never
 * carries a duplicate (and a hostile `headers['bcc']` can't leak recipients).
 */
const STRUCTURAL_HEADERS: ReadonlySet<string> = new Set([
	'message-id',
	'date',
	'from',
	'reply-to',
	'to',
	'cc',
	'bcc',
	'subject',
	'in-reply-to',
	'references',
	'mime-version',
	'content-type',
	'content-transfer-encoding',
	'content-disposition',
	'content-id',
]);

/** Strip CRLF / colon / control bytes from an extra-header NAME (injection defence). */
function sanitizeHeaderName(name: string): string {
	// eslint-disable-next-line no-control-regex
	return name.replace(/[\r\n:\x00-\x1F\x7F]/g, '').trim();
}

/** Extract the bare `addr-spec` (`m@x.test`) from an `addr-spec` or `name-addr` string. */
function addrSpec(addr: string): string {
	const s = escapeHeader(addr).trim();
	const lt = s.lastIndexOf('<');
	const gt = s.lastIndexOf('>');
	if (lt >= 0 && gt > lt) return s.slice(lt + 1, gt).trim();
	return s;
}

/**
 * RFC 5322 §3.3 date-time. `toUTCString()` emits the obsolete `GMT` zone
 * (§4.3 obs-zone); rewrite it to the canonical numeric `+0000`.
 */
function formatRfc5322Date(date: Date): string {
	return date.toUTCString().replace(/GMT$/, '+0000');
}

/**
 * Deterministic-or-random boundary allocator. With a seed the returned function
 * yields `--_owlat_<seed>_0`, `_1`, … in call order — so a message with the same
 * seed composes byte-identically. Without a seed each call is crypto-random,
 * matching the historical `randomBoundary` behaviour.
 */
function boundaryAllocator(seed: string | undefined): () => string {
	if (seed === undefined) return randomBoundary;
	let n = 0;
	return () => `--_owlat_${seed}_${(n++).toString()}`;
}

/** Derive the SMTP envelope from typed input (nodemailer `getEnvelope()` semantics). */
function deriveEnvelope(input: ComposeMessageInput): { from: string; to: string[] } {
	if (input.envelope) {
		return { from: input.envelope.from, to: [...input.envelope.to] };
	}
	const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];
	const to = recipients.map(addrSpec).filter((a) => a.length > 0);
	return { from: addrSpec(input.from), to };
}

/**
 * Compose a full RFC 5322 / RFC 2045 message from the neutral
 * `ComposeMessageInput`, returning the wire bytes, the Message-ID used, and the
 * SMTP envelope. This is the nodemailer-composer replacement: it covers
 * from/replyTo/to/cc/bcc, subject, html + text (with `stripHtml` fallback), an
 * AMP alternative ordered before HTML, Buffer/inline-CID attachments, arbitrary
 * injection-stripped extra headers, and an explicit-or-generated Message-ID.
 *
 * Body encoding is always 7-bit safe (quoted-printable / base64) — never 8bit,
 * any version (locked decision D2). Given seeded `date`/`boundarySeed` inputs the
 * output is byte-identical across calls, which is what makes DKIM-stable retries
 * and golden tests possible.
 */
export function composeMessage(input: ComposeMessageInput): ComposedMessage {
	const messageId =
		input.messageId ??
		buildMessageId(input.messageIdDomain ?? addrSpec(input.from).split('@')[1] ?? 'localhost');
	const date = input.date ?? new Date();
	const nextBoundary = boundaryAllocator(input.boundarySeed);

	const headers: string[] = [];
	headers.push(`Message-ID: ${messageId}`);
	headers.push(`Date: ${formatRfc5322Date(date)}`);
	headers.push(`From: ${encodeAddressHeader([input.from])}`);
	if (input.replyTo) headers.push(`Reply-To: ${encodeAddressHeader([input.replyTo])}`);
	headers.push(`To: ${encodeAddressHeader(input.to)}`);
	if (input.cc && input.cc.length > 0) {
		headers.push(`Cc: ${encodeAddressHeader(input.cc)}`);
	}
	// Bcc is envelope-only; deliberately never emitted as a header.
	headers.push(`Subject: ${encodeHeaderValue(input.subject || '(no subject)')}`);
	if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`);
	if (input.references) headers.push(`References: ${input.references}`);
	headers.push('MIME-Version: 1.0');

	// Arbitrary extra headers, injection-stripped, minus any collision with a
	// structural header the composer emits itself.
	if (input.headers) {
		for (const [rawName, rawValue] of Object.entries(input.headers)) {
			const name = sanitizeHeaderName(rawName);
			if (name.length === 0) continue;
			if (STRUCTURAL_HEADERS.has(name.toLowerCase())) continue;
			headers.push(`${name}: ${encodeHeaderValue(rawValue)}`);
		}
	}

	const content = buildContentEntity(input, nextBoundary);

	const raw = Buffer.from(
		`${headers.join('\r\n')}\r\n${content.headerLines.join('\r\n')}\r\n\r\n${content.body}\r\n`,
		'utf-8'
	);
	return { raw, messageId, envelope: deriveEnvelope(input) };
}

/**
 * Build the message "content" entity — the body and its attachments — shared by
 * the composer. Mirrors the MIME nesting nodemailer produces: an
 * `alternative` (plain -> amp -> html) inside a `related` (inline cid: images)
 * inside a `mixed` (file attachments), collapsing each layer that is unneeded.
 */
function buildContentEntity(input: ComposeMessageInput, nextBoundary: () => string): MimeEntity {
	const amp = input.amp;
	const useMultipartAlt = (!!input.text && !!input.html) || !!amp;
	const text = input.text ?? stripHtml(input.html ?? '');
	const html = input.html ?? '';

	const attachments = input.attachments ?? [];
	const inlineParts = attachments.filter((a) => a.isInline && !!a.contentId);
	const fileParts = attachments.filter((a) => !(a.isInline && a.contentId));

	let content: MimeEntity;
	if (useMultipartAlt) {
		const altBoundary = nextBoundary();
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
		// Single part: text/html when HTML is present, else text/plain. Pick a CTE
		// that keeps every line <=998 octets and never emits 8bit.
		const single = html || text;
		const contentType = input.html ? 'text/html' : 'text/plain';
		const { cte, encoded } = encodeTextBody(single);
		content = {
			headerLines: [
				`Content-Type: ${contentType}; charset=utf-8`,
				`Content-Transfer-Encoding: ${cte}`,
			],
			body: encoded,
		};
	}

	if (inlineParts.length > 0) {
		const relBoundary = nextBoundary();
		const parts = [
			asPart(relBoundary, content),
			...inlineParts.map((att) => asPart(relBoundary, attachmentEntity(att))),
		];
		content = {
			headerLines: [`Content-Type: multipart/related; type="text/html"; boundary="${relBoundary}"`],
			body: closeMultipart(relBoundary, parts),
		};
	}

	if (fileParts.length > 0) {
		const mixBoundary = nextBoundary();
		const parts = [
			asPart(mixBoundary, content),
			...fileParts.map((att) => asPart(mixBoundary, attachmentEntity(att))),
		];
		content = {
			headerLines: [`Content-Type: multipart/mixed; boundary="${mixBoundary}"`],
			body: closeMultipart(mixBoundary, parts),
		};
	}

	return content;
}

export function stripHtml(html: string): string {
	return html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}
