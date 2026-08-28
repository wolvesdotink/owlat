/**
 * The bounded LIFO undo stack's eviction/expiry contract. Pure index math, no
 * DOM: what survives a push, what a pop hands back, and what the caller is
 * told to clean up after.
 */
import { describe, it, expect } from 'vitest';
import {
	POSTBOX_UNDO_STACK_LIMIT,
	popUndoEntry,
	pruneUndoStack,
	pushUndoEntry,
} from '../postboxUndoStack';

const NOW = 1_000_000;
const entry = (id: string, expiresAt = NOW + 8_000) => ({ id, expiresAt });

describe('pushUndoEntry', () => {
	it('stacks newest-first', () => {
		const a = entry('a');
		const b = entry('b');
		const first = pushUndoEntry([], a, NOW);
		const second = pushUndoEntry(first.stack, b, NOW);
		expect(second.stack.map((e) => e.id)).toEqual(['b', 'a']);
		expect(second.evicted).toEqual([]);
	});

	it('evicts the oldest entry once the limit is reached', () => {
		let stack = [] as Array<{ id: string; expiresAt: number }>;
		const evictedIds: string[] = [];
		for (let i = 0; i < POSTBOX_UNDO_STACK_LIMIT + 3; i++) {
			const result = pushUndoEntry(stack, entry(`e${i}`), NOW);
			stack = result.stack;
			evictedIds.push(...result.evicted.map((e) => e.id));
		}
		expect(stack).toHaveLength(POSTBOX_UNDO_STACK_LIMIT);
		// The three oldest fell off, newest-first order preserved.
		expect(evictedIds).toEqual(['e0', 'e1', 'e2']);
		expect(stack[0]?.id).toBe(`e${POSTBOX_UNDO_STACK_LIMIT + 2}`);
	});

	it('drops entries past their deadline before it considers the limit', () => {
		const stale = entry('stale', NOW - 1);
		const live = entry('live');
		const result = pushUndoEntry([stale, live], entry('fresh'), NOW);
		expect(result.stack.map((e) => e.id)).toEqual(['fresh', 'live']);
		expect(result.evicted.map((e) => e.id)).toEqual(['stale']);
	});

	it('honours a zero limit literally — even the entry just pushed leaves', () => {
		const result = pushUndoEntry([], entry('a'), NOW, 0);
		expect(result.stack).toEqual([]);
		expect(result.evicted.map((e) => e.id)).toEqual(['a']);
	});
});

describe('pruneUndoStack', () => {
	it('splits live from expired without reordering the survivors', () => {
		const { stack, expired } = pruneUndoStack(
			[entry('c'), entry('b', NOW - 1), entry('a')],
			NOW
		);
		expect(stack.map((e) => e.id)).toEqual(['c', 'a']);
		expect(expired.map((e) => e.id)).toEqual(['b']);
	});

	it('treats a deadline exactly at now as expired', () => {
		const { stack, expired } = pruneUndoStack([entry('a', NOW)], NOW);
		expect(stack).toEqual([]);
		expect(expired.map((e) => e.id)).toEqual(['a']);
	});
});

describe('popUndoEntry', () => {
	it('takes the newest entry and leaves the rest', () => {
		const result = popUndoEntry([entry('c'), entry('b'), entry('a')], NOW);
		expect(result.entry?.id).toBe('c');
		expect(result.stack.map((e) => e.id)).toEqual(['b', 'a']);
		expect(result.expired).toEqual([]);
	});

	it('skips an expired top and reports it for cleanup', () => {
		const result = popUndoEntry([entry('stale', NOW - 1), entry('live')], NOW);
		expect(result.entry?.id).toBe('live');
		expect(result.stack).toEqual([]);
		expect(result.expired.map((e) => e.id)).toEqual(['stale']);
	});

	it('returns nothing for an empty (or entirely expired) stack', () => {
		expect(popUndoEntry([], NOW).entry).toBeNull();
		const allStale = popUndoEntry([entry('a', NOW - 1)], NOW);
		expect(allStale.entry).toBeNull();
		expect(allStale.expired.map((e) => e.id)).toEqual(['a']);
	});
});
