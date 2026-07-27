import { describe, expect, it } from 'vitest';
import {
	DELIVERABILITY_STREAM_KEYS,
	DESTINATION_PROVIDER_KEYS,
	clampOwnShare,
	deliverabilityCellKey,
	isFallbackActiveForShare,
	isRouteStateFallbackActive,
	parseDeliverabilityCellKey,
	resolveOwnShare,
	type DeliverabilityRouteShareState,
} from '../deliverabilityRouting';
import { GOVERNED_MESSAGE_TYPES, isGovernedMessageType } from '../routingDispatch';

describe('own-share resolution (D1)', () => {
	it('resolves the migration table exactly', () => {
		const cases: Array<{
			state: DeliverabilityRouteShareState;
			share: number;
			fallback: boolean;
		}> = [
			// Legacy rows: no ownShare, the boolean is the degenerate case.
			{ state: { isFallbackActive: false }, share: 1, fallback: false },
			{ state: { isFallbackActive: true }, share: 0, fallback: true },
			// Migrated rows: ownShare wins the SHARE regardless of the boolean...
			{ state: { isFallbackActive: false, ownShare: 0.37 }, share: 0.37, fallback: true },
			{ state: { isFallbackActive: true, ownShare: 0.37 }, share: 0.37, fallback: true },
			{ state: { isFallbackActive: false, ownShare: 0 }, share: 0, fallback: true },
			{ state: { isFallbackActive: true, ownShare: 0 }, share: 0, fallback: true },
			// ...but the boolean is an independent INFRASTRUCTURE verdict written on
			// a different cadence, so it still engages the relay at ownShare = 1.
			{ state: { isFallbackActive: true, ownShare: 1 }, share: 1, fallback: true },
			{ state: { isFallbackActive: false, ownShare: 1 }, share: 1, fallback: false },
		];
		for (const { state, share, fallback } of cases) {
			expect(resolveOwnShare(state)).toBe(share);
			expect(isRouteStateFallbackActive(state)).toBe(fallback);
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

	it('clamps hostile and degenerate shares into [0,1], failing CLOSED', () => {
		expect(clampOwnShare(-1)).toBe(0);
		expect(clampOwnShare(2)).toBe(1);
		expect(clampOwnShare(0.5)).toBe(0.5);
		// Degenerate evidence must never be laundered into "the own MTA carries
		// 100% of this cell". A zero-volume cell computing 0/0 is the obvious
		// producer, so every non-finite input resolves to the FLOOR.
		expect(clampOwnShare(Number.NaN)).toBe(0);
		expect(clampOwnShare(Number.POSITIVE_INFINITY)).toBe(0);
		expect(clampOwnShare(Number.NEGATIVE_INFINITY)).toBe(0);
		// ...and a non-finite share therefore reads as "relay engaged", never as
		// "no relay needed".
		expect(isFallbackActiveForShare(Number.NaN)).toBe(true);
		expect(isFallbackActiveForShare(Number.POSITIVE_INFINITY)).toBe(true);
		expect(isFallbackActiveForShare(Number.NEGATIVE_INFINITY)).toBe(true);
		// A corrupt STORED share is degenerate evidence, not an absent field: D1's
		// `??` fires on absent only, so a non-finite share flows into the clamp and
		// fails closed on the floor — on a HEALTHY row too. Read boundary and write
		// boundary must never disagree about a NaN.
		expect(resolveOwnShare({ isFallbackActive: true, ownShare: Number.NaN })).toBe(0);
		expect(resolveOwnShare({ isFallbackActive: false, ownShare: Number.NaN })).toBe(0);
		expect(resolveOwnShare({ isFallbackActive: false, ownShare: Number.POSITIVE_INFINITY })).toBe(
			0
		);
		expect(resolveOwnShare({ isFallbackActive: false, ownShare: Number.NEGATIVE_INFINITY })).toBe(
			0
		);
		// ...and a corrupt share on a healthy row therefore engages the relay.
		expect(isRouteStateFallbackActive({ isFallbackActive: false, ownShare: Number.NaN })).toBe(
			true
		);
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
				const key = deliverabilityCellKey({ stream, destinationProvider: provider });
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

	it('is the shipped governed message type, not a parallel taxonomy', () => {
		// Same array identity, not merely the same members: a fifth governed
		// message type widens the stream axis with it, so a per-stream lookup can
		// never silently miss and fall through to the legacy row.
		expect(DELIVERABILITY_STREAM_KEYS).toBe(GOVERNED_MESSAGE_TYPES);
		expect([...DELIVERABILITY_STREAM_KEYS].sort()).toEqual(
			['automation', 'campaign', 'transactional'].sort()
		);
		for (const stream of DELIVERABILITY_STREAM_KEYS)
			expect(isGovernedMessageType(stream)).toBe(true);
		expect(isGovernedMessageType('marketing')).toBe(false);
		expect(isGovernedMessageType(undefined)).toBe(false);
		expect(isGovernedMessageType(1)).toBe(false);
	});
});
