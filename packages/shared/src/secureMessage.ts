/**
 * PGP / S-MIME message structure detection (RFC 3156 / S-MIME) for Postbox.
 *
 * This is DETECTION + honest disclosure only — it deliberately makes no
 * cryptographic claim. Owlat does not (yet) verify signatures or decrypt
 * bodies, so the reader shows an accurate "encrypted" / "signed (not verified)"
 * badge rather than a misleading green check. Cryptographic verification +
 * decryption need a key-management/trust design (keyring, WKD, TOFU) and are a
 * deliberate follow-up; this slice lays the structural foundation.
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
