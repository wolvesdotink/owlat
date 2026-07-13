/**
 * Unit tests for the DANE (RFC 7672) send-time config parser (`loadDaneConfig`).
 *
 * DANE is three-valued (`DANE_MODE`: off/report/enforce, default `report`). The
 * two invariants under test:
 *
 *  - Mode parsing: the default is `report`; each declared mode round-trips; an
 *    unrecognised value fails the boot fast (no silent posture change).
 *  - Resolver gate: `report`/`enforce` both need a resolver to run, but a MISSING
 *    resolver is a graceful no-op (inert in every mode) rather than a boot error —
 *    a fresh install with no resolver behaves exactly as before. A resolver that
 *    IS set is still scheme-validated (the AD-bit channel must be unforgeable),
 *    even in `off` mode, so a mistake is caught at boot rather than on enable-day.
 */
import { describe, it, expect } from 'vitest';
import { loadDaneConfig, isDaneMode, DANE_MODES, type DaneMode } from '../daneConfig.js';

/** Build an `optionalEnv` helper over a fixed map (the shape `loadConfig` passes). */
function envFrom(map: Record<string, string>): (key: string, def: string) => string {
	return (key, def) => map[key] ?? def;
}

describe('loadDaneConfig — DANE_MODE parsing', () => {
	it('defaults to report when DANE_MODE is unset', () => {
		const cfg = loadDaneConfig(envFrom({ DANE_RESOLVER_URL: 'https://doh.example/dns-query' }));
		expect(cfg.daneMode).toBe('report');
	});

	it.each(DANE_MODES)('round-trips the declared mode %s', (mode) => {
		const cfg = loadDaneConfig(
			envFrom({ DANE_MODE: mode, DANE_RESOLVER_URL: 'https://doh.example/dns-query' })
		);
		expect(cfg.daneMode).toBe(mode);
	});

	it('throws on an unrecognised DANE_MODE (no silent fallback)', () => {
		expect(() =>
			loadDaneConfig(
				envFrom({ DANE_MODE: 'enforced', DANE_RESOLVER_URL: 'https://doh.example/dns-query' })
			)
		).toThrow(/DANE_MODE must be one of/);
	});
});

describe('loadDaneConfig — resolver gate (inert without a resolver)', () => {
	it.each(DANE_MODES)(
		'mode %s with no resolver is inert (no error, resolver undefined)',
		(mode) => {
			const cfg = loadDaneConfig(envFrom({ DANE_MODE: mode }));
			expect(cfg.daneMode).toBe(mode);
			expect(cfg.daneResolverUrl).toBeUndefined();
		}
	);

	it('report (the default) with no resolver does not throw — a fresh install stays inert', () => {
		expect(() => loadDaneConfig(envFrom({}))).not.toThrow();
		expect(loadDaneConfig(envFrom({}))).toEqual({ daneMode: 'report', daneResolverUrl: undefined });
	});
});

describe('loadDaneConfig — resolver scheme validation (when a resolver IS set)', () => {
	it('accepts an https resolver', () => {
		const cfg = loadDaneConfig(
			envFrom({ DANE_MODE: 'enforce', DANE_RESOLVER_URL: 'https://doh.example/dns-query' })
		);
		expect(cfg.daneResolverUrl).toBe('https://doh.example/dns-query');
	});

	it('accepts http only for a loopback resolver', () => {
		const cfg = loadDaneConfig(
			envFrom({ DANE_MODE: 'report', DANE_RESOLVER_URL: 'http://127.0.0.1:8443/dns-query' })
		);
		expect(cfg.daneResolverUrl).toBe('http://127.0.0.1:8443/dns-query');
	});

	it('rejects a non-https REMOTE resolver (the AD bit must be unforgeable)', () => {
		expect(() =>
			loadDaneConfig(
				envFrom({ DANE_MODE: 'enforce', DANE_RESOLVER_URL: 'http://doh.example/dns-query' })
			)
		).toThrow(/must use https:/);
	});

	it('rejects a malformed resolver URL', () => {
		expect(() =>
			loadDaneConfig(envFrom({ DANE_MODE: 'report', DANE_RESOLVER_URL: 'not a url' }))
		).toThrow(/must be a valid URL/);
	});

	it('validates the resolver scheme even in off mode (caught at boot, not enable-day)', () => {
		expect(() =>
			loadDaneConfig(
				envFrom({ DANE_MODE: 'off', DANE_RESOLVER_URL: 'http://doh.example/dns-query' })
			)
		).toThrow(/must use https:/);
	});
});

describe('isDaneMode', () => {
	it('accepts every declared mode', () => {
		for (const mode of DANE_MODES) expect(isDaneMode(mode)).toBe(true);
	});
	it('rejects unknown or malformed values', () => {
		expect(isDaneMode('enforced')).toBe(false);
		expect(isDaneMode('')).toBe(false);
		expect(isDaneMode('REPORT')).toBe(false);
		expect(isDaneMode('true')).toBe(false);
	});
	it('narrows to DaneMode', () => {
		const raw = 'enforce';
		if (isDaneMode(raw)) {
			const mode: DaneMode = raw;
			expect(mode).toBe('enforce');
		}
	});
});
