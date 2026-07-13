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
 *   `atrest:1:<base64(iv)>:<base64(ciphertext‖gcmTag)>`
 * The `atrest:` prefix + version let a reader tell a sealed value from a
 * legacy-plaintext one WITHOUT a key, which is what makes the migration
 * resumable: a half-migrated table is a mix of sealed and plaintext rows and
 * every reader tolerates both (`openAtRest` returns an unsealed value verbatim).
 *
 * PREFIX-COLLISION SAFETY (both directions): message bodies are fully
 * attacker-controlled, so a body can literally start with `atrest:`. Sealed
 * detection is therefore STRICT, not a bare prefix test: a value counts as
 * sealed only when it is a structurally valid envelope — exactly four
 * colon-delimited parts, a known numeric version, base64 that decodes, a
 * 12-byte IV and a ciphertext of at least the 16-byte GCM tag. A legacy
 * plaintext body that merely starts with `atrest:` fails this test and is read
 * verbatim (never decrypted, never a crash). In the other direction — a fresh
 * plaintext that happens to be shaped exactly like a sealed envelope — the seal
 * path's idempotency check is KEYED: it only treats a value as
 * already-sealed when the value actually decrypts under this instance's key, so
 * an envelope-shaped plaintext is never skipped-as-sealed; it is encrypted like
 * any other body. Net: no colliding plaintext can be misclassified in either
 * direction for data this instance has sealed.
 *
 * DOCUMENTED EXCEPTIONS (bodies that stay plaintext-derived on purpose):
 *   - Full-text SEARCH indexes (`mailMessages.snippet`, the `searchableText`
 *     search fields) — Convex indexes plaintext; sealing them would break
 *     server-side search. They hold a snippet/keywords, never the full body.
 *   - VECTOR embeddings — derived from plaintext at ingest and stored as floats.
 *   - Export — `contacts/dataExport.ts` DECRYPTS on export so the owner's own
 *     GDPR data package is readable.
 * These exceptions are restated at each index definition and in the docs
 * (`apps/docs/content/…/sealed-mail-at-rest.md`).
 */

const ENVELOPE_PREFIX = 'atrest';
/** Envelope format version. Bump + add a re-seal migration on any cipher change. */
const ENVELOPE_VERSION = 1;
/** HKDF info label — the version-pinned domain-separation context for this key. */
const HKDF_INFO = 'owlat:at-rest:bodies:v1';
/** HKDF salt — pinned alongside the info label; changing either is a key change. */
const HKDF_SALT = 'owlat:at-rest:bodies:salt:v1';
const IV_BYTES = 12; // AES-GCM 96-bit nonce
const GCM_TAG_BYTES = 16; // AES-GCM 128-bit auth tag — the minimum ciphertext length

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Standard padded base64. The envelope is colon-delimited and stored internally
 * (never placed in a URL), so `+`/`/`/`=` are safe and padding keeps `atob`
 * round-tripping identically across the V8, edge, and Node runtimes. */
function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

/** Decode padded base64. Returns `null` on any malformed input so callers can
 * reject a non-envelope string without a `try/catch` at each site. */
function tryFromBase64(value: string): Uint8Array<ArrayBuffer> | null {
	let binary: string;
	try {
		binary = atob(value);
	} catch {
		return null;
	}
	// Reject non-canonical base64 (whitespace, wrong padding) by round-tripping.
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	if (toBase64(out) !== value) return null;
	return out;
}

/** Derive the 256-bit AES-GCM key from the instance secret via HKDF-SHA256. */
async function deriveAesKey(secret: string): Promise<CryptoKey> {
	const ikm = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
		'deriveKey',
	]);
	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: encoder.encode(HKDF_SALT),
			info: encoder.encode(HKDF_INFO),
		},
		ikm,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

/** A structurally valid sealed envelope, parsed. */
interface ParsedEnvelope {
	iv: Uint8Array<ArrayBuffer>;
	ciphertext: Uint8Array<ArrayBuffer>;
}

/**
 * Parse `stored` into a sealed envelope, or `null` if it is NOT one. STRICT —
 * this is what lets an attacker-controlled plaintext beginning with `atrest:`
 * be told apart from a real envelope WITHOUT a key: it must be exactly
 * `atrest:<version>:<base64 iv>:<base64 ct>`, the version must parse to the
 * known version, both segments must be canonical base64, the IV must be
 * `IV_BYTES` long, and the ciphertext must be at least the GCM tag length.
 * Anything else is plaintext.
 */
function parseEnvelope(stored: string): ParsedEnvelope | null {
	if (!stored.startsWith(`${ENVELOPE_PREFIX}:`)) return null;
	const parts = stored.split(':');
	if (parts.length !== 4) return null;
	if (Number(parts[1]) !== ENVELOPE_VERSION) return null;
	const iv = tryFromBase64(parts[2] ?? '');
	if (iv === null || iv.length !== IV_BYTES) return null;
	const ciphertext = tryFromBase64(parts[3] ?? '');
	if (ciphertext === null || ciphertext.length < GCM_TAG_BYTES) return null;
	return { iv, ciphertext };
}

/**
 * Is `stored` an at-rest-sealed value? A cheap, KEYLESS but STRUCTURALLY STRICT
 * check — this is how a reader (and the migration) tells a sealed column from a
 * legacy-plaintext one. A `false` here means "treat as plaintext", never
 * "fail": a plaintext body that merely starts with `atrest:` returns `false`.
 */
export function isSealedAtRest(stored: string): boolean {
	return parseEnvelope(stored) !== null;
}

/**
 * Seal a plaintext body into the versioned envelope string. The empty string is
 * returned verbatim (there is nothing to hide, and an empty inline field is a
 * common "no body" sentinel that readers compare against `''`).
 *
 * IDEMPOTENCY IS KEYED: a re-run of the migration must not double-seal, so an
 * already-sealed value is returned unchanged — but "already sealed" is decided
 * by actually DECRYPTING it under this instance's key, not by its shape. That
 * closes the collision: an envelope-shaped *plaintext* fails the decrypt and is
 * encrypted like any other body (never skipped as if it were ciphertext), while
 * a genuine prior seal round-trips and is left untouched.
 */
export async function sealAtRest(secret: string, plaintext: string): Promise<string> {
	if (plaintext === '') return '';
	const key = await deriveAesKey(secret);
	const existing = parseEnvelope(plaintext);
	if (existing !== null) {
		try {
			await crypto.subtle.decrypt({ name: 'AES-GCM', iv: existing.iv }, key, existing.ciphertext);
			return plaintext; // genuinely our ciphertext — idempotent no-op
		} catch {
			// Envelope-shaped but not ours (attacker-crafted plaintext): fall through
			// and seal it for real, so it is protected and never misread as sealed.
		}
	}
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		encoder.encode(plaintext)
	);
	return `${ENVELOPE_PREFIX}:${ENVELOPE_VERSION}:${toBase64(iv)}:${toBase64(
		new Uint8Array(ciphertext)
	)}`;
}

/**
 * Open a stored body. A value that is NOT a structurally valid sealed envelope
 * is returned verbatim — that is the mixed-tolerance contract that lets a
 * half-migrated table stay fully readable, and it means an attacker-controlled
 * plaintext starting with `atrest:` is read as plaintext, never decrypted. A
 * sealed envelope is decrypted; an auth-tag mismatch (tamper / wrong key) throws.
 */
export async function openAtRest(secret: string, stored: string): Promise<string> {
	const envelope = parseEnvelope(stored);
	if (envelope === null) return stored;
	const key = await deriveAesKey(secret);
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: envelope.iv },
		key,
		envelope.ciphertext
	);
	return decoder.decode(plaintext);
}
