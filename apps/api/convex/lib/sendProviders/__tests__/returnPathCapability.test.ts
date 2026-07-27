import { describe, expect, it } from 'vitest';
import {
	RETURN_PATH_PROBE_RETRY_MS,
	RETURN_PATH_PROBE_TIMEOUT_MS,
	RETURN_PATH_PROBE_TTL_MS,
	isProbeDue,
	isProbeTimedOut,
	nextProbeState,
	resolveReturnPathCapability,
	type ReturnPathProbeState,
} from '../returnPathCapability';

/**
 * G-08 (2) — capability detection. The catalog declares what it can
 * (`supportsCustomReturnPath`), the probe settles the rest, and `unknown` is a
 * SUPPORTED state, never an error.
 *
 * The adversarial case is the one this whole mechanism exists for: a relay that
 * ACCEPTS our envelope sender and silently rewrites it must be detected as
 * unsupported, not trusted. Acceptance is deliberately not a verdict.
 */

const T0 = Date.UTC(2026, 6, 1, 0, 0, 0);
const SENT = 'bounce+abc+mac@bounces.example.com';

function openProbe(startedAt = T0): ReturnPathProbeState {
	return {
		status: 'awaiting_delivery',
		reason: 'awaiting_delivery',
		sentEnvelopeSender: SENT,
		startedAt,
	};
}

describe('probe state machine', () => {
	it('acceptance alone is NOT a verdict — the probe stays open', () => {
		const state = nextProbeState(openProbe(), { kind: 'submitted', accepted: true, at: T0 });
		expect(state.status).toBe('awaiting_delivery');
	});

	it('a MAIL FROM refusal settles it as unsupported immediately', () => {
		const state = nextProbeState(openProbe(), { kind: 'submitted', accepted: false, at: T0 + 1 });
		expect(state.status).toBe('unsupported');
		expect(state.reason).toBe('rejected_by_relay');
		expect(state.settledAt).toBe(T0 + 1);
	});

	it('an observed bounce carrying OUR envelope sender proves support', () => {
		const state = nextProbeState(openProbe(), {
			kind: 'observed',
			envelopeSender: SENT,
			at: T0 + 5,
		});
		expect(state.status).toBe('supported');
		expect(state.reason).toBe('observed_match');
	});

	it('is case/whitespace tolerant on the observed address (RFC 5321 domains)', () => {
		const state = nextProbeState(openProbe(), {
			kind: 'observed',
			envelopeSender: `  ${SENT.toUpperCase()} `,
			at: T0 + 5,
		});
		expect(state.status).toBe('supported');
	});

	it('ADVERSARIAL: a relay that accepts then REWRITES the sender is unsupported', () => {
		const accepted = nextProbeState(openProbe(), { kind: 'submitted', accepted: true, at: T0 });
		const state = nextProbeState(accepted, {
			kind: 'observed',
			envelopeSender: 'bounces@relay-provider.example',
			at: T0 + 60_000,
		});
		expect(state.status).toBe('unsupported');
		expect(state.reason).toBe('rewritten_by_relay');
		expect(state.observedEnvelopeSender).toBe('bounces@relay-provider.example');
	});

	it('settles as unsupported when no bounce is ever observed', () => {
		const state = nextProbeState(openProbe(), { kind: 'expired', at: T0 + 1 });
		expect(state.status).toBe('unsupported');
		expect(state.reason).toBe('no_bounce_observed');
	});

	it('ignores late events for an already-settled probe', () => {
		const settled = nextProbeState(openProbe(), { kind: 'expired', at: T0 + 1 });
		expect(nextProbeState(settled, { kind: 'observed', envelopeSender: SENT, at: T0 + 2 })).toBe(
			settled
		);
	});

	it('times out only after the timeout window', () => {
		expect(isProbeTimedOut(openProbe(), T0 + RETURN_PATH_PROBE_TIMEOUT_MS - 1)).toBe(false);
		expect(isProbeTimedOut(openProbe(), T0 + RETURN_PATH_PROBE_TIMEOUT_MS)).toBe(true);
	});
});

describe('re-probe schedule', () => {
	const supported: ReturnPathProbeState = {
		status: 'supported',
		reason: 'observed_match',
		sentEnvelopeSender: SENT,
		observedEnvelopeSender: SENT,
		startedAt: T0,
		settledAt: T0,
	};
	const unsupported: ReturnPathProbeState = {
		status: 'unsupported',
		reason: 'rewritten_by_relay',
		sentEnvelopeSender: SENT,
		startedAt: T0,
		settledAt: T0,
	};

	it('a never-probed transport is due', () => {
		expect(isProbeDue(null, T0)).toBe(true);
	});

	it('an open probe holds the slot until it times out', () => {
		expect(isProbeDue(openProbe(), T0 + 1)).toBe(false);
		expect(isProbeDue(openProbe(), T0 + RETURN_PATH_PROBE_TIMEOUT_MS)).toBe(true);
	});

	it('a supported verdict is re-checked after the TTL', () => {
		expect(isProbeDue(supported, T0 + RETURN_PATH_PROBE_TTL_MS - 1)).toBe(false);
		expect(isProbeDue(supported, T0 + RETURN_PATH_PROBE_TTL_MS)).toBe(true);
	});

	it('an unsupported verdict is retried sooner — relay config changes', () => {
		expect(isProbeDue(unsupported, T0 + RETURN_PATH_PROBE_RETRY_MS - 1)).toBe(false);
		expect(isProbeDue(unsupported, T0 + RETURN_PATH_PROBE_RETRY_MS)).toBe(true);
	});
});

describe('resolveReturnPathCapability', () => {
	it('our own MTA is declared supported without any probe', () => {
		const resolved = resolveReturnPathCapability('mta', null, T0);
		expect(resolved.capability).toBe('supported');
		expect(resolved.stampVerpReturnPath).toBe(true);
		expect(resolved.degraded).toBe(false);
	});

	it('an API transport that owns its envelope sender is unsupported but not degraded-blind', () => {
		for (const kind of ['ses', 'resend'] as const) {
			const resolved = resolveReturnPathCapability(kind, null, T0);
			expect(resolved.capability).toBe('unsupported');
			expect(resolved.stampVerpReturnPath).toBe(false);
			expect(resolved.degraded).toBe(true);
			// It has its own feedback channel, so its tolerance widens less than a
			// relay with no feedback at all.
			expect(resolved.bounceToleranceMultiplier).toBe(2);
		}
	});

	it('an UNPROBED relay resolves to unknown — treated as unsupported, never an error', () => {
		const resolved = resolveReturnPathCapability('smtp', null, T0);
		expect(resolved.capability).toBe('unknown');
		expect(resolved.stampVerpReturnPath).toBe(false);
		expect(resolved.degraded).toBe(true);
		expect(resolved.bounceToleranceMultiplier).toBe(4);
	});

	it('an OPEN probe is still unknown', () => {
		expect(resolveReturnPathCapability('smtp', openProbe(), T0 + 1).capability).toBe('unknown');
	});

	it('a fresh supported verdict enables the stamp', () => {
		const resolved = resolveReturnPathCapability(
			'smtp',
			{
				status: 'supported',
				reason: 'observed_match',
				sentEnvelopeSender: SENT,
				startedAt: T0,
				settledAt: T0,
			},
			T0 + 1000
		);
		expect(resolved.capability).toBe('supported');
		expect(resolved.stampVerpReturnPath).toBe(true);
		expect(resolved.measurement).toBe('comparable');
		expect(resolved.bounceToleranceMultiplier).toBe(1);
	});

	it('a STALE verdict decays back to unknown rather than being trusted forever', () => {
		const resolved = resolveReturnPathCapability(
			'smtp',
			{
				status: 'supported',
				reason: 'observed_match',
				sentEnvelopeSender: SENT,
				startedAt: T0,
				settledAt: T0,
			},
			T0 + RETURN_PATH_PROBE_TTL_MS
		);
		expect(resolved.capability).toBe('unknown');
		expect(resolved.stampVerpReturnPath).toBe(false);
	});

	it('ADVERSARIAL: clock skew (a verdict from the future) never grants support', () => {
		const resolved = resolveReturnPathCapability(
			'smtp',
			{
				status: 'supported',
				reason: 'observed_match',
				sentEnvelopeSender: SENT,
				startedAt: T0,
				settledAt: T0 + 60 * 60 * 1000,
			},
			T0
		);
		expect(resolved.capability).toBe('unknown');
	});

	it('is total — no input combination throws', () => {
		expect(() =>
			resolveReturnPathCapability('smtp', openProbe(Number.NaN), Number.NaN)
		).not.toThrow();
	});
});
