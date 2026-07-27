import { describe, expect, it } from 'vitest';
import {
	RETURN_PATH_PROBE_RETRY_MS,
	RETURN_PATH_PROBE_RETRY_SCHEDULE_MS,
	RETURN_PATH_PROBE_TIMEOUT_MS,
	RETURN_PATH_PROBE_TTL_MS,
	isProbeDue,
	isProbeTimedOut,
	nextProbeAttempts,
	nextProbeState,
	resolveReturnPathCapability,
	resolveReturnPathCapabilityForEntry,
	returnPathProbeRetryMs,
	settledVerdictOf,
	unresolvableReturnPathCapability,
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

	it('is whitespace tolerant, and case tolerant on the DOMAIN only', () => {
		const state = nextProbeState(openProbe(), {
			kind: 'observed',
			envelopeSender: `  bounce+abc+mac@BOUNCES.EXAMPLE.COM `,
			at: T0 + 5,
		});
		expect(state.status).toBe('supported');
	});

	it('ADVERSARIAL: a relay that CASE-FOLDS the VERP token has rewritten it', () => {
		// The local part is a base64url token whose case is significant and whose
		// MAC is checked case-sensitively: a case-folded DSN can never decode, so
		// grading this `supported` would declare an arm comparable whose bounce
		// stream is in fact silently empty.
		const state = nextProbeState(openProbe(), {
			kind: 'observed',
			envelopeSender: SENT.toUpperCase(),
			at: T0 + 5,
		});
		expect(state.status).toBe('unsupported');
		expect(state.reason).toBe('rewritten_by_relay');
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

	it('BACKS OFF: every probe costs the operator a real bounce on their relay', () => {
		const [first, second, third] = RETURN_PATH_PROBE_RETRY_SCHEDULE_MS;
		expect(first).toBeLessThan(second);
		expect(second).toBeLessThan(third);
		expect(returnPathProbeRetryMs(1)).toBe(first);
		expect(returnPathProbeRetryMs(2)).toBe(second);
		expect(returnPathProbeRetryMs(3)).toBe(third);
		// The last interval REPEATS — the cap. We never stop entirely, or an
		// operator who fixes their relay could never be re-detected.
		expect(returnPathProbeRetryMs(4)).toBe(third);
		expect(returnPathProbeRetryMs(4000)).toBe(third);
		// Degenerate counts fall back to the shortest interval, never to NaN.
		expect(returnPathProbeRetryMs(undefined)).toBe(first);
		expect(returnPathProbeRetryMs(0)).toBe(first);
		expect(returnPathProbeRetryMs(-5)).toBe(first);
		expect(returnPathProbeRetryMs(Number.NaN)).toBe(first);
	});

	it('applies the backoff to the stored attempt count', () => {
		const fifth: ReturnPathProbeState = { ...unsupported, attempts: 5 };
		const monthly = returnPathProbeRetryMs(5);
		expect(isProbeDue(fifth, T0 + RETURN_PATH_PROBE_RETRY_MS)).toBe(false);
		expect(isProbeDue(fifth, T0 + monthly - 1)).toBe(false);
		expect(isProbeDue(fifth, T0 + monthly)).toBe(true);
	});

	it('ADVERSARIAL: a non-finite timestamp is DUE, never a permanent wedge', () => {
		// A NaN makes every `>=` comparison false, which would freeze the probe
		// open forever, freeze the capability at `unknown`, and leave no path back.
		for (const degenerate of [Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(isProbeTimedOut(openProbe(degenerate), T0)).toBe(true);
			expect(isProbeDue(openProbe(degenerate), T0)).toBe(true);
			expect(isProbeDue({ ...unsupported, settledAt: degenerate }, T0)).toBe(true);
			expect(isProbeDue({ ...supported, settledAt: degenerate }, T0)).toBe(true);
			expect(isProbeDue(supported, degenerate)).toBe(true);
		}
		// A settled row with no settledAt at all falls back to startedAt.
		expect(isProbeDue({ ...unsupported, startedAt: Number.NaN, settledAt: undefined }, T0)).toBe(
			true
		);
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

	it('an unresolvable transport has the SAME posture as one with no evidence', () => {
		// Built by the same grading function, so it can never drift from what a
		// probeable-but-unprobed transport resolves to.
		expect(unresolvableReturnPathCapability).toMatchObject({
			capability: 'unknown',
			stampVerpReturnPath: false,
			degraded: true,
			bounceToleranceMultiplier: resolveReturnPathCapability('smtp', null, T0)
				.bounceToleranceMultiplier,
		});
	});

	it('is total — no input combination throws', () => {
		expect(() =>
			resolveReturnPathCapability('smtp', openProbe(Number.NaN), Number.NaN)
		).not.toThrow();
	});
});

describe('a RE-PROBE does not revoke the verdict it is re-checking', () => {
	const probeOnly = { supportsCustomReturnPath: 'probe' } as const;
	const settledSupported = {
		status: 'supported',
		reason: 'observed_match',
		settledAt: T0,
	} as const;

	function reProbe(overrides: Partial<ReturnPathProbeState> = {}): ReturnPathProbeState {
		return {
			status: 'awaiting_delivery',
			reason: 'awaiting_delivery',
			sentEnvelopeSender: SENT,
			startedAt: T0 + RETURN_PATH_PROBE_TTL_MS,
			attempts: 2,
			lastSettled: settledSupported,
			...overrides,
		};
	}

	it('keeps stamping while the re-probe is open — the stamp is not switched off', () => {
		// Without the carry, the 30d TTL re-probe would flip a PROVEN relay to
		// `unknown` for up to the probe timeout, twelve times a year: relayed
		// bounces in that window would be unattributable and the cell would
		// silently read degraded.
		const resolved = resolveReturnPathCapabilityForEntry(
			probeOnly,
			reProbe(),
			T0 + RETURN_PATH_PROBE_TTL_MS + 60_000
		);
		expect(resolved.capability).toBe('supported');
		expect(resolved.stampVerpReturnPath).toBe(true);
		expect(resolved.degraded).toBe(false);
		expect(resolved.reason).toBe('observed_match');
		// The row is still honestly reported as open.
		expect(resolved.probeStatus).toBe('awaiting_delivery');
	});

	it('carries an UNSUPPORTED verdict too — it never upgrades on silence', () => {
		const resolved = resolveReturnPathCapabilityForEntry(
			probeOnly,
			reProbe({
				lastSettled: { status: 'unsupported', reason: 'rewritten_by_relay', settledAt: T0 },
			}),
			T0 + RETURN_PATH_PROBE_TTL_MS + 60_000
		);
		expect(resolved.capability).toBe('unsupported');
		expect(resolved.stampVerpReturnPath).toBe(false);
		expect(resolved.reason).toBe('rewritten_by_relay');
	});

	it('the carry is BOUNDED by the probe timeout — a broken relay is demoted', () => {
		const start = T0 + RETURN_PATH_PROBE_TTL_MS;
		const resolved = resolveReturnPathCapabilityForEntry(
			probeOnly,
			reProbe(),
			start + RETURN_PATH_PROBE_TIMEOUT_MS
		);
		expect(resolved.capability).toBe('unknown');
		expect(resolved.stampVerpReturnPath).toBe(false);
		expect(resolved.degraded).toBe(true);
	});

	it('ADVERSARIAL: a degenerate clock can never pin a stale verdict', () => {
		for (const degenerate of [Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				resolveReturnPathCapabilityForEntry(probeOnly, reProbe({ startedAt: degenerate }), T0)
					.capability
			).toBe('unknown');
			expect(
				resolveReturnPathCapabilityForEntry(
					probeOnly,
					reProbe({ lastSettled: { ...settledSupported, settledAt: degenerate } }),
					T0 + RETURN_PATH_PROBE_TTL_MS + 60_000
				).capability
			).toBe('unknown');
		}
	});

	// ONE rule for what counts as evidence: the carry is judged by the same
	// clock-skew test the freshness check applies to a settled row.
	it('ADVERSARIAL: a carried verdict stamped in the FUTURE is not evidence', () => {
		const start = T0 + RETURN_PATH_PROBE_TTL_MS;
		const resolved = resolveReturnPathCapabilityForEntry(
			probeOnly,
			reProbe({ lastSettled: { ...settledSupported, settledAt: start + 60_000 } }),
			start + 1_000
		);
		expect(resolved.capability).toBe('unknown');
		expect(resolved.stampVerpReturnPath).toBe(false);
		expect(resolved.degraded).toBe(true);
	});

	it('a first-ever open probe still resolves to unknown', () => {
		expect(
			resolveReturnPathCapabilityForEntry(probeOnly, reProbe({ lastSettled: undefined }), T0)
				.capability
		).toBe('unknown');
	});
});

describe('attempts count CONSECUTIVE probes since the last supported verdict', () => {
	const settled = (
		status: 'supported' | 'unsupported',
		attempts: number
	): ReturnPathProbeState => ({
		status,
		reason: status === 'supported' ? 'observed_match' : 'no_bounce_observed',
		sentEnvelopeSender: SENT,
		startedAt: T0,
		settledAt: T0,
		attempts,
	});

	it('a relay that has been WORKING keeps the fast first retry for the day it breaks', () => {
		// A relay supported for a year is re-probed twelve times at the 30d TTL. If
		// the count accumulated, its documented "1st retry: next day" would in fact
		// be 30 days on exactly the day the relay broke.
		expect(nextProbeAttempts(settled('supported', 12))).toBe(1);
		expect(returnPathProbeRetryMs(nextProbeAttempts(settled('supported', 12)))).toBe(
			RETURN_PATH_PROBE_RETRY_MS
		);
	});

	it('accumulates while the verdict stays unsupported', () => {
		expect(nextProbeAttempts(null)).toBe(1);
		expect(nextProbeAttempts(settled('unsupported', 1))).toBe(2);
		expect(nextProbeAttempts(settled('unsupported', 2))).toBe(3);
	});

	it('resets through a carried verdict on an OPEN re-probe too', () => {
		const open: ReturnPathProbeState = {
			status: 'awaiting_delivery',
			reason: 'awaiting_delivery',
			sentEnvelopeSender: SENT,
			startedAt: T0,
			attempts: 9,
			lastSettled: { status: 'supported', reason: 'observed_match', settledAt: T0 },
		};
		expect(settledVerdictOf(open)?.status).toBe('supported');
		expect(nextProbeAttempts(open)).toBe(1);
	});

	it('ADVERSARIAL: a degenerate stored count never produces NaN', () => {
		for (const degenerate of [Number.NaN, Number.POSITIVE_INFINITY, -7]) {
			const next = nextProbeAttempts(settled('unsupported', degenerate));
			expect(Number.isFinite(next)).toBe(true);
			expect(next).toBeGreaterThanOrEqual(1);
		}
		expect(settledVerdictOf(null)).toBeUndefined();
		expect(settledVerdictOf(undefined)).toBeUndefined();
	});
});
