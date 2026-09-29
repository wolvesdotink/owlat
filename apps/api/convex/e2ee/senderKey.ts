'use node';

/**
 * Sender-key resolution: the one TOFU ladder both inbound verifiers climb to
 * find the key a sender's signature is checked against. Sealed mail
 * (`e2ee/open.ts`) and signed-but-unencrypted mail
 * (`e2ee/verifyInboundSignature.ts`) differ only in how discovery runs, which
 * each caller states through `skipManifest`.
 *
 * Only `ctx.run*` calls and types live here, but `shouldRefetch` comes from
 * the `'use node'` discovery module, so this file is Node-runtime too and may
 * be imported only by other Node-runtime modules.
 */

import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { shouldRefetch } from './discovery';

/** How the sender's verification key resolved through the TOFU ladder. */
export type ResolvedSenderKey =
	| { status: 'found'; publicKeyArmored: string; keySource: 'pinned' | 'wkd' | 'manifest' }
	| { status: 'keyChanged' }
	| { status: 'notFound' };

/**
 * Resolve the armored PUBLIC key to verify a sender's signature against.
 *
 * A cached `trusted` pin with a non-empty key is used directly. On a cache
 * MISS (every first-contact sender) or an expired negative, the SSRF-guarded,
 * TTL-cached `discoverRecipientKey` runs ONCE and the freshly persisted pin is
 * re-read, so a legitimate first message can be verified instead of being
 * recorded UNVERIFIED for good.
 *
 * Fail-CLOSED throughout: a `keyChanged` conflict is NEVER discovered past or
 * silently re-pinned (it stays UNVERIFIED until an admin resolves it), a fresh
 * negative is answered from cache, and any discovery error resolves to
 * `notFound` rather than a false claim.
 *
 * `skipManifest` runs discovery WKD-first; see `discoverKeyForAddress` in
 * `e2ee/discovery.ts` for when the manifest step is worth its fetch.
 */
export async function resolveSenderVerificationKey(
	ctx: ActionCtx,
	from: string,
	opts: { skipManifest: boolean }
): Promise<ResolvedSenderKey> {
	const cached = await ctx.runQuery(internal.e2ee.recipientKeys.getCached, { address: from });
	if (cached && cached.outcome === 'trusted' && cached.pinnedPublicKeyArmored) {
		return {
			status: 'found',
			publicKeyArmored: cached.pinnedPublicKeyArmored,
			keySource: 'pinned',
		};
	}
	// A conflicting pin must stay UNVERIFIED until an admin resolves it.
	if (cached && cached.outcome === 'keyChanged') return { status: 'keyChanged' };
	// A fresh negative (notFound within TTL) would only be answered from cache,
	// so skip the Node-action hop entirely.
	if (cached && !shouldRefetch(cached, Date.now())) return { status: 'notFound' };

	// First contact (or an expired negative cache): discover once, then re-read.
	// Discovery persists the TOFU pin (and is a flag-gated no-op when Sealed
	// Mail is off).
	try {
		await ctx.runAction(internal.e2ee.discovery.discoverRecipientKey, {
			address: from,
			skipManifest: opts.skipManifest,
		});
	} catch {
		return { status: 'notFound' };
	}
	const rediscovered = await ctx.runQuery(internal.e2ee.recipientKeys.getCached, { address: from });
	if (rediscovered && rediscovered.outcome === 'trusted' && rediscovered.pinnedPublicKeyArmored) {
		return {
			status: 'found',
			publicKeyArmored: rediscovered.pinnedPublicKeyArmored,
			keySource: rediscovered.source ?? 'wkd',
		};
	}
	if (rediscovered && rediscovered.outcome === 'keyChanged') return { status: 'keyChanged' };
	return { status: 'notFound' };
}
