/**
 * Outbound TLS policy resolver (RFC 7435 opportunistic, RFC 8461 MTA-STS,
 * RFC 8996/9325 minimum-version, RFC 7672 DANE).
 *
 * PURE module: given the local operator policy (`OUTBOUND_TLS_MODE`, optionally
 * overridden per recipient domain), the recipient's MTA-STS state, and (later)
 * a DANE/TLSA verification result, it derives the TLS demands the sender must
 * place on the STARTTLS handshake for one delivery attempt.
 *
 * Strictest-wins: each input contributes an independent floor and the resolved
 * requirement is the union (any source that demands TLS wins; any source that
 * demands certificate verification wins). This keeps the default
 * (`opportunistic` + no policy) byte-identical to the historic behaviour while
 * letting an operator raise the floor globally or per domain, and letting an
 * MTA-STS enforce policy raise it for a specific receiver — without either
 * silently lowering the other.
 */

import type { OutboundTlsMode } from '@owlat/shared';

export type { OutboundTlsMode } from '@owlat/shared';
export { OUTBOUND_TLS_MODES, isOutboundTlsMode } from '@owlat/shared';

/** The MTA-STS policy state that applies to the recipient domain. */
export type StsPolicyMode = 'enforce' | 'testing' | 'none';

/**
 * TLSA / DANE state for the target MX (RFC 7672). Supplied by the sender when
 * `DANE_ENABLED` and the recipient MX publishes a DNSSEC-authenticated TLSA
 * RRset; `null` when DANE is off or no usable TLSA exists (then the resolver
 * behaves exactly as it did before T3).
 */
export interface DaneTlsaResult {
	/**
	 * Whether the MX published at least one SMTP-usable (DANE-TA/DANE-EE), AD-trusted
	 * TLSA record. When true the sender MUST authenticate the MX certificate against
	 * that RRset — a require-TLS floor that supersedes MTA-STS (RFC 7672 §2).
	 */
	usable: boolean;
}

export interface ResolveTlsRequirementsInput {
	/** The effective local TLS mode (per-domain override, else the global env). */
	localMode: OutboundTlsMode;
	/** The recipient domain's MTA-STS policy state. */
	stsPolicy: { policyMode: StsPolicyMode };
	/** DANE/TLSA result — `null` when DANE is off or no usable TLSA exists. */
	daneResult: DaneTlsaResult | null;
}

export interface TlsRequirements {
	/** Whether the STARTTLS upgrade is mandatory (fail delivery if unavailable). */
	requireTLS: boolean;
	/** Whether the MX certificate must verify against the trust store (PKIX). */
	rejectUnauthorized: boolean;
	/**
	 * Whether the MX certificate must additionally be authenticated against a DANE
	 * TLSA RRset (RFC 7672). When true the sender attaches the TLSA match to the
	 * handshake; a non-matching certificate fails the delivery (no cleartext
	 * fallback).
	 */
	daneRequired: boolean;
	/** Human-readable explanation of why this floor was chosen (logged, tested). */
	reason: string;
}

interface Floor {
	requireTLS: boolean;
	rejectUnauthorized: boolean;
}

/** The TLS floor contributed by the local operator mode. */
const LOCAL_FLOOR: Record<OutboundTlsMode, Floor> = {
	opportunistic: { requireTLS: false, rejectUnauthorized: false },
	require: { requireTLS: true, rejectUnauthorized: false },
	'require-verified': { requireTLS: true, rejectUnauthorized: true },
};

/**
 * The TLS floor contributed by the recipient's MTA-STS state. `testing` is
 * report-only by spec (RFC 8461 §5.2) so it raises no floor here — the sender's
 * testing-mode probe records failures separately; only `enforce` demands
 * verified TLS.
 */
const STS_FLOOR: Record<StsPolicyMode, Floor> = {
	none: { requireTLS: false, rejectUnauthorized: false },
	testing: { requireTLS: false, rejectUnauthorized: false },
	enforce: { requireTLS: true, rejectUnauthorized: true },
};

const LOCAL_REASON: Record<OutboundTlsMode, string> = {
	opportunistic: 'local policy opportunistic',
	require: 'local policy require (TLS required)',
	'require-verified': 'local policy require-verified (TLS + certificate verification required)',
};

const STS_REASON: Record<StsPolicyMode, string> = {
	none: 'no MTA-STS policy',
	testing: 'MTA-STS testing (report-only)',
	enforce: 'MTA-STS enforce (verified TLS required)',
};

/**
 * Resolve the TLS requirements for one delivery attempt via strictest-wins over
 * the local mode, the recipient's MTA-STS state, and DANE.
 *
 * DANE precedence (RFC 7672 §2): a usable, DNSSEC-authenticated TLSA RRset
 * mandates authenticated TLS regardless of MTA-STS — so a usable DANE result
 * raises the TLS floor even when MTA-STS is absent or in testing mode, and
 * agrees with an MTA-STS enforce policy. It also forces `rejectUnauthorized`:
 * Node only invokes the DANE `checkServerIdentity` hook on a PKIX-authorized
 * chain, so the certificate must be verified for the TLSA match to even run — a
 * DANE send therefore requires PKIX verification ON (fail-closed).
 */
export function resolveTlsRequirements({
	localMode,
	stsPolicy,
	daneResult,
}: ResolveTlsRequirementsInput): TlsRequirements {
	const local = LOCAL_FLOOR[localMode];
	const sts = STS_FLOOR[stsPolicy.policyMode];
	const daneRequired = daneResult?.usable === true;

	const requireTLS = local.requireTLS || sts.requireTLS || daneRequired;
	const rejectUnauthorized = local.rejectUnauthorized || sts.rejectUnauthorized || daneRequired;

	const reason = daneRequired
		? `${LOCAL_REASON[localMode]}; ${STS_REASON[stsPolicy.policyMode]}; DANE TLSA authenticated (RFC 7672, supersedes MTA-STS) → requireTLS=${requireTLS}, verify=${rejectUnauthorized}, dane=true (strictest-wins)`
		: `${LOCAL_REASON[localMode]}; ${STS_REASON[stsPolicy.policyMode]} → requireTLS=${requireTLS}, verify=${rejectUnauthorized} (strictest-wins)`;

	return { requireTLS, rejectUnauthorized, daneRequired, reason };
}
