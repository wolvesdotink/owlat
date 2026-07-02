import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	usePostboxGhostText,
	type GhostTextRequestInput,
} from '../usePostboxGhostText';

const INPUT: GhostTextRequestInput = {
	threadContext: 'ctx',
	draftSoFar: 'Thanks, I',
	cursorSentence: 'Thanks, I',
};
const getInput = () => INPUT;

/** A requestCompletion fake whose in-flight promise the test resolves by hand. */
function deferredFetch(result = ' will get to it today.') {
	let resolve!: (v: string) => void;
	let capturedSignal: AbortSignal | undefined;
	const fn = vi.fn((_input: GhostTextRequestInput, signal: AbortSignal) => {
		capturedSignal = signal;
		return new Promise<string>((r) => {
			resolve = r;
		});
	});
	return {
		fn,
		flush: async () => {
			resolve(result);
			await Promise.resolve();
			await Promise.resolve();
		},
		signal: () => capturedSignal,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('usePostboxGhostText', () => {
	it('a typing pause issues exactly one request and shows the ghost', async () => {
		const fetcher = deferredFetch();
		const gt = usePostboxGhostText({
			enabled: () => true,
			requestCompletion: fetcher.fn,
			onAccept: vi.fn(),
		});

		gt.schedule(getInput);
		expect(fetcher.fn).not.toHaveBeenCalled(); // still within the debounce
		vi.advanceTimersByTime(450);
		expect(fetcher.fn).toHaveBeenCalledTimes(1);

		await fetcher.flush();
		expect(gt.ghost.value).toBe(' will get to it today.');
		expect(gt.hasGhost()).toBe(true);
	});

	it('does nothing when disabled', () => {
		const fetcher = deferredFetch();
		const gt = usePostboxGhostText({
			enabled: () => false,
			requestCompletion: fetcher.fn,
			onAccept: vi.fn(),
		});
		gt.schedule(getInput);
		vi.advanceTimersByTime(1000);
		expect(fetcher.fn).not.toHaveBeenCalled();
	});

	it('a keystroke mid-flight aborts the request and shows no ghost', async () => {
		const fetcher = deferredFetch();
		const gt = usePostboxGhostText({
			enabled: () => true,
			requestCompletion: fetcher.fn,
			onAccept: vi.fn(),
		});

		gt.schedule(getInput);
		vi.advanceTimersByTime(450);
		expect(fetcher.fn).toHaveBeenCalledTimes(1);

		// User types again before the response arrives.
		gt.cancel();
		expect(fetcher.signal()?.aborted).toBe(true);

		// The late response must be dropped — no ghost appears.
		await fetcher.flush();
		expect(gt.ghost.value).toBe('');
		expect(gt.hasGhost()).toBe(false);
	});

	it('Tab accept: inserts the suggestion, clears the ghost, reports handled', async () => {
		const fetcher = deferredFetch(' will follow up.');
		const onAccept = vi.fn();
		const gt = usePostboxGhostText({
			enabled: () => true,
			requestCompletion: fetcher.fn,
			onAccept,
		});

		gt.schedule(getInput);
		vi.advanceTimersByTime(450);
		await fetcher.flush();
		expect(gt.hasGhost()).toBe(true);

		expect(gt.accept()).toBe(true);
		expect(onAccept).toHaveBeenCalledWith(' will follow up.');
		expect(gt.ghost.value).toBe('');

		// A second accept with nothing shown is a no-op (Tab falls through).
		expect(gt.accept()).toBe(false);
		expect(onAccept).toHaveBeenCalledTimes(1);
	});

	it('Esc / cancel dismisses the shown ghost', async () => {
		const fetcher = deferredFetch();
		const gt = usePostboxGhostText({
			enabled: () => true,
			requestCompletion: fetcher.fn,
			onAccept: vi.fn(),
		});
		gt.schedule(getInput);
		vi.advanceTimersByTime(450);
		await fetcher.flush();
		expect(gt.hasGhost()).toBe(true);

		gt.cancel();
		expect(gt.ghost.value).toBe('');
	});

	it('honors the >=1s client-side rate limit between requests', async () => {
		const fetcher = deferredFetch();
		const gt = usePostboxGhostText({
			enabled: () => true,
			requestCompletion: fetcher.fn,
			onAccept: vi.fn(),
		});

		// First pause -> request at t=450.
		gt.schedule(getInput);
		vi.advanceTimersByTime(450);
		expect(fetcher.fn).toHaveBeenCalledTimes(1);
		await fetcher.flush();

		// Second pause fires ~450ms later — still inside the 1s window: dropped.
		gt.schedule(getInput);
		vi.advanceTimersByTime(450);
		expect(fetcher.fn).toHaveBeenCalledTimes(1);

		// Once a full second has elapsed since the first request, a new pause fires.
		vi.advanceTimersByTime(600); // now well past t0+1000
		gt.schedule(getInput);
		vi.advanceTimersByTime(450);
		expect(fetcher.fn).toHaveBeenCalledTimes(2);
	});
});
