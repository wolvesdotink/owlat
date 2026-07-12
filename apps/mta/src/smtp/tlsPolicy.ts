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
 * TLSA / DANE verification outcome for the target MX (RFC 7672). Populated by
 * T3; on this branch the resolver always receives `null` and never branches on
 * it (the parameter is plumbed through so T3 is a pure addition, not a signature
 * change).
 */
export interface DaneTlsaResult {
	/** Whether a usable, AD-trusted TLSA record set validated the MX certificate. */
	usable: boolean;
}

export interface ResolveTlsRequirementsInput {
	/** The effective local TLS mode (per-domain override, else the global env). */
	localMode: OutboundTlsMode;
	/** The recipient domain's MTA-STS policy state. */
	stsPolicy: { policyMode: StsPolicyMode };
	/** DANE/TLSA result — always `null` until T3 lands. */
	daneResult: DaneTlsaResult | null;
}

export interface TlsRequirements {
	/** Whether the STARTTLS upgrade is mandatory (fail delivery if unavailable). */
	requireTLS: boolean;
	/** Whether the MX certificate must verify against the trust store. */
	rejectUnauthorized: boolean;
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
 * the local mode and the recipient's MTA-STS state (DANE is accepted but not yet
 * consulted — see {@link DaneTlsaResult}).
 */
export function resolveTlsRequirements({
	localMode,
	stsPolicy,
	daneResult,
}: ResolveTlsRequirementsInput): TlsRequirements {
	// DANE is plumbed through for T3; it is always null on this branch and must
	// not influence the result yet. Referenced so the parameter is not flagged as
	// unused while T3 is pending.
	void daneResult;

	const local = LOCAL_FLOOR[localMode];
	const sts = STS_FLOOR[stsPolicy.policyMode];

	const requireTLS = local.requireTLS || sts.requireTLS;
	const rejectUnauthorized = local.rejectUnauthorized || sts.rejectUnauthorized;

	const reason = `${LOCAL_REASON[localMode]}; ${STS_REASON[stsPolicy.policyMode]} → requireTLS=${requireTLS}, verify=${rejectUnauthorized} (strictest-wins)`;

	return { requireTLS, rejectUnauthorized, reason };
}
