import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watch } from 'vue';
import {
	EPISODE_QUIET_MS,
	hasPendingWork,
	holdPendingWork,
	onSlowEpisodeEnd,
	registerUnsavedWorkProbe,
	resetPendingOperations,
	scheduledWriteHold,
	slowOperationCount,
	slowOperations,
	SLOW_OPERATION_MS,
	trackPendingOperation,
	withPendingHold,
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
/** Let the quiet period after the last settle run out. */
const quiet = () => vi.advanceTimersByTime(EPISODE_QUIET_MS);

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
		quiet();
		expect(outcomes).toEqual([]);

		second(true);
		expect(slowOperations.value).toEqual([]);
		quiet();
		expect(outcomes).toEqual(['saved']);
	});

	it('confirms once, only after every pending write has landed', () => {
		const slow = trackPendingOperation(() => 'Save');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		// Still waiting, not slow yet: "all saved" would be a lie while it is out.
		const late = trackPendingOperation(() => 'Rename');

		slow(true);
		expect(slowOperations.value).toEqual([]);
		quiet();
		expect(outcomes).toEqual([]);

		late(true);
		quiet();
		expect(outcomes).toEqual(['saved']);
		late(true);
		quiet();
		expect(outcomes).toEqual(['saved']);
	});

	it('a failure in the episode ends it without a saved outcome', () => {
		const a = trackPendingOperation(() => 'Save');
		const b = trackPendingOperation(() => 'Save');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);

		a(false);
		b(true);
		quiet();

		expect(outcomes).toEqual(['failed']);
	});

	it('a failure before the other run turned slow still vetoes "saved"', () => {
		const failing = trackPendingOperation(() => 'Rename');
		const slow = trackPendingOperation(() => 'Save');
		vi.advanceTimersByTime(SLOW_OPERATION_MS - 1);
		failing(false);

		vi.advanceTimersByTime(1);
		expect(labels()).toEqual(['Save']);
		slow(true);
		quiet();

		expect(outcomes).toEqual(['failed']);
	});

	it('a failure followed within the quiet period by a slow write still vetoes "saved"', () => {
		const failing = trackPendingOperation(() => 'Rename');
		failing(false);
		vi.advanceTimersByTime(EPISODE_QUIET_MS - 1);
		const slow = trackPendingOperation(() => 'Save');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		slow(true);
		quiet();

		expect(outcomes).toEqual(['failed']);
	});

	it('a failure is forgotten once the registry has been idle for the quiet period', () => {
		const failing = trackPendingOperation(() => 'Rename');
		failing(false);
		quiet();
		expect(outcomes).toEqual([]);

		const slow = trackPendingOperation(() => 'Save');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		slow(true);
		quiet();

		expect(outcomes).toEqual(['saved']);
	});

	it('a failed hold before anything turned slow vetoes "saved"', () => {
		const slow = trackPendingOperation(() => 'Save');
		const release = holdPendingWork();
		release(false);
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		slow(true);
		quiet();

		expect(outcomes).toEqual(['failed']);
	});

	it('another queue holding unsent work vetoes "saved"', () => {
		let queued = true;
		const unregister = registerUnsavedWorkProbe(() => queued);
		try {
			const settle = trackPendingOperation(() => 'Save');
			vi.advanceTimersByTime(SLOW_OPERATION_MS);
			settle(true);
			quiet();
			expect(outcomes).toEqual(['unconfirmed']);

			queued = false;
			const next = trackPendingOperation(() => 'Save');
			vi.advanceTimersByTime(SLOW_OPERATION_MS);
			next(true);
			quiet();
			expect(outcomes).toEqual(['unconfirmed', 'saved']);
		} finally {
			unregister();
		}
	});

	it('resolves the label when the list is read, so a locale change shows', () => {
		let label = 'Archive';
		trackPendingOperation(() => label);
		label = 'Archivieren';
		vi.advanceTimersByTime(SLOW_OPERATION_MS);

		expect(labels()).toEqual(['Archivieren']);
	});

	it('marks a hundred simultaneous slow runs in one pass and resolves no label until read', () => {
		let resolutions = 0;
		const settles = Array.from({ length: 100 }, () =>
			trackPendingOperation(() => {
				resolutions += 1;
				return 'Upload';
			})
		);
		const counts: number[] = [];
		const stop = watchCount(counts);
		try {
			vi.advanceTimersByTime(SLOW_OPERATION_MS);
			expect(slowOperationCount.value).toBe(100);
			expect(resolutions).toBe(0);

			expect(slowOperations.value).toHaveLength(100);
			expect(slowOperations.value).toHaveLength(100);
			expect(resolutions).toBe(100);

			for (const settle of settles) settle(true);
			expect(slowOperationCount.value).toBe(0);
			expect(resolutions).toBe(100);
		} finally {
			stop();
		}
		// One publication for the hundred crossing together, one per settle.
		expect(counts).toEqual([100, ...Array.from({ length: 100 }, (_, i) => 99 - i)]);
	});

	it('runs started at different times turn slow at their own threshold', () => {
		trackPendingOperation(() => 'First');
		vi.advanceTimersByTime(1_000);
		trackPendingOperation(() => 'Second');

		vi.advanceTimersByTime(SLOW_OPERATION_MS - 1_000);
		expect(labels()).toEqual(['First']);

		vi.advanceTimersByTime(1_000);
		expect(labels()).toEqual(['First', 'Second']);
	});

	it('a write that follows within the quiet period continues the episode', () => {
		const first = trackPendingOperation(() => 'Upload');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		first(true);

		vi.advanceTimersByTime(EPISODE_QUIET_MS - 1);
		const next = trackPendingOperation(() => 'Register file');
		vi.advanceTimersByTime(EPISODE_QUIET_MS);
		expect(outcomes).toEqual([]);

		next(false);
		quiet();
		expect(outcomes).toEqual(['failed']);
	});

	it('a hold keeps the episode open without being listed, and its failure counts', () => {
		const slow = trackPendingOperation(() => 'Save');
		const release = holdPendingWork();
		vi.advanceTimersByTime(SLOW_OPERATION_MS * 2);
		expect(labels()).toEqual(['Save']);

		slow(true);
		quiet();
		expect(outcomes).toEqual([]);

		release(false);
		quiet();
		expect(outcomes).toEqual(['failed']);
	});

	it('a hold alone never starts an episode', () => {
		const release = holdPendingWork();
		vi.advanceTimersByTime(SLOW_OPERATION_MS * 2);
		release(true);
		quiet();

		expect(slowOperationCount.value).toBe(0);
		expect(outcomes).toEqual([]);
	});

	it('withPendingHold releases as failed when the work throws', async () => {
		const slow = trackPendingOperation(() => 'Save');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		const work = withPendingHold(() => Promise.reject(new Error('upload failed')));
		slow(true);
		await expect(work).rejects.toThrow('upload failed');
		quiet();

		expect(outcomes).toEqual(['failed']);
	});

	it('a scheduled write holds the episode open from arming until its write settles', () => {
		const slow = trackPendingOperation(() => 'Save draft');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		const hold = scheduledWriteHold();
		// Re-arming the debounce on every keystroke takes the hold once.
		hold.set(true);
		hold.set(true);

		slow(true);
		quiet();
		expect(outcomes).toEqual([]);

		// The timer fires: its write takes the hold over and settles it.
		const release = hold.take();
		hold.set(false);
		const write = trackPendingOperation(() => 'Save draft');
		write(true);
		release(true);
		quiet();
		expect(outcomes).toEqual(['saved']);
	});

	it('a scheduled write that fails vetoes "saved"; a dropped schedule does not', () => {
		const hold = scheduledWriteHold();
		const slow = trackPendingOperation(() => 'Save draft');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		hold.set(true);
		slow(true);
		hold.take()(false);
		quiet();
		expect(outcomes).toEqual(['failed']);

		const again = trackPendingOperation(() => 'Save draft');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		hold.set(true);
		again(true);
		hold.set(false);
		quiet();
		expect(outcomes).toEqual(['failed', 'saved']);
	});

	it('a reset forgets every run and says so: late settles are ignored', () => {
		const settle = trackPendingOperation(() => 'Save');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);

		resetPendingOperations();
		expect(slowOperations.value).toEqual([]);
		expect(slowOperationCount.value).toBe(0);
		settle(true);
		quiet();

		expect(outcomes).toEqual(['discarded']);
	});

	it('says whether anything is still unacknowledged: a run, a hold or a probe', () => {
		expect(hasPendingWork()).toBe(false);
		const settle = trackPendingOperation(() => 'Save');
		expect(hasPendingWork()).toBe(true);
		settle(true);
		expect(hasPendingWork()).toBe(false);

		const release = holdPendingWork();
		expect(hasPendingWork()).toBe(true);
		release(false);
		expect(hasPendingWork()).toBe(false);

		let unsent = true;
		const unregister = registerUnsavedWorkProbe(() => unsent);
		try {
			expect(hasPendingWork()).toBe(true);
			unsent = false;
			expect(hasPendingWork()).toBe(false);
		} finally {
			unregister();
		}
	});

	it('a run reset before its threshold never turns slow', () => {
		trackPendingOperation(() => 'Save');
		resetPendingOperations();
		vi.advanceTimersByTime(SLOW_OPERATION_MS);

		expect(slowOperations.value).toEqual([]);
	});
});

/** Record every value the count is published with (a sync watcher sees each one). */
function watchCount(into: number[]) {
	return watch(slowOperationCount, (count) => into.push(count), { flush: 'sync' });
}
