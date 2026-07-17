/**
 * Host enforcement of a plugin import provider's inbound signature-verification
 * contract. The host recomputes the declared HMAC over the raw request body
 * with the secret named by the contract and compares it to the caller-supplied
 * header value in constant time.
 *
 * Fails closed:
 *   - secret unset/empty     → 503 (retryable once the operator configures it)
 *   - header missing/empty   → 401
 *   - signature mismatch     → 401
 *
 * A passing check proves ORIGIN ONLY — that the caller holds the shared secret.
 * It is NOT replay-resistant: the signed payload is the raw body alone (no
 * timestamp, tolerance, or nonce), so a captured request verifies forever.
 * Nothing calls this yet; the future piece that wires the inbound HTTP surface
 * must layer replay defense (a signed timestamp with a bounded tolerance and/or
 * a nonce) on top of this verification before any endpoint accepts
 * plugin-sourced traffic. See `PluginInboundSignatureContract` in
 * `@owlat/plugin-kit`.
 *
 * Uses Web Crypto so this module stays V8-isolate-safe (no 'use node').
 */

import type { PluginInboundSignatureContract } from '@owlat/plugin-kit';
import { getPluginSecret } from '../lib/env';
import { bytesToBase64, bytesToHex, constantTimeEqual } from '../webhooks/security';

export type InboundSignatureResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly status: 401 | 503; readonly reason: string };

const HASH_BY_ALGORITHM = {
	'hmac-sha256': 'SHA-256',
	'hmac-sha1': 'SHA-1',
} as const;

async function computeSignature(
	contract: PluginInboundSignatureContract,
	secret: string,
	rawBody: string
): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: HASH_BY_ALGORITHM[contract.algorithm] },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
	return contract.encoding === 'hex' ? bytesToHex(signature) : bytesToBase64(signature);
}

/**
 * Verify a plugin-sourced inbound request against its declared contract. The
 * secret is read from the environment variable the contract names; a plugin can
 * never disable this check.
 */
export async function verifyPluginInboundSignature(
	contract: PluginInboundSignatureContract,
	rawBody: string,
	providedSignature: string | null | undefined
): Promise<InboundSignatureResult> {
	const secret = getPluginSecret(contract.secretEnvVar);
	if (secret === undefined) {
		return {
			ok: false,
			status: 503,
			reason: `Inbound signature is not configured (missing ${contract.secretEnvVar})`,
		};
	}
	if (providedSignature === null || providedSignature === undefined || providedSignature === '') {
		return { ok: false, status: 401, reason: 'Missing inbound signature' };
	}
	const expected = await computeSignature(contract, secret, rawBody);
	if (!constantTimeEqual(providedSignature, expected)) {
		return { ok: false, status: 401, reason: 'Inbound signature mismatch' };
	}
	return { ok: true };
}
