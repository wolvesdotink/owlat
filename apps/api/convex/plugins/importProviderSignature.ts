/**
 * The ORIGIN-ONLY inbound signature verifier — the one an import provider's
 * contract declares, and the one nothing calls yet.
 *
 * It lives in its own module on purpose. `lint:convex-orphans` asks its
 * reachability question per MODULE, so leaving this beside the replay-bound
 * verifier that now gates `/webhooks/plugin/<pluginId>` would have made a wired
 * module vouch for an unwired export: the gate would see a consumer, and the
 * only remaining statement that this verifier gates no endpoint would be a
 * comment. Split out, it stays listed in `AWAITING_CALL_SITE` with its reason
 * until an import-provider inbound surface actually exists — and the day one is
 * written, the gate fails until the entry is removed.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT. A pass proves the caller holds the
 * shared secret. It is NOT replay-resistant: the signed payload is the raw body
 * alone (no timestamp, tolerance, or nonce), so a captured request verifies
 * forever. Any future inbound HTTP surface for import providers must therefore
 * either extend the contract to the replay-bound form
 * (`./inboundSignature.ts:verifyPluginReplayBoundSignature`) or pair this with
 * its own freshness and de-duplication — the webhook route needed both halves,
 * and neither was sufficient alone.
 */

import type { PluginInboundSignatureContract } from '@owlat/plugin-kit';
import {
	compareSignature,
	readSignatureSecret,
	type InboundSignatureResult,
} from './inboundSignature';

/**
 * Verify a plugin-sourced inbound request against its declared contract. The
 * secret is read from the environment variable the contract names; a plugin can
 * never disable this check.
 *
 * Fails closed, in order: secret unset/empty → 503 (retryable once the operator
 * configures it), header missing/empty → 401, mismatch → 401.
 */
export async function verifyPluginInboundSignature(
	contract: PluginInboundSignatureContract,
	rawBody: string,
	providedSignature: string | null | undefined
): Promise<InboundSignatureResult> {
	const configured = readSignatureSecret(contract);
	if (!configured.ok) return configured;
	return compareSignature(contract, configured.secret, rawBody, providedSignature);
}
