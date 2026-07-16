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

import { encodeAddressHeader, encodeHeaderValue, escapeHeader } from './headers';
import { randomBoundary } from './encoding';
import { buildMessageId } from './messageId';
import { assembleBody, type ComposeAttachment, type MimeEntity } from './mime';

export type { ComposeAttachment } from './mime';

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

	// Inline images (a `cid:`-referenced `<img>` in the body) ride in a
	// multipart/related next to the HTML that references them; file attachments
	// stay in the outer multipart/mixed. An inline part is one flagged `isInline`
	// AND carrying a Content-ID (the two together are how the send path marks an
	// embedded body image); everything else is a downloadable attachment.
	const inlineParts = attachments.filter((a) => a.isInline && !!a.contentId);
	const fileParts = attachments.filter((a) => !(a.isInline && a.contentId));

	// Legacy nesting (related wraps the whole alternative, single-part always
	// text/html) is preserved here until the `buildRfc822` call sites cut over to
	// `composeMessage`; the shared assembler carries the parameterised difference.
	const content = assembleBody({
		text: input.bodyText ?? stripHtml(input.bodyHtml ?? ''),
		html: input.bodyHtml ?? '',
		amp: input.bodyAmp,
		useMultipartAlt: (!!input.bodyText && !!input.bodyHtml) || !!input.bodyAmp,
		inlineParts,
		fileParts,
		nextBoundary: randomBoundary,
		legacyRelatedNesting: true,
		singlePartContentType: 'text/html',
	});

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

/**
 * Restrict an extra-header NAME to RFC 5322 `ftext` — printable ASCII 33–126
 * excluding `:` — dropping everything else (CRLF, controls, spaces, non-ASCII).
 * A name that reduces to empty is dropped by the caller, so `'X Owlat'` becomes
 * `XOwlat` and `'X-Grüße'` becomes `X-Gre` rather than serializing a malformed
 * header line.
 */
function sanitizeHeaderName(name: string): string {
	// eslint-disable-next-line no-control-regex
	return name.replace(/[^\x21-\x39\x3B-\x7E]/g, '');
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
const BOUNDARY_SEED = /^[A-Za-z0-9._-]{1,40}$/;

function boundaryAllocator(seed: string | undefined): () => string {
	if (seed === undefined) return randomBoundary;
	// The seed is interpolated into `boundary="..."`. Reject anything outside a
	// safe `bchars` subset (RFC 2046 §5.1.1) or longer than would fit under the
	// 70-char boundary cap, so it can neither corrupt the Content-Type parameter
	// nor overrun the cap.
	if (!BOUNDARY_SEED.test(seed)) {
		throw new Error(
			`invalid boundarySeed "${seed}": must match ${BOUNDARY_SEED.source} ` +
				'(RFC 2046 bchars, <=40 chars)'
		);
	}
	let n = 0;
	return () => `--_owlat_${seed}_${(n++).toString()}`;
}

/** Strip CR/LF outright (envelope addresses feed MAIL FROM / RCPT TO — no space substitution). */
function stripCrlf(value: string): string {
	return value.replace(/[\r\n]/g, '');
}

/**
 * Derive the SMTP envelope from typed input (nodemailer `getEnvelope()`
 * semantics): From addr-spec, and every To/Cc/Bcc addr-spec deduped in
 * first-seen order (nodemailer `_convertAddresses` builds a unique list, so a
 * recipient listed in both To and Cc yields a single RCPT TO, not two copies).
 */
function deriveEnvelope(input: ComposeMessageInput): { from: string; to: string[] } {
	if (input.envelope) {
		// An explicit override is returned to the caller and fed to MAIL FROM /
		// RCPT TO downstream — strip CRLF for defence in depth so this package never
		// hands back a CRLF-bearing envelope.
		return {
			from: stripCrlf(input.envelope.from),
			to: input.envelope.to.map(stripCrlf),
		};
	}
	const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];
	const seen = new Set<string>();
	const to: string[] = [];
	for (const raw of recipients) {
		const spec = addrSpec(raw);
		if (spec.length === 0 || seen.has(spec)) continue;
		seen.add(spec);
		to.push(spec);
	}
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
	// `input.messageId` / `inReplyTo` / `references` are routinely derived from an
	// inbound message's Message-ID in reply flows (attacker-controlled), so strip
	// CRLF before serialization — a value like `<x@y>\r\nBcc: leak@evil.test`
	// would otherwise smuggle a header (nodemailer sanitizes these too).
	const messageId = escapeHeader(
		input.messageId ??
			buildMessageId(input.messageIdDomain ?? addrSpec(input.from).split('@')[1] ?? 'localhost')
	);
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
	// Bcc is envelope-only; deliberately never emitted as a header. The empty
	// subject is emitted as-is (nodemailer parity — the composer invents no
	// placeholder; a placeholder subject is the caller's decision).
	headers.push(`Subject: ${encodeHeaderValue(input.subject)}`);
	if (input.inReplyTo) headers.push(`In-Reply-To: ${escapeHeader(input.inReplyTo)}`);
	if (input.references) headers.push(`References: ${escapeHeader(input.references)}`);
	headers.push('MIME-Version: 1.0');

	// Arbitrary extra headers, injection-stripped, minus any collision with a
	// structural header the composer emits itself. Fold each value against its
	// actual `Name: ` prefix so the 998-octet hard cap holds for long names too.
	if (input.headers) {
		for (const [rawName, rawValue] of Object.entries(input.headers)) {
			const name = sanitizeHeaderName(rawName);
			if (name.length === 0) continue;
			if (STRUCTURAL_HEADERS.has(name.toLowerCase())) continue;
			headers.push(`${name}: ${encodeHeaderValue(rawValue, name.length + 2)}`);
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
 * Build the message "content" entity for `composeMessage` — the body and its
 * attachments — in nodemailer-parity nesting via the shared `assembleBody`:
 * `mixed(alternative(plain[, amp], related(html, inline)), files)`, collapsing
 * each layer that is unneeded.
 */
function buildContentEntity(input: ComposeMessageInput, nextBoundary: () => string): MimeEntity {
	const attachments = input.attachments ?? [];
	return assembleBody({
		text: input.text ?? stripHtml(input.html ?? ''),
		html: input.html ?? '',
		amp: input.amp,
		useMultipartAlt: (!!input.text && !!input.html) || !!input.amp,
		inlineParts: attachments.filter((a) => a.isInline && !!a.contentId),
		fileParts: attachments.filter((a) => !(a.isInline && a.contentId)),
		nextBoundary,
		legacyRelatedNesting: false,
		singlePartContentType: input.html ? 'text/html' : 'text/plain',
	});
}

export function stripHtml(html: string): string {
	return html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}
