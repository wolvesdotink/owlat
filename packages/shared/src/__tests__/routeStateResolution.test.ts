import { describe, expect, it } from 'vitest';
import {
	DELIVERABILITY_STREAM_KEYS,
	DESTINATION_PROVIDER_KEYS,
	clampOwnShare,
	deliverabilityCellKey,
	isDeliverabilityStream,
	isFallbackActiveForShare,
	isRouteStateFallbackActive,
	parseDeliverabilityCellKey,
	resolveOwnShare,
	type DeliverabilityRouteShareState,
} from '../deliverabilityRouting';

describe('own-share resolution (D1)', () => {
	it('resolves the migration table exactly', () => {
		const cases: Array<{ state: DeliverabilityRouteShareState; share: number }> = [
			// Legacy rows: no ownShare, the boolean is the degenerate case.
			{ state: { isFallbackActive: false }, share: 1 },
			{ state: { isFallbackActive: true }, share: 0 },
			// Migrated rows: ownShare wins regardless of the stored boolean.
			{ state: { isFallbackActive: false, ownShare: 0.37 }, share: 0.37 },
			{ state: { isFallbackActive: true, ownShare: 0.37 }, share: 0.37 },
			{ state: { isFallbackActive: false, ownShare: 0 }, share: 0 },
			{ state: { isFallbackActive: true, ownShare: 0 }, share: 0 },
			{ state: { isFallbackActive: true, ownShare: 1 }, share: 1 },
			{ state: { isFallbackActive: false, ownShare: 1 }, share: 1 },
		];
		for (const { state, share } of cases) {
			expect(resolveOwnShare(state)).toBe(share);
			// The derived isFallbackActive view agrees with the share in every case.
			expect(isRouteStateFallbackActive(state)).toBe(share < 1);
			expect(isFallbackActiveForShare(resolveOwnShare(state))).toBe(share < 1);
		}
	});

	it('treats a legacy row as its stored boolean, byte for byte', () => {
		for (const isFallbackActive of [true, false]) {
			const legacy: DeliverabilityRouteShareState = { isFallbackActive };
			expect(isRouteStateFallbackActive(legacy)).toBe(isFallbackActive);
		}
	});

	it('treats a missing row as a fully own-MTA cell', () => {
		expect(resolveOwnShare(null)).toBe(1);
		expect(resolveOwnShare(undefined)).toBe(1);
		expect(isRouteStateFallbackActive(null)).toBe(false);
		expect(isRouteStateFallbackActive(undefined)).toBe(false);
	});

	it('treats an explicitly undefined ownShare as absent', () => {
		expect(resolveOwnShare({ isFallbackActive: true, ownShare: undefined })).toBe(0);
		expect(resolveOwnShare({ isFallbackActive: false, ownShare: undefined })).toBe(1);
	});

	it('clamps hostile and degenerate shares into [0,1]', () => {
		expect(clampOwnShare(-1)).toBe(0);
		expect(clampOwnShare(2)).toBe(1);
		expect(clampOwnShare(0.5)).toBe(0.5);
		// A NaN/Infinity share must never be laundered into a fallback decision:
		// it is not a measurement, so the un-migrated default (own MTA) applies.
		expect(clampOwnShare(Number.NaN)).toBe(1);
		expect(clampOwnShare(Number.POSITIVE_INFINITY)).toBe(1);
		expect(resolveOwnShare({ isFallbackActive: true, ownShare: Number.NaN })).toBe(0);
		expect(resolveOwnShare({ isFallbackActive: false, ownShare: Number.NaN })).toBe(1);
		expect(resolveOwnShare({ isFallbackActive: false, ownShare: -0.2 })).toBe(0);
		expect(resolveOwnShare({ isFallbackActive: false, ownShare: 4 })).toBe(1);
	});

	it('never reports fallback for a whole-cell own share', () => {
		expect(isFallbackActiveForShare(1)).toBe(false);
		expect(isFallbackActiveForShare(0.999)).toBe(true);
		expect(isFallbackActiveForShare(0)).toBe(true);
	});
});

describe('ramp cell keys (D6)', () => {
	it('round-trips every stream x destination provider cell', () => {
		for (const stream of DELIVERABILITY_STREAM_KEYS) {
			for (const provider of DESTINATION_PROVIDER_KEYS) {
				const key = deliverabilityCellKey(stream, provider);
				expect(key).toBe(`${stream}:${provider}`);
				expect(parseDeliverabilityCellKey(key)).toEqual({
					stream,
					destinationProvider: provider,
				});
			}
		}
	});

	it('rejects malformed cell keys', () => {
		expect(parseDeliverabilityCellKey('campaign')).toBeNull();
		expect(parseDeliverabilityCellKey('campaign:')).toBeNull();
		expect(parseDeliverabilityCellKey(':gmail')).toBeNull();
		expect(parseDeliverabilityCellKey('marketing:gmail')).toBeNull();
		expect(parseDeliverabilityCellKey('campaign:proton')).toBeNull();
		expect(parseDeliverabilityCellKey('')).toBeNull();
	});

	it('recognizes exactly the three streams', () => {
		expect(DELIVERABILITY_STREAM_KEYS).toEqual(['campaign', 'automation', 'transactional']);
		for (const stream of DELIVERABILITY_STREAM_KEYS)
			expect(isDeliverabilityStream(stream)).toBe(true);
		expect(isDeliverabilityStream('marketing')).toBe(false);
		expect(isDeliverabilityStream(undefined)).toBe(false);
		expect(isDeliverabilityStream(1)).toBe(false);
	});
});
