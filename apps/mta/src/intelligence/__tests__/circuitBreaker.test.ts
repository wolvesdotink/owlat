import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import {
	canSend,
	recordOutcome,
	getState,
	COMPLAINT_SLOW_THRESHOLD,
	COMPLAINT_FAST_THRESHOLD,
	SLOW_WINDOW,
	FAST_WINDOW,
	COOLDOWN_MS,
	EXTENDED_COOLDOWN_MS,
	HALF_OPEN_LIMIT,
} from '../circuitBreaker.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: vi.fn().mockResolvedValue(true),
}));

describe('circuitBreaker', () => {
	let redis: RealRedis;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-22T12:00:00Z'));
	});

	afterEach(async () => {
		vi.useRealTimers();
		await redis.flushall();
	});

	describe('canSend', () => {
		it('returns allowed:true when no state exists (default closed)', async () => {
			const result = await canSend(redis, 'org-1');
			expect(result.allowed).toBe(true);
			expect(result.state).toBe('closed');
		});

		it('returns allowed:false with retryAfter when state is open and cooldown not expired', async () => {
			const now = Date.now();
			await redis.hset(
				'mta:breaker:org-1:state',
				'status', 'open',
				'cooldownUntil', String(now + 30 * 60 * 1000)
			);

			const result = await canSend(redis, 'org-1');
			expect(result.allowed).toBe(false);
			expect(result.retryAfter).toBeGreaterThan(0);
			expect(result.state).toBe('open');
		});

		it('transitions to half-open when cooldown has expired', async () => {
			const pastCooldown = Date.now() - 1000;
			await redis.hset(
				'mta:breaker:org-1:state',
				'status', 'open',
				'cooldownUntil', String(pastCooldown)
			);

			const result = await canSend(redis, 'org-1');
			expect(result.allowed).toBe(true);
			expect(result.state).toBe('half-open');

			const state = await getState(redis, 'org-1');
			expect(state.status).toBe('half-open');
			expect(state.halfOpenSent).toBe(0);
			expect(state.halfOpenBounced).toBe(0);
		});

		it('in half-open with <5 sends returns allowed:true', async () => {
			await redis.hset(
				'mta:breaker:org-1:state',
				'status', 'half-open',
				'halfOpenSent', '3',
				'halfOpenBounced', '0'
			);

			const result = await canSend(redis, 'org-1');
			expect(result.allowed).toBe(true);
			expect(result.state).toBe('half-open');
		});

		it('half-open after 5 sends with 0 bounces closes circuit', async () => {
			await redis.hset(
				'mta:breaker:org-1:state',
				'status', 'half-open',
				'halfOpenSent', '5',
				'halfOpenBounced', '0'
			);
			// Seed some leftover outcomes to verify they get cleared
			await redis.lpush('mta:breaker:org-1:outcomes', 'b', 'd', 'd');

			const result = await canSend(redis, 'org-1');
			expect(result.allowed).toBe(true);
			expect(result.state).toBe('closed');

			const state = await getState(redis, 'org-1');
			expect(state.status).toBe('closed');

			// Outcomes list should be deleted
			const outcomes = await redis.lrange('mta:breaker:org-1:outcomes', 0, -1);
			expect(outcomes).toHaveLength(0);
		});

		it('half-open after 5 sends with bounces re-opens with 60min cooldown', async () => {
			await redis.hset(
				'mta:breaker:org-1:state',
				'status', 'half-open',
				'halfOpenSent', '5',
				'halfOpenBounced', '2'
			);

			const result = await canSend(redis, 'org-1');
			expect(result.allowed).toBe(false);
			expect(result.retryAfter).toBe(60 * 60 * 1000);
			expect(result.state).toBe('open');

			const state = await getState(redis, 'org-1');
			expect(state.status).toBe('open');
		});
	});

	describe('recordOutcome', () => {
		it('in closed state adds to outcomes list', async () => {
			await recordOutcome(redis, 'org-1', 'delivered');
			await recordOutcome(redis, 'org-1', 'bounced');
			await recordOutcome(redis, 'org-1', 'delivered');

			const outcomes = await redis.lrange('mta:breaker:org-1:outcomes', 0, -1);
			expect(outcomes).toHaveLength(3);
			expect(outcomes[0]).toBe('d'); // most recent (lpush)
			expect(outcomes[1]).toBe('b');
			expect(outcomes[2]).toBe('d');
		});

		it('trips circuit on fast window: 8+ bounces in 50 sends (>15%)', async () => {
			// Need >15% of 50 = more than 7.5, so 8 bounces
			// Push 42 deliveries then 8 bounces (most recent first via lpush)
			for (let i = 0; i < 42; i++) {
				await recordOutcome(redis, 'org-1', 'delivered');
			}
			for (let i = 0; i < 8; i++) {
				await recordOutcome(redis, 'org-1', 'bounced');
			}

			const state = await getState(redis, 'org-1');
			expect(state.status).toBe('open');
			expect(state.tripReason).toContain('exceeded');
		});

		it('does NOT trip at exactly 15% (threshold is >)', async () => {
			// Exactly 15% of 50 = 7.5, so 7 bounces in first 50 = 14%, not enough
			// But we need exactly 15%: that's not possible with integers.
			// 7/50 = 14%, 8/50 = 16% — so at 7 bounces (14%) it should NOT trip.
			// We push 43 deliveries + 7 bounces = 50 total.
			// The list has most-recent first, so bounces are at positions 0-6 in the fast window.
			for (let i = 0; i < 43; i++) {
				await recordOutcome(redis, 'org-1', 'delivered');
			}
			for (let i = 0; i < 7; i++) {
				await recordOutcome(redis, 'org-1', 'bounced');
			}

			const state = await getState(redis, 'org-1');
			expect(state.status).toBe('closed');
		});

		it('trips on slow window: 9+ bounces in 100 sends (>8%)', async () => {
			// >8% of 100 = more than 8, so 9 bounces
			// Fill 100 outcomes: 91 delivered + 9 bounced
			// Need to avoid tripping fast window first: spread bounces out
			// Push 91 deliveries first, then 9 bounces (fast window = last 50 = all bounces + some deliveries)
			// Actually fast window is first 50 elements of list (most recent).
			// So push deliveries first (they go to end), then bounces go to front.
			// Let's interleave to keep fast window below 15%.

			// Strategy: push 50 deliveries, then alternate to keep fast window safe
			// Simpler: push all 91 deliveries, then all 9 bounces.
			// Fast window (first 50) = 9 bounces + 41 deliveries = 9/50 = 18% → would trip fast!
			// Instead: push bounces first spread out across the slow window
			// Push in groups: 11d, 1b, 11d, 1b... for 9 bounces
			for (let i = 0; i < 9; i++) {
				for (let j = 0; j < 10; j++) {
					await recordOutcome(redis, 'org-1', 'delivered');
				}
				await recordOutcome(redis, 'org-1', 'bounced');
			}
			// Now we have 99 sends. Add 1 more delivery to reach 100
			await recordOutcome(redis, 'org-1', 'delivered');

			// Fast window (first 50 from list = most recent 50):
			// Pattern repeats: 10d,1b. Last ~50 entries: ~4-5 bounces in 50 = 8-10% ≤ 15%, so fast won't trip.
			// Slow window: 9 bounces in 100 = 9% > 8% → should trip.
			const state = await getState(redis, 'org-1');
			expect(state.status).toBe('open');
		});

		it('in half-open increments halfOpenSent/halfOpenBounced and does not add to outcomes', async () => {
			await redis.hset(
				'mta:breaker:org-1:state',
				'status', 'half-open',
				'halfOpenSent', '0',
				'halfOpenBounced', '0'
			);

			await recordOutcome(redis, 'org-1', 'delivered');
			await recordOutcome(redis, 'org-1', 'bounced');
			await recordOutcome(redis, 'org-1', 'delivered');

			const state = await getState(redis, 'org-1');
			expect(state.halfOpenSent).toBe(3);
			expect(state.halfOpenBounced).toBe(1);

			// Should NOT add to outcomes list
			const outcomes = await redis.lrange('mta:breaker:org-1:outcomes', 0, -1);
			expect(outcomes).toHaveLength(0);
		});

		it('when already open adds to list but does not re-check thresholds', async () => {
			const now = Date.now();
			await redis.hset(
				'mta:breaker:org-1:state',
				'status', 'open',
				'openedAt', String(now),
				'cooldownUntil', String(now + 30 * 60 * 1000),
				'tripReason', 'Already tripped'
			);

			await recordOutcome(redis, 'org-1', 'bounced');
			await recordOutcome(redis, 'org-1', 'bounced');

			// Should still add to outcomes
			const outcomes = await redis.lrange('mta:breaker:org-1:outcomes', 0, -1);
			expect(outcomes).toHaveLength(2);

			// State should remain the same (no re-trip)
			const state = await getState(redis, 'org-1');
			expect(state.status).toBe('open');
			expect(state.tripReason).toBe('Already tripped');
		});
	});

	describe('complaint tracking', () => {
		it('records complaints with "c" marker in outcomes list', async () => {
			await recordOutcome(redis, 'org-1', 'delivered');
			await recordOutcome(redis, 'org-1', 'complained');
			await recordOutcome(redis, 'org-1', 'delivered');

			const outcomes = await redis.lrange('mta:breaker:org-1:outcomes', 0, -1);
			expect(outcomes).toHaveLength(3);
			expect(outcomes[0]).toBe('d');
			expect(outcomes[1]).toBe('c');
			expect(outcomes[2]).toBe('d');
		});

		it('trips circuit on complaint rate >4% in fast window (50 sends)', async () => {
			// >4% of 50 = more than 2, so 3 complaints
			for (let i = 0; i < 47; i++) {
				await recordOutcome(redis, 'org-1', 'delivered');
			}
			for (let i = 0; i < 3; i++) {
				await recordOutcome(redis, 'org-1', 'complained');
			}

			const state = await getState(redis, 'org-1');
			expect(state.status).toBe('open');
			expect(state.tripReason).toContain('Complaint rate');
			expect(state.tripReason).toContain('exceeded');
		});

		it('does NOT trip at 2% complaint rate in fast window (below 4% threshold)', async () => {
			// 2% of 50 = 1 complaint
			for (let i = 0; i < 49; i++) {
				await recordOutcome(redis, 'org-1', 'delivered');
			}
			await recordOutcome(redis, 'org-1', 'complained');

			const state = await getState(redis, 'org-1');
			expect(state.status).toBe('closed');
		});

		it('trips circuit on complaint rate >0.2% in slow window (100 sends)', async () => {
			// >0.2% of 100 = more than 0.2, so 1 complaint should NOT trip (1% > 0.2% → WILL trip)
			// Actually 1/100 = 1% > 0.2%, so even 1 complaint in 100 sends trips
			// But we need to avoid tripping the fast window (>4%)
			// 1 complaint in last 50 = 2%, which is < 4%, so fast won't trip
			// Let's interleave: 99 deliveries then 1 complaint
			for (let i = 0; i < 99; i++) {
				await recordOutcome(redis, 'org-1', 'delivered');
			}
			await recordOutcome(redis, 'org-1', 'complained');

			const state = await getState(redis, 'org-1');
			// 1/100 = 1% > 0.2% → should trip
			expect(state.status).toBe('open');
			expect(state.tripReason).toContain('Complaint rate');
		});

		it('complaints count as halfOpenBounced in half-open state', async () => {
			await redis.hset(
				'mta:breaker:org-1:state',
				'status', 'half-open',
				'halfOpenSent', '0',
				'halfOpenBounced', '0'
			);

			await recordOutcome(redis, 'org-1', 'delivered');
			await recordOutcome(redis, 'org-1', 'complained');

			const state = await getState(redis, 'org-1');
			expect(state.halfOpenSent).toBe(2);
			expect(state.halfOpenBounced).toBe(1); // complaint counted as a failure
		});

		it('complaints do NOT add to outcomes list in half-open state', async () => {
			await redis.hset(
				'mta:breaker:org-1:state',
				'status', 'half-open',
				'halfOpenSent', '0',
				'halfOpenBounced', '0'
			);

			await recordOutcome(redis, 'org-1', 'complained');

			const outcomes = await redis.lrange('mta:breaker:org-1:outcomes', 0, -1);
			expect(outcomes).toHaveLength(0);
		});

		it('bounce threshold still works independently of complaints', async () => {
			// Only bounces, no complaints — should still trip on bounce threshold
			for (let i = 0; i < 42; i++) {
				await recordOutcome(redis, 'org-1', 'delivered');
			}
			for (let i = 0; i < 8; i++) {
				await recordOutcome(redis, 'org-1', 'bounced');
			}

			const state = await getState(redis, 'org-1');
			expect(state.status).toBe('open');
			expect(state.tripReason).toContain('Bounce rate');
		});

		it('mixed bounces and complaints both tracked in ring buffer', async () => {
			await recordOutcome(redis, 'org-1', 'delivered');
			await recordOutcome(redis, 'org-1', 'bounced');
			await recordOutcome(redis, 'org-1', 'complained');
			await recordOutcome(redis, 'org-1', 'delivered');

			const outcomes = await redis.lrange('mta:breaker:org-1:outcomes', 0, -1);
			expect(outcomes).toEqual(['d', 'c', 'b', 'd']);
		});
	});

	// ──────────────────────────────────────────────────────────────────────
	// PR-73 regression lock: per-org circuit breaker.
	// Locks the industry-standard 0.2% complaint slow threshold (Gmail/Yahoo
	// 2024 sender requirements keep spam complaints below ~0.3%), the full
	// open→cooldown→half-open→close/re-open lifecycle, and the extended
	// cooldown on a re-open from a failed half-open probe.
	// ──────────────────────────────────────────────────────────────────────
	describe('PR-73: complaint slow threshold is the industry-standard 0.2%', () => {
		it('locks the threshold constants', () => {
			expect(COMPLAINT_SLOW_THRESHOLD).toBe(0.002);
			expect(COMPLAINT_FAST_THRESHOLD).toBe(0.04);
			expect(SLOW_WINDOW).toBe(100);
			expect(FAST_WINDOW).toBe(50);
			expect(COOLDOWN_MS).toBe(30 * 60 * 1000);
			expect(EXTENDED_COOLDOWN_MS).toBe(60 * 60 * 1000);
			expect(HALF_OPEN_LIMIT).toBe(5);
		});

		it('1 complaint + 99 deliveries over 100 (1% > 0.2%) trips on the complaint slow window', async () => {
			// 1/100 = 1.0% > 0.2% slow threshold. The single complaint is in the
			// last 50 too (2% < 4% fast), so the SLOW complaint check is what trips.
			for (let i = 0; i < 99; i++) {
				await recordOutcome(redis, 'org-c', 'delivered');
			}
			await recordOutcome(redis, 'org-c', 'complained');

			const state = await getState(redis, 'org-c');
			expect(state.status).toBe('open');
			expect(state.tripReason).toContain('Complaint rate');
			expect(state.tripReason).toContain('exceeded');
			// The cooldown is the standard (not extended) 30-minute window.
			expect(state.cooldownUntil! - state.openedAt!).toBe(COOLDOWN_MS);
		});

		it('0 complaints in 100 sends (0% ≤ 0.2%) does NOT trip', async () => {
			// The smallest representable complaint rate in a 100-window above 0 is
			// 1% (1/100), which trips. So a clean window — the only sub-0.2% rate
			// expressible here — must stay closed. This guards against a regression
			// that flips the comparison to `>=` and trips on a perfectly clean list.
			for (let i = 0; i < 100; i++) {
				await recordOutcome(redis, 'org-clean', 'delivered');
			}

			const state = await getState(redis, 'org-clean');
			expect(state.status).toBe('closed');
		});

		it('does not trip below 100 sends even with a complaint (slow window needs a full window)', async () => {
			// 1 complaint in 99 sends: the slow window check requires total >= 100.
			// 1/99 in the last-50 is < 4% fast, so nothing should trip yet.
			for (let i = 0; i < 98; i++) {
				await recordOutcome(redis, 'org-partial', 'delivered');
			}
			await recordOutcome(redis, 'org-partial', 'complained');

			const state = await getState(redis, 'org-partial');
			expect(state.status).toBe('closed');
		});
	});

	describe('PR-73: full open → cooldown → half-open → close / re-open lifecycle', () => {
		it('a tripped breaker recovers through a clean half-open probe (5 deliveries) and closes', async () => {
			// Trip the breaker on complaints.
			for (let i = 0; i < 99; i++) await recordOutcome(redis, 'org-life', 'delivered');
			await recordOutcome(redis, 'org-life', 'complained');
			expect((await getState(redis, 'org-life')).status).toBe('open');

			// Inside the cooldown: sending is blocked.
			const blocked = await canSend(redis, 'org-life');
			expect(blocked.allowed).toBe(false);
			expect(blocked.state).toBe('open');
			expect(blocked.retryAfter).toBeGreaterThan(0);

			// Advance past the 30-minute cooldown → next canSend flips to half-open.
			vi.advanceTimersByTime(COOLDOWN_MS + 1000);
			const halfOpen = await canSend(redis, 'org-life');
			expect(halfOpen.allowed).toBe(true);
			expect(halfOpen.state).toBe('half-open');

			// Five clean probe sends are recorded in half-open (not the ring buffer).
			for (let i = 0; i < HALF_OPEN_LIMIT; i++) {
				await recordOutcome(redis, 'org-life', 'delivered');
			}
			const probed = await getState(redis, 'org-life');
			expect(probed.halfOpenSent).toBe(HALF_OPEN_LIMIT);
			expect(probed.halfOpenBounced).toBe(0);

			// The next canSend after a clean probe closes the circuit.
			const closed = await canSend(redis, 'org-life');
			expect(closed.allowed).toBe(true);
			expect(closed.state).toBe('closed');
			expect((await getState(redis, 'org-life')).status).toBe('closed');
		});

		it('a single failure during the half-open probe re-opens with the EXTENDED 60-min cooldown', async () => {
			// Trip → cooldown → half-open.
			for (let i = 0; i < 99; i++) await recordOutcome(redis, 'org-reopen', 'delivered');
			await recordOutcome(redis, 'org-reopen', 'complained');
			vi.advanceTimersByTime(COOLDOWN_MS + 1000);
			expect((await canSend(redis, 'org-reopen')).state).toBe('half-open');

			// Probe: four clean, one bounce — a single failure is enough.
			for (let i = 0; i < 4; i++) await recordOutcome(redis, 'org-reopen', 'delivered');
			await recordOutcome(redis, 'org-reopen', 'bounced');
			const probed = await getState(redis, 'org-reopen');
			expect(probed.halfOpenSent).toBe(HALF_OPEN_LIMIT);
			expect(probed.halfOpenBounced).toBe(1);

			// The next canSend re-opens with the EXTENDED cooldown.
			const reopened = await canSend(redis, 'org-reopen');
			expect(reopened.allowed).toBe(false);
			expect(reopened.state).toBe('open');
			expect(reopened.retryAfter).toBe(EXTENDED_COOLDOWN_MS);

			const state = await getState(redis, 'org-reopen');
			expect(state.status).toBe('open');
			expect(state.tripReason).toContain('half-open');
		});

		it('a complaint during the half-open probe also re-opens (complaints count as failures)', async () => {
			for (let i = 0; i < 99; i++) await recordOutcome(redis, 'org-reopen-c', 'delivered');
			await recordOutcome(redis, 'org-reopen-c', 'complained');
			vi.advanceTimersByTime(COOLDOWN_MS + 1000);
			expect((await canSend(redis, 'org-reopen-c')).state).toBe('half-open');

			for (let i = 0; i < 4; i++) await recordOutcome(redis, 'org-reopen-c', 'delivered');
			await recordOutcome(redis, 'org-reopen-c', 'complained');

			const reopened = await canSend(redis, 'org-reopen-c');
			expect(reopened.state).toBe('open');
			expect(reopened.retryAfter).toBe(EXTENDED_COOLDOWN_MS);
		});
	});

	describe('getState', () => {
		it('returns correct shape with defaults for empty state', async () => {
			const state = await getState(redis, 'org-1');
			expect(state).toEqual({
				status: 'closed',
				openedAt: undefined,
				cooldownUntil: undefined,
				tripReason: undefined,
				halfOpenSent: undefined,
				halfOpenBounced: undefined,
			});
		});

		it('returns correct shape for open state', async () => {
			const now = Date.now();
			await redis.hset(
				'mta:breaker:org-1:state',
				'status', 'open',
				'openedAt', String(now),
				'cooldownUntil', String(now + 1800000),
				'tripReason', 'High bounce rate'
			);

			const state = await getState(redis, 'org-1');
			expect(state.status).toBe('open');
			expect(state.openedAt).toBe(now);
			expect(state.cooldownUntil).toBe(now + 1800000);
			expect(state.tripReason).toBe('High bounce rate');
		});
	});
});
