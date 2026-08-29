/**
 * Integration-import credential sealing (plan L9).
 *
 * The walker fans one import out across many `ctx.scheduler.runAfter` hops, and
 * each hop's arguments are persisted in the `_scheduled_functions` system table
 * until the hop runs. Threading a live Mailchimp / Stripe API key through those
 * args in plaintext leaves the third-party credential sitting at rest in that
 * table for the whole run. This module seals the credential so the scheduled
 * args carry ciphertext: the walker unseals it in memory only for the one
 * outbound HTTP call, and re-schedules the next hop with the sealed value
 * untouched.
 *
 * RUNTIME: Web Crypto (`crypto.subtle`) only — no `node:crypto` — so it runs in
 * the Convex V8 mutation (`startIntegrationImport`) that seals and the V8 action
 * (`processIntegrationPage`) that opens, and under vitest. This mirrors
 * `lib/atRestBodies.ts`; `lib/credentialCrypto.ts` is `'use node'` and therefore
 * unusable here.
 *
 * KEY: HKDF-SHA256 over `INSTANCE_SECRET` under a DISTINCT, version-pinned
 * salt + info label, domain-separating this key from every other INSTANCE_SECRET
 * consumer (at-rest bodies, external-mail creds, the E2EE key vault).
 *
 * TOLERANT FALLBACK: with no `INSTANCE_SECRET` configured, `sealImportCredential`
 * returns the plaintext verbatim (behaviour is then exactly as before this
 * change — no worse), and `openImportCredential` returns any non-envelope value
 * verbatim. A real deployment sets `INSTANCE_SECRET`, so credentials seal.
 */

import { getOptional } from '../lib/env';

const ENVELOPE_PREFIX = 'impcred';
/** Envelope format version — bump + re-seal on any cipher change. */
const ENVELOPE_VERSION = 1;
/** HKDF salt — pinned alongside the info label; changing either is a key change. */
const HKDF_SALT = 'owlat:integration-import:cred:salt:v1';
/** HKDF info — the per-use domain-separation label for this key. */
const HKDF_INFO = 'owlat:integration-import:cred:v1';
const IV_BYTES = 12; // AES-GCM 96-bit nonce
const GCM_TAG_BYTES = 16; // AES-GCM 128-bit auth tag — the minimum ciphertext length

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

function tryFromBase64(value: string): Uint8Array<ArrayBuffer> | null {
	let binary: string;
	try {
		binary = atob(value);
	} catch {
		return null;
	}
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	if (toBase64(out) !== value) return null; // reject non-canonical base64
	return out;
}

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

interface ParsedEnvelope {
	iv: Uint8Array<ArrayBuffer>;
	ciphertext: Uint8Array<ArrayBuffer>;
}

/** STRICT, keyless parse: exactly `impcred:<version>:<base64 iv>:<base64 ct>`,
 * a known version, canonical base64, a 12-byte IV and a ciphertext of at least
 * the GCM tag length. Anything else is NOT our envelope (treated as plaintext). */
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

/** Is `stored` a sealed import credential? Keyless structural check. */
export function isSealedImportCredential(stored: string): boolean {
	return parseEnvelope(stored) !== null;
}

/**
 * Seal a credential for transport through scheduled-function args. An empty
 * value, or a deployment with no `INSTANCE_SECRET`, returns the input verbatim
 * (see the module header's tolerant-fallback note).
 */
export async function sealImportCredential(plaintext: string): Promise<string> {
	if (plaintext === '') return '';
	const secret = getOptional('INSTANCE_SECRET');
	if (!secret) return plaintext;
	const key = await deriveAesKey(secret);
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
 * Open a sealed credential. A value that is NOT a structurally valid envelope is
 * returned verbatim (an unsealed plaintext from a no-secret deployment). A sealed
 * value requires `INSTANCE_SECRET`; a mismatch / tamper throws (fail closed).
 */
export async function openImportCredential(stored: string): Promise<string> {
	const envelope = parseEnvelope(stored);
	if (envelope === null) return stored;
	const secret = getOptional('INSTANCE_SECRET');
	if (!secret) {
		throw new Error('Cannot open sealed import credential: INSTANCE_SECRET is not configured');
	}
	const key = await deriveAesKey(secret);
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: envelope.iv },
		key,
		envelope.ciphertext
	);
	return decoder.decode(plaintext);
}
