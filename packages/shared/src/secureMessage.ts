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
	if (has('application/pgp-signature')) return 'pgp-signed';
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
 * detached-signature part only counts when the ASCII-armored signature RFC 3156
 * §5 requires it to carry is actually present, unquoted, at a line start;
 * otherwise a plaintext body naming the content type would classify as signed
 * and earn the warn-tone "signature invalid" badge.
 */
function isCorroboratedRawPartType(contentType: string, raw: string): boolean {
	if (!contentType.toLowerCase().includes('application/pgp-signature')) return true;
	return hasArmorLine(raw, PGP_SIGNATURE_HEADER);
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
