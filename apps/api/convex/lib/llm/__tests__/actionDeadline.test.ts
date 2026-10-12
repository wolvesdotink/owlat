/**
 * One model budget per action (ADR-0073): every call in an action spends from
 * the same deadline, a nested action inherits the caller's, and scheduled work
 * keeps the root id but gets a fresh clock.
 */

import { describe, expect, it } from 'vitest';
import {
	ACTION_MODEL_BUDGET_MS,
	anchorActionDeadline,
	boundedRoot,
	callDeadlineAt,
	scheduledRoot,
} from '../actionDeadline';

describe('action deadline', () => {
	it('anchors once per action and keeps the anchor for every later call', () => {
		const ctx = {};
		const first = anchorActionDeadline(ctx, 1_000);
		expect(first).toBe(1_000 + ACTION_MODEL_BUDGET_MS);
		expect(anchorActionDeadline(ctx, 500_000)).toBe(first);
		expect(callDeadlineAt(ctx, undefined)).toBe(first);
		// Another action has its own clock.
		expect(anchorActionDeadline({}, 2_000)).toBe(2_000 + ACTION_MODEL_BUDGET_MS);
	});

	it('stays inside the 600 s action limit with time to write the ledger', () => {
		expect(ACTION_MODEL_BUDGET_MS).toBeLessThanOrEqual(600_000 - 60_000);
	});

	it('bounds a root for a nested action by the tighter deadline', () => {
		const ctx = {};
		const anchor = anchorActionDeadline(ctx, 0);
		expect(boundedRoot(ctx, { rootRequestId: 'team:m' })).toEqual({
			rootRequestId: 'team:m',
			deadlineAt: anchor,
		});
		expect(boundedRoot(ctx, { rootRequestId: 'team:m', deadlineAt: 10 }).deadlineAt).toBe(10);
	});

	it('hands scheduled work the root id without the deadline', () => {
		expect(scheduledRoot({ rootRequestId: 'file:f', parentCallId: 'p', deadlineAt: 5 })).toEqual({
			rootRequestId: 'file:f',
			parentCallId: 'p',
		});
	});
});
