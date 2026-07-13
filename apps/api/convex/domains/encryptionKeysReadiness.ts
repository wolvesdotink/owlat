'use node';

/**
 * Sealed Mail "encryption keys published" delivery-readiness self-check.
 *
 * The delivery-readiness counterpart to the local-state `e2ee/keys.getReadiness`:
 * it fetches this instance's OWN `/.well-known` endpoints exactly as a remote
 * discoverer would (the signed manifest + the WKD policy + a real address key)
 * and reports whether the outside world can actually discover our Sealed Mail
 * keys. This pairs the key-publication check with the MTA-STS/TLS-RPT transport
 * self-checks the delivery-readiness surface already hosts (its sibling
 * `checkReceivingReverseDns` lives in `dnsVerification.ts`).
 *
 * Split out of `dnsVerification.ts` per CONVENTIONS.md (that file is at the LOC
 * ceiling); it stays on the domains/delivery-readiness surface next to its
 * MTA-STS/rDNS siblings.
 */

import { api, internal } from '../_generated/api';
import { authedAction } from '../lib/authedFunctions';
import { getOptional } from '../lib/env';
import { checkEncryptionKeysPublished } from '../e2ee/selfCheck';
import type { EncryptionKeysPublishedResult } from '../e2ee/selfCheck';

// Returns `null` when Sealed Mail is disabled or `SITE_URL` is unset (nothing to
// probe). Never throws: the pure `checkEncryptionKeysPublished` helper swallows
// every network/parse error, so a hiccup degrades to "not reachable" rather than
// breaking the readiness UI. Reads only PUBLIC endpoints — no private material.
//
// authz: admin gate is delegated to the `getReadiness` adminQuery
// (`organization:manage`) it calls first — parity with `checkReceivingReverseDns`.
export const checkEncryptionKeysReadiness = authedAction({
	args: {},
	handler: async (ctx): Promise<EncryptionKeysPublishedResult | null> => {
		// Admin floor + local publication truth (adminQuery: organization:manage).
		const local = await ctx.runQuery(api.e2ee.keys.getReadiness, {});
		// Publication follows the flag: nothing to self-verify when Sealed Mail is off.
		if (!(await ctx.runQuery(internal.e2ee.keys.isSealedMailEnabled, {}))) return null;
		const siteUrl = getOptional('SITE_URL');
		if (!siteUrl) return null;
		const directory = await ctx.runQuery(internal.e2ee.keys.getKeyDirectory, {});
		// Wrap the global `fetch` structurally so the deps type doesn't inherit the
		// global's extra members (mirrors `mtaStsVerify`'s `HttpDeps`).
		return checkEncryptionKeysPublished(
			{ siteUrl, localPublished: local.isPublished, directory },
			{ fetch: (url) => fetch(url) }
		);
	},
});
