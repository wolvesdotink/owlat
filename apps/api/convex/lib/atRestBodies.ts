/**
 * atRestBodies — sealing for MESSAGE BODIES AT REST (Sealed Mail E8b).
 *
 * Every message body Owlat stores — inbound inline text/html, personal-mailbox
 * inline snippets and body blobs, the unified-messages `content` JSON, and
 * compose drafts — is sealed with a single instance-held data key so a database
 * or storage dump contains ciphertext, not plaintext. The only decrypt choke
 * point is `lib/messageBody.ts`: E8a routed all ~30 body readers through those
 * accessors, so E8b only had to teach the accessors to unseal (see the async
 * `open*` accessors there).
 *
 * KEY: HKDF-SHA256 over `INSTANCE_SECRET` with a fixed, version-pinned
 * salt + info label ("owlat:at-rest:bodies:v1"), domain-separating this key
 * from every other use of `INSTANCE_SECRET` (external-mail creds, MTA transport
 * secrets, the E2EE key vault). This is an INSTANCE data key, NOT a per-user or
 * per-recipient key — E8b protects data at rest on this one instance; the
 * instance-to-instance E2EE plane (E1–E5) is a separate, PGP/MIME layer.
 *
 * RUNTIME: Web Crypto (`crypto.subtle`) only — no `node:crypto`. Runs unchanged
 * in the Convex V8 query/mutation runtime, in Convex Node actions, and under
 * Node/vitest (`globalThis.crypto`). This is why the sealing lives here and not
 * in `lib/credentialCrypto.ts` (which is `'use node'` and therefore unusable
 * from the V8 body readers).
 *
 * ENVELOPE: an opaque, self-describing string
 *   `atrest:1:<base64url(iv)>:<base64url(ciphertext‖gcmTag)>`
 * The `atrest:` prefix + version let a reader tell a sealed value from a
 * legacy-plaintext one WITHOUT a key, which is what makes the migration
 * resumable: a half-migrated table is a mix of sealed and plaintext rows and
 * every reader tolerates both (`openAtRest` returns an unsealed value verbatim).
 *
 * DOCUMENTED EXCEPTIONS (bodies that stay plaintext-derived on purpose):
 *   - Full-text SEARCH indexes (`mailMessages.snippet`, the `searchableText`
 *     search fields) — Convex indexes plaintext; sealing them would break
 *     server-side search. They hold a snippet/keywords, never the full body.
 *   - VECTOR embeddings — derived from plaintext at ingest and stored as floats.
 *   - Export — `contacts/dataExport.ts` DECRYPTS on export so the owner's own
 *     GDPR data package is readable.
 * These exceptions are restated at each index definition and in the docs.
 */

const ENVELOPE_PREFIX = 'atrest';
/** Envelope format version. Bump + add a re-seal migration on any cipher change. */
const ENVELOPE_VERSION = 1;
/** HKDF info label — the version-pinned domain-separation context for this key. */
const HKDF_INFO = 'owlat:at-rest:bodies:v1';
/** HKDF salt — pinned alongside the info label; changing either is a key change. */
const HKDF_SALT = 'owlat:at-rest:bodies:salt:v1';
const IV_BYTES = 12; // AES-GCM 96-bit nonce

/**
 * Minimal secret source. Injected so the pure crypto core never reads env
 * directly — Convex functions pass `getRequired('INSTANCE_SECRET')`, tests pass
 * a fixture secret. Keeps this module free of `lib/env.ts` (and therefore usable
 * from a plain unit test without a Convex context).
 */
export type AtRestSecret = string;

function textEncoder(): TextEncoder {
	return new TextEncoder();
}

/** Standard padded base64. The envelope is colon-delimited and stored internally
 * (never placed in a URL), so `+`/`/`/`=` are safe and padding keeps `atob`
 * round-tripping identically across the V8, edge, and Node runtimes. */
function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/** Derive the 256-bit AES-GCM key from the instance secret via HKDF-SHA256. */
async function deriveAesKey(secret: AtRestSecret): Promise<CryptoKey> {
	const enc = textEncoder();
	const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, [
		'deriveKey',
	]);
	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: enc.encode(HKDF_SALT),
			info: enc.encode(HKDF_INFO),
		},
		ikm,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

/**
 * Is `stored` an at-rest-sealed value? A cheap, KEYLESS prefix check — this is
 * how a reader (and the migration) tells a sealed column from a legacy-plaintext
 * one. A `false` here means "treat as plaintext", never "fail".
 */
export function isSealedAtRest(stored: string): boolean {
	return stored.startsWith(`${ENVELOPE_PREFIX}:`);
}

/**
 * Seal a plaintext body into the versioned envelope string. The empty string is
 * returned verbatim (there is nothing to hide, and an empty inline field is a
 * common "no body" sentinel that readers compare against `''`). An
 * already-sealed value is returned unchanged so the migration is idempotent —
 * re-running it never double-seals.
 */
export async function sealAtRest(secret: AtRestSecret, plaintext: string): Promise<string> {
	if (plaintext === '') return '';
	if (isSealedAtRest(plaintext)) return plaintext;
	const key = await deriveAesKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
		key,
		textEncoder().encode(plaintext)
	);
	return `${ENVELOPE_PREFIX}:${ENVELOPE_VERSION}:${toBase64(iv)}:${toBase64(
		new Uint8Array(ciphertext)
	)}`;
}

/**
 * Open a stored body. A value that is NOT a sealed envelope is returned verbatim
 * — that is the mixed-tolerance contract that lets a half-migrated table stay
 * fully readable. A sealed envelope is decrypted; a malformed or unknown-version
 * envelope, or an auth-tag mismatch (tamper / wrong key), throws.
 */
export async function openAtRest(secret: AtRestSecret, stored: string): Promise<string> {
	if (stored === '' || !isSealedAtRest(stored)) return stored;
	const parts = stored.split(':');
	// prefix : version : iv : ciphertext
	if (parts.length !== 4) {
		throw new Error('atRestBodies: malformed sealed envelope');
	}
	const version = Number(parts[1]);
	if (version !== ENVELOPE_VERSION) {
		throw new Error(`atRestBodies: unsupported envelope version ${parts[1]}`);
	}
	const iv = fromBase64(parts[2] ?? '');
	const ciphertext = fromBase64(parts[3] ?? '');
	const key = await deriveAesKey(secret);
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
		key,
		ciphertext as unknown as ArrayBuffer
	);
	return new TextDecoder().decode(plaintext);
}

/** Open an optional stored body — `undefined`/`null` pass through untouched. */
export async function openAtRestOptional(
	secret: AtRestSecret,
	stored: string | undefined | null
): Promise<string | undefined> {
	if (stored === undefined || stored === null) return undefined;
	return openAtRest(secret, stored);
}

/** Seal an optional body — `undefined`/`null` pass through as `undefined`. */
export async function sealAtRestOptional(
	secret: AtRestSecret,
	plaintext: string | undefined | null
): Promise<string | undefined> {
	if (plaintext === undefined || plaintext === null) return undefined;
	return sealAtRest(secret, plaintext);
}
