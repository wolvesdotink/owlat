/**
 * DANE (RFC 7672) send-time configuration parsing and boot validation.
 *
 * Split out of `config.ts` to keep that module under the file-size gate and to
 * co-locate the DANE-specific boot checks: the `DANE_ENABLED` flag (off by
 * default — locked decision D6), the mandatory validating DoH resolver URL, and
 * the plaintext-channel guard that protects the DNSSEC AD bit the whole design
 * trusts.
 */

/** Resolved DANE configuration (subset of `MtaConfig`). */
export interface DaneConfig {
	/** Whether DANE authentication is attempted at send time. Default: off (D6). */
	daneEnabled: boolean;
	/**
	 * Validating DoH resolver endpoint. Required — and validated for scheme — when
	 * `daneEnabled`. The AD (DNSSEC Authenticated Data) bit is trusted, so this
	 * MUST be a channel an on-path attacker cannot forge over (https, or http only
	 * to a loopback resolver).
	 */
	daneResolverUrl?: string;
}

/** True for a loopback host, where a plaintext (http:) DoH channel is acceptable. */
function isLoopbackHost(hostname: string): boolean {
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		// WHATWG URL renders an IPv6 host with brackets (`new URL(...).hostname`).
		hostname === '::1' ||
		hostname === '[::1]' ||
		hostname.endsWith('.localhost')
	);
}

/**
 * Parse and validate the DANE environment (`DANE_ENABLED`, `DANE_RESOLVER_URL`).
 *
 * Reads through the caller's `optionalEnv` helper (so all MTA env access stays
 * consistent) and fails the boot fast on any misconfiguration rather than
 * silently doing nothing — or, worse, implying protection it cannot provide:
 *
 *  - `DANE_ENABLED=true` with no resolver → error (DANE needs a validating
 *    resolver to be safe; booting without one would silently disable it).
 *  - a malformed resolver URL → error (a typo'd endpoint would otherwise throw
 *    on the hot delivery path).
 *  - a non-`https:` remote resolver → error. DANE trusts the resolver's AD bit,
 *    so a plaintext (`http:`) channel to a REMOTE resolver would let an on-path
 *    attacker forge AD and strip DANE (defeating D6). `http:` is permitted only
 *    for a loopback resolver, where there is no on-path network to attack.
 */
export function loadDaneConfig(
	optionalEnv: (key: string, defaultValue: string) => string
): DaneConfig {
	const daneEnabled = optionalEnv('DANE_ENABLED', 'false') === 'true';
	const daneResolverUrl = optionalEnv('DANE_RESOLVER_URL', '') || undefined;

	if (!daneEnabled) return { daneEnabled: false, daneResolverUrl };

	if (!daneResolverUrl) {
		throw new Error('DANE_ENABLED=true requires DANE_RESOLVER_URL (a validating DoH resolver).');
	}

	let url: URL;
	try {
		url = new URL(daneResolverUrl);
	} catch {
		throw new Error(
			'DANE_RESOLVER_URL must be a valid URL (a DoH resolver endpoint, e.g. https://127.0.0.1:8443/dns-query).'
		);
	}

	const httpsOk = url.protocol === 'https:';
	const loopbackHttpOk = url.protocol === 'http:' && isLoopbackHost(url.hostname);
	if (!httpsOk && !loopbackHttpOk) {
		throw new Error(
			`DANE_RESOLVER_URL must use https: (http: is allowed only for a loopback resolver) — got ${JSON.stringify(
				url.protocol
			)}. DANE trusts the resolver's DNSSEC AD bit, which a plaintext channel to a remote resolver cannot protect.`
		);
	}

	return { daneEnabled: true, daneResolverUrl };
}
