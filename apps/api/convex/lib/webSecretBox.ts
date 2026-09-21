/**
 * webSecretBox — the AES-256-GCM + HKDF-SHA256 sealing core for the V8 runtime.
 *
 * This is the Web Crypto twin of `lib/credentialCrypto.ts`'s `createSecretBox`.
 * The two exist for one reason: `credentialCrypto` imports `node:crypto` and is
 * therefore `'use node'`, so it can only be reached from Convex Node actions.
 * Everything that seals from a V8 query/mutation — message bodies at rest, the
 * integration-import credential riding in `_scheduled_functions` args, the
 * plugin storage cursor — needs the same construction over `crypto.subtle`
 * instead. Before this module each of those three carried its own copy of the
 * HKDF import/derive dance, its own base64 helpers, and its own envelope
 * parser; this is the one copy they now share.
 *
 * RUNTIME: `crypto.subtle` only. Runs unchanged in the Convex V8 query/mutation
 * runtime, in Convex Node actions, and under Node/vitest (`globalThis.crypto`).
 * Never import `node:crypto` here — that would make every consumer node-only.
 *
 * DOMAIN SEPARATION: a box is built from a secret plus an explicit
 * {@link WebSecretBoxContext} (an HKDF salt + info pair). Two boxes with
 * different labels derive independent keys from the same `INSTANCE_SECRET`, so
 * a value sealed under one context can never open under another. Every consumer
 * MUST pick its own version-pinned pair, and changing a pair is a KDF change:
 * bump that consumer's envelope version and add a re-seal migration.
 *
 * WIRE FORMAT: the primitive itself emits nothing but `{ iv, ciphertext }` —
 * the ciphertext carries its 16-byte GCM tag appended, as Web Crypto returns
 * it. Framing (the `atrest:`/`impcred:` string envelopes, the `ARBLB1` blob
 * header, the cursor token) stays with each consumer, because those bytes are
 * already on disk. `fixtures/at-rest-sealers/` pins one envelope per consumer
 * so a change here cannot silently break them.
 */

import { bytesToBase64 } from './bytes';

/** AES-GCM 96-bit nonce — the size every consumer's envelope reserves for it. */
export const IV_BYTES = 12;
/** AES-GCM 128-bit auth tag — the minimum length of any ciphertext we produce. */
export const GCM_TAG_BYTES = 16;

const AES_KEY_BITS = 256;

const encoder = new TextEncoder();

/**
 * The domain-separation context for an HKDF-derived key. `salt` and `info` are
 * fed verbatim to HKDF-SHA256. Mirrors `credentialCrypto`'s `SecretBoxContext`
 * (declared separately so a V8 module never imports from the `'use node'` one).
 */
export interface WebSecretBoxContext {
	/** HKDF salt — the version-pinned separation label. */
	readonly salt: string;
	/** HKDF info — the per-use separation label. */
	readonly info: string;
}

/** A nonce and the ciphertext-with-appended-GCM-tag that Web Crypto returns. */
export interface WebSealedBytes {
	readonly iv: Uint8Array<ArrayBuffer>;
	readonly ciphertext: Uint8Array<ArrayBuffer>;
}

/**
 * A reusable AES-256-GCM + HKDF-SHA256 sealing primitive over Web Crypto.
 * `additionalData`, when given, is GCM additional authenticated data: it is not
 * encrypted but must match byte-for-byte on open, which is how the plugin
 * storage cursor binds a token to one tenant/plugin/page.
 */
export interface WebSecretBox {
	/** Derive the 256-bit AES-GCM key from the secret via HKDF-SHA256. */
	deriveKey(): Promise<CryptoKey>;
	/** Encrypt bytes under a fresh random nonce. */
	sealBytes(plaintext: Uint8Array, additionalData?: Uint8Array): Promise<WebSealedBytes>;
	/** Decrypt bytes. Throws on auth-tag mismatch (tamper / wrong key / wrong AAD). */
	openBytes(sealed: WebSealedBytes, additionalData?: Uint8Array): Promise<Uint8Array<ArrayBuffer>>;
}

/**
 * Build a {@link WebSecretBox} that derives its key from `secret` under the
 * given HKDF salt/info context. Pure crypto — reads no env — so callers own the
 * secret source and the domain-separation labels.
 */
export function createWebSecretBox(secret: string, context: WebSecretBoxContext): WebSecretBox {
	const deriveKey = async (): Promise<CryptoKey> => {
		const ikm = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
			'deriveKey',
		]);
		return crypto.subtle.deriveKey(
			{
				name: 'HKDF',
				hash: 'SHA-256',
				salt: encoder.encode(context.salt),
				info: encoder.encode(context.info),
			},
			ikm,
			{ name: 'AES-GCM', length: AES_KEY_BITS },
			false,
			['encrypt', 'decrypt']
		);
	};

	return {
		deriveKey,
		async sealBytes(plaintext, additionalData) {
			const key = await deriveKey();
			const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
			const ciphertext = new Uint8Array(
				await crypto.subtle.encrypt(
					additionalData === undefined
						? { name: 'AES-GCM', iv }
						: { name: 'AES-GCM', iv, additionalData: additionalData as BufferSource },
					key,
					plaintext as BufferSource
				)
			);
			return { iv, ciphertext };
		},
		async openBytes(sealed, additionalData) {
			const key = await deriveKey();
			const plaintext = await crypto.subtle.decrypt(
				additionalData === undefined
					? { name: 'AES-GCM', iv: sealed.iv }
					: { name: 'AES-GCM', iv: sealed.iv, additionalData: additionalData as BufferSource },
				key,
				sealed.ciphertext
			);
			return new Uint8Array(plaintext);
		},
	};
}

/**
 * Standard PADDED base64. The consumers that use it store the result inside a
 * colon-delimited envelope in the database, never in a URL, so `+`/`/`/`=` are
 * safe and padding keeps `atob` round-tripping identically across the V8, edge
 * and Node runtimes.
 */
export function toBase64(bytes: Uint8Array): string {
	return bytesToBase64(bytes);
}

/**
 * Decode padded base64, or `null` on any malformed input — so a caller can
 * reject a non-envelope string without a `try/catch` at each site.
 * NON-CANONICAL INPUT IS REJECTED (whitespace, wrong padding) by re-encoding
 * and comparing: that is what stops an attacker-controlled plaintext from being
 * mistaken for a sealed envelope on a technicality.
 */
export function tryFromBase64(value: string): Uint8Array<ArrayBuffer> | null {
	let binary: string;
	try {
		binary = atob(value);
	} catch {
		return null;
	}
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return toBase64(out) === value ? out : null;
}

/**
 * Frame a sealed value as `<prefix>:<version>:<base64 iv>:<base64 ciphertext>`
 * — the envelope shape shared by at-rest bodies (`atrest:`) and integration
 * import credentials (`impcred:`).
 */
export function formatTextEnvelope(
	prefix: string,
	version: number,
	sealed: WebSealedBytes
): string {
	return `${prefix}:${version}:${toBase64(sealed.iv)}:${toBase64(sealed.ciphertext)}`;
}

/**
 * The STRICT, KEYLESS inverse of {@link formatTextEnvelope}: `null` unless
 * `stored` is exactly four colon-delimited parts with the expected prefix, the
 * expected version, canonical base64 in both segments, a 12-byte IV, and a
 * ciphertext at least as long as the GCM tag.
 *
 * Strictness is the security property, not a nicety. The values these envelopes
 * live alongside are attacker-controlled (a message body can literally start
 * with `atrest:`), and a `null` here means "treat as legacy plaintext". A loose
 * prefix test would let a crafted plaintext be routed into the decrypt path.
 */
export function parseTextEnvelope(
	prefix: string,
	version: number,
	stored: string
): WebSealedBytes | null {
	if (!stored.startsWith(`${prefix}:`)) return null;
	const parts = stored.split(':');
	if (parts.length !== 4) return null;
	if (Number(parts[1]) !== version) return null;
	const iv = tryFromBase64(parts[2] ?? '');
	if (iv === null || iv.length !== IV_BYTES) return null;
	const ciphertext = tryFromBase64(parts[3] ?? '');
	if (ciphertext === null || ciphertext.length < GCM_TAG_BYTES) return null;
	return { iv, ciphertext };
}
