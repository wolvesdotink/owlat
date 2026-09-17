import { describe, it, expect } from 'vitest';
import { boundedDeferDelayMs } from '../deferPolicy.js';

const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;

describe('boundedDeferDelayMs', () => {
	it('passes a delay through untouched while it fits in the lifetime', () => {
		expect(boundedDeferDelayMs(300_000, FOUR_DAYS_MS)).toBe(300_000);
	});

	it('pulls a delay that would outlive the message back to its deadline', () => {
		expect(boundedDeferDelayMs(FOUR_DAYS_MS * 200, 600_000)).toBe(600_000);
	});

	it.each([
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
		['zero', 0],
		['negative', -1],
	])('turns a %s delay into a real wait rather than a queue score', (_label, delayMs) => {
		// `0` is the immediate re-enqueue that is the runaway ladder, and `NaN`
		// reaches GroupMQ as a `:delayed` ZSET score.
		const bounded = boundedDeferDelayMs(delayMs, FOUR_DAYS_MS);
		expect(Number.isFinite(bounded)).toBe(true);
		expect(bounded).toBe(60_000);
	});

	it('falls back to the minimum when the remaining lifetime is unreadable', () => {
		expect(boundedDeferDelayMs(300_000, Number.NaN)).toBe(60_000);
	});
});
