/**
 * DANE (RFC 7672) send-time configuration parsing and boot validation.
 *
 * Split out of `config.ts` to keep that module under the file-size gate and to
 * co-locate the DANE-specific boot checks: the three-valued `DANE_MODE`
 * (off/report/enforce), the validating DoH resolver URL, and the
 * plaintext-channel guard that protects the DNSSEC AD bit the whole design
 * trusts.
 */

/**
 * How DANE (RFC 7672) participates in outbound delivery, from least to most
 * strict. A discriminated three-valued mode rather than a boolean pair so a send
 * site branches on one value (no illegal "reporting but also enforcing" state):
 *
 *  - `off`: no TLSA lookups, no DANE effect — byte-identical to the historic
 *    (DANE-disabled) path.
 *  - `report`: perform the TLSA lookup and evaluate the MX certificate against
 *    it, EMIT the TLS-RPT result (success / `validation-failure` under the `tlsa`
 *    policy), but NEVER require TLS or bounce on a DANE outcome — delivery
 *    proceeds on the normal opportunistic/MTA-STS decision. Observability only.
 *  - `enforce`: a usable TLSA RRset mandates verified TLS authenticated against
 *    it (supersedes MTA-STS); a mismatch/failure defers the message (never
 *    cleartext) and records a `validation-failure`.
 */
export const DANE_MODES = ['off', 'report', 'enforce'] as const;
export type DaneMode = (typeof DANE_MODES)[number];

/** Narrow an arbitrary string to a {@link DaneMode}. */
export function isDaneMode(value: string): value is DaneMode {
	return (DANE_MODES as readonly string[]).includes(value);
}

/** Resolved DANE configuration (subset of `MtaConfig`). */
export interface DaneConfig {
	/**
	 * How DANE participates in outbound delivery. Default: `off`, matching locked
	 * decision D6: operators must opt in before Owlat performs TLSA lookups.
	 */
	daneMode: DaneMode;
	/**
	 * Validating DoH resolver endpoint. `report` and `enforce` both need it to run;
	 * when it is unset DANE is INERT in every mode (no lookups) — a fresh install
	 * with no resolver behaves exactly as before. When set, it is validated for
	 * scheme: the AD (DNSSEC Authenticated Data) bit is trusted, so this MUST be a
	 * channel an on-path attacker cannot forge over (https, or http only to a
	 * loopback resolver).
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
 * Parse and validate the DANE environment (`DANE_MODE`, `DANE_RESOLVER_URL`).
 *
 * Reads through the caller's `optionalEnv` helper (so all MTA env access stays
 * consistent). Defaults to `off` (see {@link DaneConfig.daneMode}).
 *
 *  - An unrecognised `DANE_MODE` → error (a typo like `enforced` must not silently
 *    fall back to a different posture).
 *  - No `DANE_RESOLVER_URL` → DANE is inert in every mode (no lookups). This is a
 *    graceful no-op, NOT an error: it keeps a fresh install (no resolver) on the
 *    exact historic path even though the default mode is `report`.
 *  - A malformed resolver URL → error (a typo'd endpoint would otherwise throw on
 *    the hot delivery path).
 *  - A non-`https:` REMOTE resolver → error. DANE trusts the resolver's AD bit, so
 *    a plaintext (`http:`) channel to a remote resolver would let an on-path
 *    attacker forge AD and strip DANE. `http:` is permitted only for a loopback
 *    resolver, where there is no on-path network to attack.
 */
export function loadDaneConfig(
	optionalEnv: (key: string, defaultValue: string) => string
): DaneConfig {
	const daneModeRaw = optionalEnv('DANE_MODE', 'off');
	if (!isDaneMode(daneModeRaw)) {
		throw new Error(
			`DANE_MODE must be one of: ${DANE_MODES.join(', ')} — got ${JSON.stringify(daneModeRaw)}`
		);
	}
	const daneMode: DaneMode = daneModeRaw;

	const daneResolverUrl = optionalEnv('DANE_RESOLVER_URL', '') || undefined;

	// No resolver → DANE is inert regardless of mode (graceful no-op, historic
	// path). We still validate a resolver URL when one is present, even in `off`
	// mode, so a scheme mistake is caught at boot rather than the day it is enabled.
	if (!daneResolverUrl) return { daneMode, daneResolverUrl: undefined };

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

	return { daneMode, daneResolverUrl };
}
