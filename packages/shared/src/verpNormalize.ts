/**
 * VERP configuration normalisation — the two PURE string helpers, in a module
 * that imports nothing.
 *
 * They live apart from `./verp` on purpose: `verp.ts` imports `node:crypto`,
 * and `./outboundIdentity` (which is re-exported from the package barrel, and
 * therefore reachable from the browser bundle) needs the key normalisation.
 * Importing it from `./verp` pulled `createHmac` into the web app's Rollup
 * graph and broke the build. Neither helper needs crypto, so neither belongs
 * on that side of the split.
 *
 * `verp.ts` re-exports both, so every existing import site keeps working and
 * there is still exactly ONE definition of each rule.
 */

/**
 * Normalise a configured VERP signing key: trim surrounding whitespace, treat
 * blank as unset.
 *
 * ONE definition, because the key is ONE secret with two independent readers
 * that must derive the SAME HMAC key from the SAME configured value. A quoted
 * `.env` value, a docker-compose `environment:` entry or a dashboard paste with
 * a trailing newline all carry surrounding whitespace; if one side trimmed it
 * and the other did not, the two sides would sign with different keys and every
 * relay-stamped token would fail verification at the MTA — failing safe (the
 * transport merely grades unsupported) but for an invisible reason.
 */
export function normalizeVerpKey(key: string | undefined): string | undefined {
	const normalized = key?.trim();
	return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
}

/**
 * Normalise a configured return-path domain: trim, drop a trailing root dot
 * (an absolute FQDN is legal in DNS config and illegal in an address), and
 * treat blank as unset. One definition — the MTA, the relay adapter and the
 * capability probe must all build the SAME address for the same configuration.
 */
export function normalizeReturnPathDomain(value: string | undefined): string | undefined {
	const normalized = value?.trim().replace(/\.$/, '');
	return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
}
