/**
 * The throttled stream flusher shared by the assistant runner and Postbox
 * whole-draft revise (lib/llm/streamFlusher.ts).
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createThrottledStreamFlusher } from '../streamFlusher';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
});
afterEach(() => {
	vi.useRealTimers();
});

describe('createThrottledStreamFlusher', () => {
	it('writes at most once per interval, and always on force', async () => {
		const patch = vi.fn(async (_text: string) => ({ stop: false }));
		const stream = createThrottledStreamFlusher({ intervalMs: 100, patch });

		await stream.onText('a');
		await stream.onText('ab');
		expect(patch.mock.calls.map((c) => c[0])).toEqual(['a']);
		expect(stream.text).toBe('ab');

		vi.advanceTimersByTime(100);
		await stream.onText('abc');
		await stream.flush(true);
		expect(patch.mock.calls.map((c) => c[0])).toEqual(['a', 'abc', 'abc']);
		expect(stream.stopRequested).toBe(false);
		expect(stream.signal.aborted).toBe(false);
	});

	it('aborts the stream when a write reports stop', async () => {
		const patch = vi.fn(async (_text: string) => ({ stop: true }));
		const stream = createThrottledStreamFlusher({ intervalMs: 100, patch });

		await stream.onText('partial');
		expect(stream.stopRequested).toBe(true);
		expect(stream.signal.aborted).toBe(true);
	});
});
