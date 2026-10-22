import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	onSlowEpisodeEnd,
	registerUnsavedWorkProbe,
	resetPendingOperations,
	slowOperations,
	SLOW_OPERATION_MS,
	trackPendingOperation,
	type SlowEpisodeOutcome,
} from '../pendingOperations';

let outcomes: SlowEpisodeOutcome[];
let stopListening: () => void;

beforeEach(() => {
	vi.useFakeTimers();
	outcomes = [];
	stopListening = onSlowEpisodeEnd((outcome) => outcomes.push(outcome));
});
afterEach(() => {
	stopListening();
	resetPendingOperations();
	vi.useRealTimers();
});

const labels = () => slowOperations.value.map((op) => op.label);

describe('pending operations', () => {
	it('lists nothing before the threshold and the run after it', () => {
		trackPendingOperation(() => 'Archive');

		vi.advanceTimersByTime(SLOW_OPERATION_MS - 1);
		expect(slowOperations.value).toEqual([]);

		vi.advanceTimersByTime(1);
		expect(labels()).toEqual(['Archive']);
	});

	it('a fast write never becomes slow and ends no episode', () => {
		const settle = trackPendingOperation(() => 'Archive');
		settle(true);
		vi.advanceTimersByTime(SLOW_OPERATION_MS * 2);

		expect(slowOperations.value).toEqual([]);
		expect(outcomes).toEqual([]);
	});

	it('settles overlapping runs of one operation independently', () => {
		const first = trackPendingOperation(() => 'Save');
		const second = trackPendingOperation(() => 'Save');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		expect(labels()).toEqual(['Save', 'Save']);

		first(true);
		expect(labels()).toEqual(['Save']);
		expect(outcomes).toEqual([]);

		second(true);
		expect(slowOperations.value).toEqual([]);
		expect(outcomes).toEqual(['saved']);
	});

	it('confirms once, only after every pending write has landed', () => {
		const slow = trackPendingOperation(() => 'Save');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		// Still waiting, not slow yet: "all saved" would be a lie while it is out.
		const late = trackPendingOperation(() => 'Rename');

		slow(true);
		expect(slowOperations.value).toEqual([]);
		expect(outcomes).toEqual([]);

		late(true);
		expect(outcomes).toEqual(['saved']);
		late(true);
		expect(outcomes).toEqual(['saved']);
	});

	it('a failure in the episode ends it without a saved outcome', () => {
		const a = trackPendingOperation(() => 'Save');
		const b = trackPendingOperation(() => 'Save');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);

		a(false);
		b(true);

		expect(outcomes).toEqual(['failed']);
	});

	it('another queue holding unsent work vetoes "saved"', () => {
		let queued = true;
		const unregister = registerUnsavedWorkProbe(() => queued);
		try {
			const settle = trackPendingOperation(() => 'Save');
			vi.advanceTimersByTime(SLOW_OPERATION_MS);
			settle(true);
			expect(outcomes).toEqual(['unconfirmed']);

			queued = false;
			const next = trackPendingOperation(() => 'Save');
			vi.advanceTimersByTime(SLOW_OPERATION_MS);
			next(true);
			expect(outcomes).toEqual(['unconfirmed', 'saved']);
		} finally {
			unregister();
		}
	});

	it('resolves the label when it publishes, so a locale change shows', () => {
		let label = 'Archive';
		trackPendingOperation(() => label);
		label = 'Archivieren';
		vi.advanceTimersByTime(SLOW_OPERATION_MS);

		expect(labels()).toEqual(['Archivieren']);
	});

	it('a reset forgets every run: no notice, no outcome, late settles ignored', () => {
		const settle = trackPendingOperation(() => 'Save');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);

		resetPendingOperations();
		expect(slowOperations.value).toEqual([]);
		settle(true);

		expect(outcomes).toEqual([]);
	});

	it('a run reset before its threshold never turns slow', () => {
		trackPendingOperation(() => 'Save');
		resetPendingOperations();
		vi.advanceTimersByTime(SLOW_OPERATION_MS);

		expect(slowOperations.value).toEqual([]);
	});
});
