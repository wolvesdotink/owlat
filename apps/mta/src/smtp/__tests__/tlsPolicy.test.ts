/**
 * Unit matrix for the pure outbound TLS policy resolver (T1 — RFC 7435/8461/9325).
 *
 * Covers the full 3×3 of local mode (opportunistic / require / require-verified)
 * × MTA-STS state (none / testing / enforce), asserting both the resolved
 * requireTLS/rejectUnauthorized floor (strictest-wins) and the human reason
 * string. The `opportunistic` + `none` cell is the historic default and MUST
 * resolve to no TLS demand so today's behaviour is unchanged.
 */
import { describe, it, expect } from 'vitest';
import {
	isOutboundTlsMode,
	OUTBOUND_TLS_MODES,
	resolveTlsRequirements,
	type OutboundTlsMode,
	type StsPolicyMode,
} from '../tlsPolicy.js';

type Cell = {
	localMode: OutboundTlsMode;
	policyMode: StsPolicyMode;
	requireTLS: boolean;
	rejectUnauthorized: boolean;
};

// The authoritative strictest-wins truth table (3 modes × 3 STS states).
const MATRIX: Cell[] = [
	// opportunistic: never demands TLS on its own; only enforce lifts the floor.
	{ localMode: 'opportunistic', policyMode: 'none', requireTLS: false, rejectUnauthorized: false },
	{
		localMode: 'opportunistic',
		policyMode: 'testing',
		requireTLS: false,
		rejectUnauthorized: false,
	},
	{ localMode: 'opportunistic', policyMode: 'enforce', requireTLS: true, rejectUnauthorized: true },
	// require: TLS required, cert not verified — unless enforce adds verification.
	{ localMode: 'require', policyMode: 'none', requireTLS: true, rejectUnauthorized: false },
	{ localMode: 'require', policyMode: 'testing', requireTLS: true, rejectUnauthorized: false },
	{ localMode: 'require', policyMode: 'enforce', requireTLS: true, rejectUnauthorized: true },
	// require-verified: always TLS + verification, regardless of STS state.
	{ localMode: 'require-verified', policyMode: 'none', requireTLS: true, rejectUnauthorized: true },
	{
		localMode: 'require-verified',
		policyMode: 'testing',
		requireTLS: true,
		rejectUnauthorized: true,
	},
	{
		localMode: 'require-verified',
		policyMode: 'enforce',
		requireTLS: true,
		rejectUnauthorized: true,
	},
];

describe('resolveTlsRequirements — 3×3 mode × STS-state matrix', () => {
	it.each(MATRIX)(
		'local=$localMode sts=$policyMode → requireTLS=$requireTLS verify=$rejectUnauthorized',
		({ localMode, policyMode, requireTLS, rejectUnauthorized }) => {
			const result = resolveTlsRequirements({
				localMode,
				stsPolicy: { policyMode },
				daneResult: null,
			});
			expect(result.requireTLS).toBe(requireTLS);
			expect(result.rejectUnauthorized).toBe(rejectUnauthorized);
		}
	);

	it('the default (opportunistic + no policy) demands nothing — byte-identical to historic behaviour', () => {
		const result = resolveTlsRequirements({
			localMode: 'opportunistic',
			stsPolicy: { policyMode: 'none' },
			daneResult: null,
		});
		expect(result).toEqual({
			requireTLS: false,
			rejectUnauthorized: false,
			daneRequired: false,
			reason:
				'local policy opportunistic; no MTA-STS policy → requireTLS=false, verify=false (strictest-wins)',
		});
	});
});

describe('resolveTlsRequirements — reason strings', () => {
	it.each(MATRIX)(
		'local=$localMode sts=$policyMode reason names both drivers and the resolved floor',
		({ localMode, policyMode, requireTLS, rejectUnauthorized }) => {
			const { reason } = resolveTlsRequirements({
				localMode,
				stsPolicy: { policyMode },
				daneResult: null,
			});
			// Names the local mode driver.
			expect(reason).toContain(localMode);
			// Names the STS state driver.
			if (policyMode === 'enforce') expect(reason).toContain('MTA-STS enforce');
			if (policyMode === 'testing') expect(reason).toContain('MTA-STS testing');
			if (policyMode === 'none') expect(reason).toContain('no MTA-STS policy');
			// States the resolved floor and the strictest-wins semantics.
			expect(reason).toContain(`requireTLS=${requireTLS}`);
			expect(reason).toContain(`verify=${rejectUnauthorized}`);
			expect(reason).toContain('strictest-wins');
		}
	);

	it('enforce reason spells out that a verified handshake is required', () => {
		const { reason } = resolveTlsRequirements({
			localMode: 'opportunistic',
			stsPolicy: { policyMode: 'enforce' },
			daneResult: null,
		});
		expect(reason).toBe(
			'local policy opportunistic; MTA-STS enforce (verified TLS required) → requireTLS=true, verify=true (strictest-wins)'
		);
	});
});

describe('resolveTlsRequirements — DANE precedence (T3, RFC 7672 §2)', () => {
	it('a usable DANE result raises the TLS floor and sets daneRequired', () => {
		const result = resolveTlsRequirements({
			localMode: 'opportunistic',
			stsPolicy: { policyMode: 'none' },
			daneResult: { usable: true },
		});
		expect(result.requireTLS).toBe(true);
		expect(result.daneRequired).toBe(true);
		expect(result.reason).toContain('DANE TLSA authenticated');
		expect(result.reason).toContain('supersedes MTA-STS');
	});

	it('DANE beats STS-none: opportunistic + none + DANE => require TLS', () => {
		const noDane = resolveTlsRequirements({
			localMode: 'opportunistic',
			stsPolicy: { policyMode: 'none' },
			daneResult: null,
		});
		const withDane = resolveTlsRequirements({
			localMode: 'opportunistic',
			stsPolicy: { policyMode: 'none' },
			daneResult: { usable: true },
		});
		expect(noDane.requireTLS).toBe(false);
		expect(withDane.requireTLS).toBe(true);
		expect(withDane.daneRequired).toBe(true);
	});

	it('DANE forces verified TLS even under opportunistic + no policy (checkServerIdentity needs a PKIX-authorized chain)', () => {
		const result = resolveTlsRequirements({
			localMode: 'opportunistic',
			stsPolicy: { policyMode: 'none' },
			daneResult: { usable: true },
		});
		// Node only invokes the DANE checkServerIdentity hook on a PKIX-authorized
		// chain, so a DANE send must verify the certificate (fail-closed) — the local
		// opportunistic floor cannot lower it back to unverified.
		expect(result.rejectUnauthorized).toBe(true);
		expect(result.requireTLS).toBe(true);
		expect(result.daneRequired).toBe(true);
	});

	it('DANE beats STS-testing: testing is report-only, DANE still mandates TLS', () => {
		const result = resolveTlsRequirements({
			localMode: 'opportunistic',
			stsPolicy: { policyMode: 'testing' },
			daneResult: { usable: true },
		});
		expect(result.requireTLS).toBe(true);
		expect(result.daneRequired).toBe(true);
	});

	it('DANE agrees with STS-enforce: both demand TLS; daneRequired flags the cert match', () => {
		const result = resolveTlsRequirements({
			localMode: 'opportunistic',
			stsPolicy: { policyMode: 'enforce' },
			daneResult: { usable: true },
		});
		expect(result.requireTLS).toBe(true);
		expect(result.rejectUnauthorized).toBe(true);
		expect(result.daneRequired).toBe(true);
	});

	it('a non-usable DANE result (no TLSA) leaves the STS/local floor untouched', () => {
		const result = resolveTlsRequirements({
			localMode: 'opportunistic',
			stsPolicy: { policyMode: 'none' },
			daneResult: { usable: false },
		});
		expect(result.requireTLS).toBe(false);
		expect(result.daneRequired).toBe(false);
		expect(result.reason).not.toContain('DANE TLSA authenticated');
	});
});

describe('isOutboundTlsMode', () => {
	it('accepts every declared mode', () => {
		for (const mode of OUTBOUND_TLS_MODES) {
			expect(isOutboundTlsMode(mode)).toBe(true);
		}
	});
	it('rejects an unknown or malformed value', () => {
		expect(isOutboundTlsMode('require_verified')).toBe(false);
		expect(isOutboundTlsMode('')).toBe(false);
		expect(isOutboundTlsMode('REQUIRE')).toBe(false);
	});
});
