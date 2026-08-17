/**
 * PGP / S-MIME message structure detection (RFC 3156 / S-MIME) for Postbox.
 *
 * This module is DETECTION only — it deliberately makes no cryptographic
 * claim. The cryptography lives elsewhere: PGP-signed (unencrypted) mail is
 * verified server-side at ingest (`apps/api/convex/e2ee/verifyInboundSignature`,
 * keyed through the WKD/TOFU pinning ladder) and the verdict persists as
 * `inboundSignatureInfo`; sealed mail has its own decrypt+verify path. The
 * reader badge is driven by those verdicts and only falls back to the
 * structural class here — rendered as "signed · not verified", never as a
 * green check — when no verdict was computed (e.g. S/MIME, which is still
 * detection-only).
 */

export type SecureMessageClass =
	| 'pgp-encrypted'
	| 'pgp-signed'
	| 'pgp-clearsigned'
	| 'smime-encrypted'
	| 'smime-signed'
	| 'none';

export interface SecureMessageInput {
	/** Attachment/part content types (e.g. application/pgp-signature). */
	attachments?: Array<{ contentType: string; filename?: string }>;
	/** The plaintext body, used to spot inline ("clearsigned" / armored) PGP. */
	textBody?: string;
}

const PGP_MESSAGE_HEADER = '-----BEGIN PGP MESSAGE-----';
const PGP_MESSAGE_FOOTER = '-----END PGP MESSAGE-----';
const PGP_SIGNED_HEADER = '-----BEGIN PGP SIGNED MESSAGE-----';
const PGP_SIGNATURE_HEADER = '-----BEGIN PGP SIGNATURE-----';
const PGP_SIGNATURE_FOOTER = '-----END PGP SIGNATURE-----';
const PGP_SIGNATURE_TYPE = 'application/pgp-signature';

/**
 * Index of the first `marker` that OPENS a line of its own (RFC 4880 §6.2 puts
 * armor at column 0), searching from `fromIndex`; -1 when there is none.
 *
 * Anything before the marker on its line — overwhelmingly a reply quote prefix
 * (`>`, `>>`, `  > `) — means the armor belongs to a QUOTED message, not to this
 * one. A body that merely contains armor is not a signed body: reading a quoted
 * block as this message's own made a plaintext reply to signed mail verify the
 * quoted armor, fail, and render the warn-tone "signature invalid" badge.
 */
function indexOfArmorLine(body: string, marker: string, fromIndex = 0): number {
	for (let at = body.indexOf(marker, fromIndex); at >= 0; at = body.indexOf(marker, at + 1)) {
		// CRLF bodies are covered too: the '\r' sits before the '\n', not after.
		if (at === 0 || body[at - 1] === '\n') return at;
	}
	return -1;
}

/** Whether an armor block of `marker` opens a line of its own somewhere in `body`. */
function hasArmorLine(body: string, marker: string): boolean {
	return indexOfArmorLine(body, marker) >= 0;
}

/**
 * Whether `body` carries a structurally COMPLETE inline clearsigned block
 * (RFC 4880 §7): the signed-message armor opening a line, then the signature
 * armor's BEGIN and END after it, each likewise unquoted at a line start. All
 * three are required — a lone header is a mention (or a truncated quote), and
 * only a block with its signature can be verified at all.
 */
function hasClearsignedBlock(body: string): boolean {
	const start = indexOfArmorLine(body, PGP_SIGNED_HEADER);
	if (start < 0) return false;
	const sigAt = indexOfArmorLine(body, PGP_SIGNATURE_HEADER, start + PGP_SIGNED_HEADER.length);
	if (sigAt < 0) return false;
	return indexOfArmorLine(body, PGP_SIGNATURE_FOOTER, sigAt + PGP_SIGNATURE_HEADER.length) >= 0;
}

/** Classify a message's PGP/S-MIME structure. */
export function classifySecureMessage(input: SecureMessageInput): SecureMessageClass {
	const types = (input.attachments ?? []).map((a) => a.contentType.toLowerCase());
	const has = (needle: string) => types.some((t) => t.includes(needle));

	// RFC 3156 (PGP/MIME) parts.
	if (has('application/pgp-encrypted')) return 'pgp-encrypted';
	if (has(PGP_SIGNATURE_TYPE)) return 'pgp-signed';
	// S/MIME (PKCS#7) parts.
	if (has('pkcs7-signature') || has('x-pkcs7-signature')) return 'smime-signed';
	if (has('pkcs7-mime') || has('x-pkcs7-mime')) return 'smime-encrypted';

	// Inline ("armored") PGP in the body, not MIME-wrapped. Both gates demand
	// armor at an unquoted line start, so quoting a secure message in a reply
	// never makes the reply itself count as one.
	const body = input.textBody ?? '';
	if (hasClearsignedBlock(body)) return 'pgp-clearsigned';
	if (hasArmorLine(body, PGP_MESSAGE_HEADER)) return 'pgp-encrypted';

	return 'none';
}

/** Whether a class represents an encrypted (undecryptable-by-us) body. */
export function isEncryptedClass(c: SecureMessageClass): boolean {
	return c === 'pgp-encrypted' || c === 'smime-encrypted';
}

/**
 * Classify a RAW RFC 5322 message (headers + body) by feeding every MIME part
 * `Content-Type` it carries plus the whole raw text through
 * {@link classifySecureMessage}. This is the SERVER-SIDE twin of the reader's
 * attachment-based classification: ingest gates (`isSignedPgpMime`,
 * `isClearsigned`, and the sealed gate in `e2ee/inboundSeal.ts`) consume it so
 * the server's structural detection can never fork from the client badge's.
 */
export function classifyRawSecureMessage(raw: string): SecureMessageClass {
	const attachments = extractRawPartContentTypes(raw)
		.filter((contentType) => isCorroboratedRawPartType(contentType, raw))
		.map((contentType) => ({ contentType }));
	// The whole raw message doubles as the "body" so inline-armored blocks
	// (clearsigned text, armored ciphertext directly in the body) are detected.
	return classifySecureMessage({ attachments, textBody: raw });
}

/**
 * Whether a `Content-Type` scraped off the raw text is trustworthy as a real
 * MIME part header. The scrape cannot tell a part header from a body line that
 * merely READS like one (a quoted spec excerpt, a bug report), and the reader's
 * attachment list — the client twin's input — can never hold such a line. So a
 * detached-signature part only counts when the RFC 3156 §5 STRUCTURE that must
 * carry it is really there ({@link hasDetachedSignatureStructure}); otherwise a
 * plaintext body naming the content type would classify as signed and earn the
 * warn-tone "signature invalid" badge.
 *
 * The corroboration is structural rather than armor-based on purpose: the armor
 * of a detached signature part is subject to `Content-Transfer-Encoding` like
 * any other part body, so real signed mail that ships its `signature.asc`
 * base64- or quoted-printable-encoded carries NO literal armor line at all —
 * demanding one skipped those messages at the ingest gate and left them stuck
 * on the neutral "signed · not verified" badge.
 */
function isCorroboratedRawPartType(contentType: string, raw: string): boolean {
	if (!contentType.toLowerCase().includes(PGP_SIGNATURE_TYPE)) return true;
	return hasDetachedSignatureStructure(raw);
}

/**
 * Whether `raw` carries a real RFC 3156 §5 detached-signature structure: a
 * `multipart/signed` content-type sitting in a genuine MIME header POSITION,
 * and an `application/pgp-signature` part header inside the header block that
 * this very multipart's boundary delimiter opens.
 *
 * Header position is what makes this anti-spoof. A header block is either the
 * message's own (line 0) or the one a boundary delimiter of an
 * ALREADY-DECLARED boundary opens (RFC 2046 §5.1.1: `--boundary` at column 0,
 * transport padding aside) — part BODIES are skipped wholesale. So neither a
 * body that names the content type, nor one quoting (`> `) a signed message's
 * source, nor even one pasting a whole raw `multipart/signed` message inline
 * can reach a header position: the pasted structure's own `Content-Type` lines
 * are body text of the message that carries them.
 *
 * Deliberately cheap and line-anchored — `@owlat/shared` stays dependency-free,
 * so this never grows into a MIME parser. The byte-exact parse that
 * verification needs lives in `@owlat/mail-canon`'s rfc3156 module, behind this
 * gate.
 */
function hasDetachedSignatureStructure(raw: string): boolean {
	const lines = raw.replace(/\r\n/g, '\n').split('\n');
	// Boundaries may only be honoured once DECLARED by a header we already read.
	const boundaries = new Set<string>();
	const signedBoundaries = new Set<string>();

	let at = 0;
	// The boundary whose delimiter opened the block about to be read; null for
	// the message's own header block, which can never hold a signature part.
	let openedBy: string | null = null;
	while (at < lines.length) {
		const block = readHeaderBlock(lines, at);
		for (const value of contentTypeValues(block.headers)) {
			if (openedBy !== null && signedBoundaries.has(openedBy) && isPgpSignaturePart(value)) {
				return true;
			}
			const boundary = mimeParameter(value, 'boundary');
			if (!boundary) continue;
			boundaries.add(boundary);
			if (isPgpSignedMultipart(value)) signedBoundaries.add(boundary);
		}

		// Skip this part's body: the next header block starts after the next
		// delimiter line of a boundary declared above.
		at = block.end;
		openedBy = null;
		while (at < lines.length) {
			const boundary = delimiterBoundary(lines[at] ?? '', boundaries);
			at++;
			if (boundary !== null) {
				openedBy = boundary;
				break;
			}
		}
		if (openedBy === null) return false;
	}
	return false;
}

/**
 * Read one MIME header block starting at `from`: the unfolded header lines up
 * to the blank line that ends them (RFC 5322 §2.2.3 continuation lines are
 * joined onto their header), plus the index of the first body line.
 */
function readHeaderBlock(lines: string[], from: number): { headers: string[]; end: number } {
	const headers: string[] = [];
	let at = from;
	for (; at < lines.length; at++) {
		const line = lines[at] ?? '';
		if (line === '') return { headers, end: at + 1 };
		const last = headers.length - 1;
		if (last >= 0 && /^[ \t]/.test(line)) headers[last] += ` ${line.trim()}`;
		else headers.push(line);
	}
	return { headers, end: at };
}

/** The `Content-Type` values among a block's (already unfolded) header lines. */
function contentTypeValues(headers: string[]): string[] {
	const values: string[] = [];
	for (const header of headers) {
		const colon = header.indexOf(':');
		if (colon < 0) continue;
		if (header.slice(0, colon).trim().toLowerCase() !== 'content-type') continue;
		const value = header.slice(colon + 1).trim();
		if (value) values.push(value);
	}
	return values;
}

/** A (possibly quoted) MIME parameter value off a `Content-Type` value. */
function mimeParameter(value: string, name: string): string | undefined {
	const match = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(value);
	if (!match) return undefined;
	return (match[1] ?? match[2] ?? '').trim() || undefined;
}

/**
 * Whether a `Content-Type` value opens a PGP `multipart/signed` entity. RFC
 * 3156 §5 REQUIRES `protocol="application/pgp-signature"`; a missing parameter
 * is tolerated (mailers do omit it, and the part's own content-type is the real
 * evidence) but one naming a DIFFERENT protocol — S/MIME's pkcs7-signature —
 * is not.
 */
function isPgpSignedMultipart(value: string): boolean {
	if (!/^multipart\/signed\b/i.test(value)) return false;
	const protocol = mimeParameter(value, 'protocol');
	return protocol === undefined || protocol.toLowerCase() === PGP_SIGNATURE_TYPE;
}

/** Whether a `Content-Type` value declares the detached-signature part itself. */
function isPgpSignaturePart(value: string): boolean {
	return new RegExp(`^${PGP_SIGNATURE_TYPE}\\b`, 'i').test(value);
}

/**
 * The boundary a line delimits, when it is a delimiter line for one of the
 * `boundaries` declared so far — `--boundary` or the close-delimiter
 * `--boundary--`, at column 0, transport padding (WSP) aside (RFC 2046 §5.1.1).
 * Column 0 is what keeps a quoted (`> --b`) or indented copy out.
 */
function delimiterBoundary(line: string, boundaries: Set<string>): string | null {
	if (!line.startsWith('--')) return null;
	const rest = line.slice(2).replace(/[ \t\r]+$/, '');
	if (boundaries.has(rest)) return rest;
	const closing = rest.endsWith('--') ? rest.slice(0, -2) : null;
	return closing !== null && boundaries.has(closing) ? closing : null;
}

/**
 * Whether a raw inbound message is PGP/MIME `multipart/signed` (RFC 3156 §5) —
 * a detached-signature structure whose first part is the signed content. An
 * ENCRYPTED message is NOT signed-plaintext (the signature, if any, lives
 * inside the ciphertext and belongs to the sealed path).
 */
export function isSignedPgpMime(raw: string): boolean {
	return classifyRawSecureMessage(raw) === 'pgp-signed';
}

/**
 * Whether a raw inbound message carries an inline clearsigned body (RFC 4880
 * §7) — the `BEGIN PGP SIGNED MESSAGE` armor directly in the text.
 */
export function isClearsigned(raw: string): boolean {
	return classifyRawSecureMessage(raw) === 'pgp-clearsigned';
}

/**
 * Pull the `Content-Type` header value of every MIME part in a raw message (the
 * outer part plus any `Content-Type:` lines inside), lower-cased by the
 * consumer. Enough for the structural checks — we only need to know whether an
 * `application/pgp-encrypted` / `application/pgp-signature` part is present,
 * not to fully parse the tree. Folded continuation lines are joined so a
 * `protocol="..."` parameter on the next line still counts.
 */
function extractRawPartContentTypes(raw: string): string[] {
	const types: string[] = [];
	const normalized = raw.replace(/\r\n/g, '\n');
	const re = /^content-type:[ \t]*([^\n]*(?:\n[ \t][^\n]*)*)/gim;
	let match: RegExpExecArray | null;
	while ((match = re.exec(normalized)) !== null) {
		const value = (match[1] ?? '').replace(/\n[ \t]+/g, ' ').trim();
		if (value) types.push(value);
	}
	return types;
}

/**
 * Pull the inline ("armored") PGP MESSAGE block out of an encrypted body
 * (RFC 4880 §6.2 ASCII armor). Returns the full armored block including its
 * `-----BEGIN/END PGP MESSAGE-----` framing, with CRLF normalized to LF, so an
 * external OpenPGP tool can decrypt it. Returns null when the body holds no
 * armored block.
 *
 * This is the escape hatch for the inline-armored shape: the ciphertext lives
 * directly in the message body (no separate PGP/MIME part to download), so the
 * reader — which hides the unreadable body — would otherwise strand the user
 * with no way to copy or export the ciphertext.
 */
export function extractArmoredCiphertext(rawBody: string): string | null {
	const body = rawBody.replace(/\r\n/g, '\n');
	const start = body.indexOf(PGP_MESSAGE_HEADER);
	if (start < 0) return null;
	const footerAt = body.indexOf(PGP_MESSAGE_FOOTER, start);
	// Truncated armor (no footer) is still worth recovering — hand back from the
	// header to the end rather than dropping the only copy of the ciphertext.
	const end = footerAt >= 0 ? footerAt + PGP_MESSAGE_FOOTER.length : body.length;
	return body.slice(start, end).trim();
}

/**
 * Pull the human-readable cleartext out of an inline PGP SIGNED MESSAGE block,
 * undoing dash-escaping (RFC 4880 §7.1). Returns null when the body isn't a
 * clearsigned block. The signature itself is NOT verified.
 *
 * Anchored on the same unquoted-line-start scan as the classifier, so a body
 * that quotes a signed message ABOVE its own armor yields this message's block,
 * not the quoted one.
 */
export function extractClearsignedText(rawBody: string): string | null {
	const body = rawBody.replace(/\r\n/g, '\n'); // tolerate CRLF input
	const start = indexOfArmorLine(body, PGP_SIGNED_HEADER);
	if (start < 0) return null;
	const sigAt = indexOfArmorLine(body, PGP_SIGNATURE_HEADER, start);
	const headerEnd = body.indexOf('\n', start);
	if (headerEnd < 0) return null;

	// Skip the armor headers (Hash:, etc.) up to the first blank line.
	const afterHeaders = body.indexOf('\n\n', headerEnd);
	const bodyStart = afterHeaders >= 0 ? afterHeaders + 2 : headerEnd + 1;
	const bodyEnd = sigAt >= 0 ? sigAt : body.length;

	const raw = body.slice(bodyStart, bodyEnd);
	// Dash-unescape: a line beginning "- " had its leading char escaped.
	return raw
		.split('\n')
		.map((line) => (line.startsWith('- ') ? line.slice(2) : line))
		.join('\n')
		.replace(/\s+$/, '');
}

/**
 * The COMPLETE inline clearsign armor block (header through `END PGP
 * SIGNATURE`), CRLF-normalized to LF so an OpenPGP implementation can read it,
 * or null when the body carries none. The verifier consumes this; it shares the
 * classifier's unquoted-line-start anchoring so the block handed to
 * verification is always the same one {@link isClearsigned} gated on — never a
 * quoted block from a reply.
 */
export function extractClearsignedBlock(rawBody: string): string | null {
	const body = rawBody.replace(/\r\n/g, '\n');
	const start = indexOfArmorLine(body, PGP_SIGNED_HEADER);
	if (start < 0) return null;
	const footerAt = indexOfArmorLine(body, PGP_SIGNATURE_FOOTER, start);
	if (footerAt < 0) return null;
	return body.slice(start, footerAt + PGP_SIGNATURE_FOOTER.length);
}
