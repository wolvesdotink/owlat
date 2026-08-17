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

	// Inline ("armored") PGP in the body, not MIME-wrapped.
	const body = input.textBody ?? '';
	if (body.includes(PGP_SIGNED_HEADER)) return 'pgp-clearsigned';
	if (body.includes(PGP_MESSAGE_HEADER)) return 'pgp-encrypted';

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
	const attachments = extractRawPartContentTypes(raw).map((contentType) => ({ contentType }));
	// The whole raw message doubles as the "body" so inline-armored blocks
	// (clearsigned text, armored ciphertext directly in the body) are detected.
	return classifySecureMessage({ attachments, textBody: raw });
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
 */
export function extractClearsignedText(rawBody: string): string | null {
	const body = rawBody.replace(/\r\n/g, '\n'); // tolerate CRLF input
	const start = body.indexOf(PGP_SIGNED_HEADER);
	if (start < 0) return null;
	const sigAt = body.indexOf(PGP_SIGNATURE_HEADER, start);
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
