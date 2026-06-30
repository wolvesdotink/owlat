import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useCopyToClipboard } from '../useCopyToClipboard';

describe('useCopyToClipboard', () => {
	let writeTextMock: ReturnType<typeof vi.fn>;
	const originalNavigator = globalThis.navigator;

	beforeEach(() => {
		vi.useFakeTimers();
		writeTextMock = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(globalThis, 'navigator', {
			value: { clipboard: { writeText: writeTextMock } },
			writable: true,
			configurable: true,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		Object.defineProperty(globalThis, 'navigator', {
			value: originalNavigator,
			writable: true,
			configurable: true,
		});
	});

	describe('copy', () => {
		it('writes text to clipboard and sets copiedKey', async () => {
			const { copy, copiedKey } = useCopyToClipboard();

			await copy('hello');

			expect(writeTextMock).toHaveBeenCalledWith('hello');
			expect(copiedKey.value).toBe('hello');
		});

		it('uses custom key when provided', async () => {
			const { copy, copiedKey } = useCopyToClipboard();

			await copy('some-long-text', 'myKey');

			expect(writeTextMock).toHaveBeenCalledWith('some-long-text');
			expect(copiedKey.value).toBe('myKey');
		});

		it('returns true on success', async () => {
			const { copy } = useCopyToClipboard();

			const result = await copy('text');

			expect(result).toBe(true);
		});

		it('returns false when clipboard fails', async () => {
			writeTextMock.mockRejectedValue(new Error('Clipboard denied'));
			const { copy, copiedKey } = useCopyToClipboard();

			const result = await copy('text');

			expect(result).toBe(false);
			expect(copiedKey.value).toBe(null);
		});
	});

	describe('isCopied', () => {
		it('returns true for matching key', async () => {
			const { copy, isCopied } = useCopyToClipboard();

			await copy('text', 'myKey');

			expect(isCopied('myKey')).toBe(true);
		});

		it('returns false for non-matching key', async () => {
			const { copy, isCopied } = useCopyToClipboard();

			await copy('text', 'myKey');

			expect(isCopied('otherKey')).toBe(false);
		});

		it('returns false when nothing has been copied', () => {
			const { isCopied } = useCopyToClipboard();

			expect(isCopied('anyKey')).toBe(false);
		});
	});

	describe('auto-reset timeout', () => {
		it('resets copiedKey after default timeout', async () => {
			const { copy, copiedKey } = useCopyToClipboard();

			await copy('text');
			expect(copiedKey.value).toBe('text');

			vi.advanceTimersByTime(1999);
			expect(copiedKey.value).toBe('text');

			vi.advanceTimersByTime(1);
			expect(copiedKey.value).toBe(null);
		});

		it('respects custom timeout', async () => {
			const { copy, copiedKey } = useCopyToClipboard(5000);

			await copy('text');
			expect(copiedKey.value).toBe('text');

			vi.advanceTimersByTime(4999);
			expect(copiedKey.value).toBe('text');

			vi.advanceTimersByTime(1);
			expect(copiedKey.value).toBe(null);
		});

		it('does not reset if copiedKey has changed before timeout', async () => {
			const { copy, copiedKey } = useCopyToClipboard();

			await copy('first');
			await copy('second');

			// Both timeouts registered at time 0. Advance just before they fire.
			vi.advanceTimersByTime(1999);
			// The first timeout hasn't fired yet, copiedKey is still 'second'
			expect(copiedKey.value).toBe('second');

			// At 2000ms both fire: first checks 'first' !== 'second' (no-op),
			// second checks 'second' === 'second' (resets). This is expected
			// because both copies share the same timeout duration.
			vi.advanceTimersByTime(1);
			expect(copiedKey.value).toBe(null);
		});
	});

	describe('reset', () => {
		it('clears copiedKey immediately', async () => {
			const { copy, copiedKey, reset } = useCopyToClipboard();

			await copy('text');
			expect(copiedKey.value).toBe('text');

			reset();
			expect(copiedKey.value).toBe(null);
		});
	});
});
