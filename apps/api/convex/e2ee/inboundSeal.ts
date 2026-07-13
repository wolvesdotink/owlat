/**
 * Inbound Sealed-Mail — the PURE decision + parsing core of decrypt-on-ingest
 * (Sealed Mail plan 2026-07-11, locked decision D3).
 *
 * NO `ctx`, NO db, NO network, NO `openpgp` — plain strings in, plain data out —
 * so the detection + protected-header restoration is fully unit-testable without
 * keys. The one thing this module can NOT do is the actual OpenPGP decrypt +
 * signature verify; that lives in the `'use node'` sibling `e2ee/open.ts`, which
 * consumes {@link isSealedPgpMime} to gate and {@link parseInnerMessage} to
 * restore the real headers/bodies from the decrypted inner MIME.
 *
 * It also owns the INBOUND encryption-record validator + type
 * ({@link inboundEncryptionInfoValidator} / {@link InboundEncryptionInfo}) so the
 * sealing vocabulary sits next to the TypeScript type it mirrors — the single
 * source of truth. Importing `convex/values` here keeps the module pure of
 * `ctx`/db/network. This is the INBOUND counterpart to the OUTBOUND
 * `mail/sealPolicy.ts:mailEncryptionInfoValidator`; the two never share a shape
 * (an inbound record describes what WE cryptographically checked on receipt; an
 * outbound record describes what WE sealed), so they live in separate fields.
 */

import { v } from 'convex/values';
import { classifySecureMessage, isEncryptedClass } from '@owlat/shared/secureMessage';
import { extractFirstPartByType } from '@owlat/shared/mailMime';

/**
 * The cipher-suite label recorded for an opened sealed message. PGP/MIME (RFC
 * 9580 profile) is the only sealing profile today (locked decision D1); the
 * outbound record calls the same thing `algorithm: 'pgp-mime'`.
 */
export const INBOUND_CIPHER_SUITE = 'pgp-mime';

/**
 * The honest inbound sealing record persisted on a delivered `mailMessages` row
 * (`mailMessages.inboundEncryptionInfo`) and mirrored as flags on
 * `inboundMessages`. A DISCRIMINATED UNION so the type itself enforces "honest
 * by construction":
 *   - `decrypted: true`  MUST carry a `signatureValid` boolean (a claim we
 *     actually made) plus the cipher suite; the signer fields are present ONLY
 *     when the signature verified against the pinned sender key.
 *   - `decrypted: false` is the "Encrypted — can't decrypt" path: sealed on the
 *     wire but we hold no usable key, so NO signature claim is representable.
 * Neither "decrypted with a signature but no suite" nor "undecryptable but
 * claiming a valid signature" can be constructed. Mirrored one-for-one by
 * {@link inboundEncryptionInfoValidator}.
 */
export type InboundEncryptionInfo =
	| {
			sealed: true;
			decrypted: true;
			cipherSuite: string;
			/** True ONLY when the body's signature verified against the pinned sender key. */
			signatureValid: boolean;
			/** Uppercase-hex fingerprint of the signing key — present only when verified. */
			signerFingerprint?: string;
			/** The sending instance (the sender address's domain) — present only when verified. */
			signerInstance?: string;
	  }
	| { sealed: true; decrypted: false };

/** Convex validator mirroring {@link InboundEncryptionInfo} exactly (kept in lockstep). */
export const inboundEncryptionInfoValidator = v.union(
	v.object({
		sealed: v.literal(true),
		decrypted: v.literal(true),
		cipherSuite: v.string(),
		signatureValid: v.boolean(),
		signerFingerprint: v.optional(v.string()),
		signerInstance: v.optional(v.string()),
	}),
	v.object({
		sealed: v.literal(true),
		decrypted: v.literal(false),
	})
);

/**
 * Whether a raw inbound message is a Sealed-Mail PGP/MIME (or inline-armored PGP)
 * ciphertext we should attempt to open. Reuses the existing structural detector
 * (`@owlat/shared/secureMessage`) so detection can never fork from the reader's
 * "Encrypted" badge classification. Signed-but-not-encrypted messages are NOT
 * sealed here (there is nothing to decrypt).
 */
export function isSealedPgpMime(raw: string): boolean {
	// The multipart/encrypted protocol part is the authoritative PGP/MIME marker;
	// classifySecureMessage reads it off the part content-types. Feed the whole
	// raw message as the "body" too so an inline-armored ciphertext (the PGP
	// MESSAGE block sitting directly in the body) is still detected.
	const attachments = extractPartContentTypes(raw).map((contentType) => ({ contentType }));
	return isEncryptedClass(classifySecureMessage({ attachments, textBody: raw }));
}

/**
 * Pull the `Content-Type` header value of every MIME part in a raw message (the
 * outer part plus any `Content-Type:` lines inside), lower-cased. Enough for the
 * structural PGP/MIME check — we only need to know whether an
 * `application/pgp-encrypted` part is present, not to fully parse the tree.
 */
function extractPartContentTypes(raw: string): string[] {
	const types: string[] = [];
	const normalized = raw.replace(/\r\n/g, '\n');
	// Match every `Content-Type:` header line (outer + each part), joining a single
	// folded continuation so `protocol="application/pgp-encrypted"` on the next
	// line still counts.
	const re = /^content-type:[ \t]*([^\n]*(?:\n[ \t][^\n]*)*)/gim;
	let match: RegExpExecArray | null;
	while ((match = re.exec(normalized)) !== null) {
		const value = (match[1] ?? '').replace(/\n[ \t]+/g, ' ').trim();
		if (value) types.push(value);
	}
	return types;
}

/** The real headers + bodies recovered from a decrypted inner MIME message. */
export interface RestoredMessage {
	/** The real `Subject` (protected header D4), or undefined when the inner has none. */
	subject?: string;
	/** The decrypted `text/plain` body, if any. */
	text?: string;
	/** The decrypted `text/html` body, if any. */
	html?: string;
}

/**
 * Restore the protected headers + bodies from a decrypted inner MIME message
 * (locked decision D4: the real Subject + body travel INSIDE the ciphertext).
 * Handles single-part `text/plain` / `text/html` and multipart bodies alike via
 * the shared MIME leaf extractor (which decodes transfer-encodings). Pure.
 */
export function parseInnerMessage(innerMime: string): RestoredMessage {
	const normalized = innerMime.replace(/\r\n/g, '\n');
	const blankAt = normalized.indexOf('\n\n');
	const headerBlock = blankAt >= 0 ? normalized.slice(0, blankAt) : normalized;

	const subject = extractHeader(headerBlock, 'subject');
	const textPart = extractFirstPartByType(innerMime, 'text/plain');
	const htmlPart = extractFirstPartByType(innerMime, 'text/html');

	const result: RestoredMessage = {};
	if (subject !== undefined) result.subject = subject;
	if (textPart) result.text = decodeUtf8(textPart.bytes);
	if (htmlPart) result.html = decodeUtf8(htmlPart.bytes);
	return result;
}

/** Extract a single (unfolded) header value by lower-cased name from a header block. */
function extractHeader(headerBlock: string, name: string): string | undefined {
	const lines = headerBlock.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;
		const colon = line.indexOf(':');
		if (colon < 0) continue;
		if (line.slice(0, colon).trim().toLowerCase() !== name) continue;
		let value = line.slice(colon + 1);
		// Unfold continuation lines (leading whitespace).
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j];
			if (next !== undefined && /^[ \t]/.test(next)) value += ` ${next.trim()}`;
			else break;
		}
		return value.trim();
	}
	return undefined;
}

/** Decode part bytes as UTF-8 (best-effort; never throws on malformed input). */
export function decodeUtf8(bytes: Uint8Array): string {
	return new TextDecoder('utf-8').decode(bytes);
}
