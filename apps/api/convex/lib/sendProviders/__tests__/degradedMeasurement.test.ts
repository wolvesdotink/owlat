import { describe, expect, it } from 'vitest';
import {
	BOUNCE_TOLERANCE_MULTIPLIER_COMPARABLE,
	BOUNCE_TOLERANCE_MULTIPLIER_NO_FEEDBACK,
	BOUNCE_TOLERANCE_MULTIPLIER_PROVIDER_FEEDBACK,
	resolveReturnPathCapability,
	resolveReturnPathCapabilityForEntry,
	widenBounceTolerance,
} from '../returnPathCapability';
import { resolveRelayEnvelopeSender } from '../smtp';
import { SEND_PROVIDER_CATALOG } from '../catalog';

/**
 * G-08 (3) — an unsupported relay flags the cell DEGRADED MEASUREMENT and
 * widens the bounce-gate tolerance, and NOTHING is blocked (plan D2).
 *
 * The standalone matrix is the important half of this file: with no relay
 * configured, no VERP key, no probe and no external account of any kind, every
 * function still returns a usable posture. Absence lowers confidence and does
 * nothing else.
 */

const T0 = Date.UTC(2026, 6, 27, 0, 0, 0);

describe('degraded measurement — the flag', () => {
	it('an unprobed relay is degraded with the widest tolerance', () => {
		const resolved = resolveReturnPathCapability('smtp', null, T0);
		expect(resolved.measurement).toBe('degraded');
		expect(resolved.degraded).toBe(true);
		expect(widenBounceTolerance(0.02, resolved)).toBeCloseTo(
			0.02 * BOUNCE_TOLERANCE_MULTIPLIER_NO_FEEDBACK
		);
	});

	it('a transport with its own feedback widens less than one with none', () => {
		const withFeedback = resolveReturnPathCapability('ses', null, T0);
		const withoutFeedback = resolveReturnPathCapability('smtp', null, T0);
		expect(withFeedback.bounceToleranceMultiplier).toBe(
			BOUNCE_TOLERANCE_MULTIPLIER_PROVIDER_FEEDBACK
		);
		expect(withoutFeedback.bounceToleranceMultiplier).toBe(BOUNCE_TOLERANCE_MULTIPLIER_NO_FEEDBACK);
		expect(withFeedback.bounceToleranceMultiplier).toBeLessThan(
			withoutFeedback.bounceToleranceMultiplier
		);
	});

	it('a comparable arm is never widened', () => {
		const resolved = resolveReturnPathCapability('mta', null, T0);
		expect(resolved.measurement).toBe('comparable');
		expect(resolved.bounceToleranceMultiplier).toBe(BOUNCE_TOLERANCE_MULTIPLIER_COMPARABLE);
		expect(widenBounceTolerance(0.02, resolved)).toBe(0.02);
	});

	it('never produces a NaN or negative threshold from a degenerate base', () => {
		const resolved = resolveReturnPathCapability('smtp', null, T0);
		expect(widenBounceTolerance(Number.NaN, resolved)).toBeNaN();
		expect(widenBounceTolerance(-1, resolved)).toBe(-1);
		expect(widenBounceTolerance(0, resolved)).toBe(0);
		expect(Number.isFinite(widenBounceTolerance(0.05, resolved))).toBe(true);
	});
});

describe('D2 — absence blocks nothing', () => {
	it('resolves a posture for EVERY catalogued transport with no probe data at all', () => {
		for (const entry of SEND_PROVIDER_CATALOG) {
			const resolved = resolveReturnPathCapability(entry.kind, null, T0);
			expect(['supported', 'unsupported', 'unknown']).toContain(resolved.capability);
			expect(typeof resolved.reason).toBe('string');
			expect(resolved.bounceToleranceMultiplier).toBeGreaterThan(0);
		}
	});

	it('a transport with no declared capability fails closed to unsupported, not to an error', () => {
		// An EXPLICIT undeclared fixture, not a search of the live catalog: a
		// plugin-contributed transport declares nothing, and a search-based
		// assertion passes vacuously the day every bundled entry declares
		// something — which is true of every core entry today.
		const resolved = resolveReturnPathCapabilityForEntry({}, null, T0);
		expect(resolved.capability).toBe('unsupported');
		expect(resolved.stampVerpReturnPath).toBe(false);
		expect(resolved.degraded).toBe(true);
		// No declared feedback channel either ⇒ the widest tolerance, never a throw.
		expect(resolved.bounceToleranceMultiplier).toBe(BOUNCE_TOLERANCE_MULTIPLIER_NO_FEEDBACK);
	});

	it('an undeclared transport that DOES report feedback still fails closed on the stamp', () => {
		const resolved = resolveReturnPathCapabilityForEntry({ hasProviderFeedback: true }, null, T0);
		expect(resolved.stampVerpReturnPath).toBe(false);
		expect(resolved.bounceToleranceMultiplier).toBe(BOUNCE_TOLERANCE_MULTIPLIER_PROVIDER_FEEDBACK);
	});

	it('the send path still produces a usable envelope sender with zero configuration', () => {
		const { envelopeFrom, isVerp } = resolveRelayEnvelopeSender({
			composedEnvelopeFrom: 'news@example.com',
			messageId: 'msg-1',
			customReturnPath: false,
			returnPathDomain: undefined,
			verpKey: undefined,
			now: T0,
		});
		// The send goes out exactly as it shipped — no throw, no error state.
		expect(isVerp).toBe(false);
		expect(envelopeFrom).toBe('news@example.com');
	});

	it('a degraded cell is still a SENDING cell — degradation carries no blocking signal', () => {
		const resolved = resolveReturnPathCapability('smtp', null, T0);
		expect(Object.keys(resolved)).not.toContain('blocked');
		expect(Object.keys(resolved)).not.toContain('error');
		expect(resolved.stampVerpReturnPath).toBe(false);
	});
});
