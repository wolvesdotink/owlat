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
 * (`processIntegrationPage`) that opens, and under vitest. The crypto core, the
 * base64 helpers and the envelope parser are shared with `lib/atRestBodies.ts`
 * via `lib/webSecretBox.ts`; `lib/credentialCrypto.ts`'s `createSecretBox` is
 * the same construction but `'use node'`, and therefore unusable here.
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
import {
	createWebSecretBox,
	formatTextEnvelope,
	parseTextEnvelope,
	type WebSealedBytes,
} from '../lib/webSecretBox';

const ENVELOPE_PREFIX = 'impcred';
/** Envelope format version — bump + re-seal on any cipher change. */
const ENVELOPE_VERSION = 1;
/** HKDF salt — pinned alongside the info label; changing either is a key change. */
const HKDF_SALT = 'owlat:integration-import:cred:salt:v1';
/** HKDF info — the per-use domain-separation label for this key. */
const HKDF_INFO = 'owlat:integration-import:cred:v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The import-credential box: the instance secret under the pinned context. */
function credentialBox(secret: string) {
	return createWebSecretBox(secret, { salt: HKDF_SALT, info: HKDF_INFO });
}

/** STRICT, keyless parse: exactly `impcred:<version>:<base64 iv>:<base64 ct>`,
 * a known version, canonical base64, a 12-byte IV and a ciphertext of at least
 * the GCM tag length. Anything else is NOT our envelope (treated as plaintext). */
function parseEnvelope(stored: string): WebSealedBytes | null {
	return parseTextEnvelope(ENVELOPE_PREFIX, ENVELOPE_VERSION, stored);
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
	const sealed = await credentialBox(secret).sealBytes(encoder.encode(plaintext));
	return formatTextEnvelope(ENVELOPE_PREFIX, ENVELOPE_VERSION, sealed);
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
	return decoder.decode(await credentialBox(secret).openBytes(envelope));
}
