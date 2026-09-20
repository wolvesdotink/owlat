/**
 * decision.breaker — the circuit breaker guarding the decision plane's fallback
 * hop onto the language model.
 *
 * What these tests pin is the property the plan asks for: a provider outage
 * must not silently re-route every inbound message onto a model that costs 24
 * to 50 times more. So a run of failures OPENS the breaker, an open breaker
 * refuses the hop, and closing it again takes real recovery TIME — the bucket's
 * own refill — with no shortcut a flapping provider could stumble into.
 */
import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { DECISION_BREAKER_CLOSE_FRACTION, decisionBreakerStateFor } from '../breaker';

// Vite's `import.meta.glob` excludes the directory chain it climbed up through
// to reach the glob base, so `'../../**'` from this `decision/__tests__` file
// omits the sibling `decision/*` modules under test. Merge a second glob rooted
// at `decision/` and re-prefix its keys to the same `../../`-relative form.
const rootGlob = import.meta.glob('../../**/*.*s');
const decisionGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../decision/'),
		mod,
	])
);
const modules = { ...rootGlob, ...decisionGlob };

/** The bucket's capacity, read from the one place it is configured. */
const BUDGET = 20;

function setup() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

async function failTimes(t: ReturnType<typeof convexTest>, times: number) {
	let last;
	for (let i = 0; i < times; i++) {
		last = await t.mutation(internal.decision.breaker.recordFailure, {});
	}
	return last;
}

afterEach(() => {
	vi.useRealTimers();
});

describe('decisionBreakerStateFor', () => {
	it('opens only when there is no whole failure left to charge', () => {
		expect(decisionBreakerStateFor(0, BUDGET)).toBe('open');
		expect(decisionBreakerStateFor(0.9, BUDGET)).toBe('open');
		expect(decisionBreakerStateFor(1, BUDGET)).toBe('half_open');
	});

	it('closes only once half the budget is back — the hysteresis', () => {
		const half = BUDGET * DECISION_BREAKER_CLOSE_FRACTION;
		expect(decisionBreakerStateFor(half - 0.01, BUDGET)).toBe('half_open');
		expect(decisionBreakerStateFor(half, BUDGET)).toBe('closed');
		expect(decisionBreakerStateFor(BUDGET, BUDGET)).toBe('closed');
	});

	it('treats a zero budget as permanently open rather than dividing by it', () => {
		expect(decisionBreakerStateFor(0, 0)).toBe('open');
	});
});

describe('decision.breaker', () => {
	it('starts closed on an instance that has never called the plane', async () => {
		const t = setup();
		const status = await t.query(internal.decision.breaker.status, {});
		expect(status).toMatchObject({ state: 'closed', fallbackAllowed: true, failures: 0 });
		expect(status.budget).toBe(BUDGET);
	});

	it('opens after a run of failures, and an open breaker forbids the fallback hop', async () => {
		const t = setup();
		const status = await failTimes(t, BUDGET);
		expect(status).toMatchObject({ state: 'open', fallbackAllowed: false });
		expect(status!.failures).toBe(BUDGET);
	});

	it('forbids the hop from half_open too — recovery is confirmed before it costs money', async () => {
		const t = setup();
		// Past half the budget but not exhausted: the hop is already off.
		const status = await failTimes(t, BUDGET * DECISION_BREAKER_CLOSE_FRACTION + 1);
		expect(status).toMatchObject({ state: 'half_open', fallbackAllowed: false });
	});

	it('leaves the hop alone while the budget is mostly intact', async () => {
		const t = setup();
		const status = await failTimes(t, 3);
		expect(status).toMatchObject({ state: 'closed', fallbackAllowed: true, failures: 3 });
	});

	it('never throws when a failure arrives with the budget already gone', async () => {
		const t = setup();
		await failTimes(t, BUDGET);
		// A breaker that threw on the way to reporting a failure would turn one
		// outage into two.
		const status = await failTimes(t, 5);
		expect(status).toMatchObject({ state: 'open', fallbackAllowed: false });
	});

	it('stays open while failures keep arriving, however long the outage runs', async () => {
		const t = setup();
		await failTimes(t, BUDGET);

		vi.useFakeTimers();
		// The failure that lands after the budget is gone writes NOTHING (the
		// component only records a charge it accepted), which is why the breaker
		// cannot ask "when did we last see a failure" and does not try to. A minute
		// into a continuing outage, less than half the budget has refilled, so the
		// hop is still off.
		for (let elapsed = 5_000; elapsed <= 60_000; elapsed += 5_000) {
			vi.setSystemTime(Date.now() + 5_000);
			await failTimes(t, 3);
		}

		const status = await t.query(internal.decision.breaker.status, {});
		expect(status.fallbackAllowed).toBe(false);
		expect(status.state).not.toBe('closed');
	});

	it('closes on its own as the budget refills, which is the only way back', async () => {
		const t = setup();
		await failTimes(t, BUDGET);

		vi.useFakeTimers();
		// The bucket refills at 2/min, so half the budget is back after five
		// minutes — the point the hysteresis closes at.
		vi.setSystemTime(Date.now() + 5 * 60_000 + 1_000);

		const status = await t.query(internal.decision.breaker.status, {});
		expect(status).toMatchObject({ state: 'closed', fallbackAllowed: true });
	});
});
