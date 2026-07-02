import { describe, it, expect, vi } from 'vitest';
import {
	usePostboxSelectionRewrite,
	isRewriteEligible,
	countWords,
	MIN_REWRITE_WORDS,
	type SelectionRewriteInput,
} from '../usePostboxSelectionRewrite';

const INPUT: SelectionRewriteInput = {
	selection: 'please advise on the matter',
	intent: 'shorter',
	surroundingContext: 'ctx',
};

/** A requestRewrite fake whose in-flight promise the test resolves by hand. */
function deferredRewrite() {
	let resolve!: (v: string) => void;
	let reject!: (e: unknown) => void;
	let capturedSignal: AbortSignal | undefined;
	const fn = vi.fn((_input: SelectionRewriteInput, signal: AbortSignal) => {
		capturedSignal = signal;
		return new Promise<string>((res, rej) => {
			resolve = res;
			reject = rej;
		});
	});
	return {
		fn,
		resolveWith: async (v: string) => {
			resolve(v);
			await Promise.resolve();
			await Promise.resolve();
		},
		rejectWith: async (e: unknown) => {
			reject(e);
			await Promise.resolve();
			await Promise.resolve();
		},
		signal: () => capturedSignal,
	};
}

describe('visibility rules', () => {
	it('counts whitespace-delimited words', () => {
		expect(countWords('')).toBe(0);
		expect(countWords('   ')).toBe(0);
		expect(countWords('one')).toBe(1);
		expect(countWords('  one   two three ')).toBe(3);
	});

	it('hides for a short selection even when AI is enabled', () => {
		// MIN_REWRITE_WORDS is 3, so a two-word phrase is ineligible.
		expect(MIN_REWRITE_WORDS).toBe(3);
		expect(isRewriteEligible(true, 'hi there')).toBe(false);
		expect(isRewriteEligible(true, 'hello there friend')).toBe(true);
	});

	it('hides entirely when AI is disabled, regardless of length', () => {
		expect(isRewriteEligible(false, 'a nice long enough selection here')).toBe(false);
	});
});

describe('usePostboxSelectionRewrite lifecycle', () => {
	it('start -> loading -> preview on success', async () => {
		const r = deferredRewrite();
		const rw = usePostboxSelectionRewrite({ requestRewrite: r.fn });

		const p = rw.start(INPUT);
		expect(rw.isLoading()).toBe(true);
		expect(rw.original.value).toBe(INPUT.selection);
		expect(rw.activeIntent.value).toBe('shorter');

		await r.resolveWith('advise on this');
		await p;
		expect(rw.hasPreview()).toBe(true);
		expect(rw.rewritten.value).toBe('advise on this');
	});

	it('takeApplied returns the rewrite and resets to idle', async () => {
		const r = deferredRewrite();
		const rw = usePostboxSelectionRewrite({ requestRewrite: r.fn });
		const p = rw.start(INPUT);
		await r.resolveWith('advise on this');
		await p;

		expect(rw.takeApplied()).toBe('advise on this');
		expect(rw.status.value).toBe('idle');
		expect(rw.rewritten.value).toBe('');
		// A second call with nothing previewed returns null.
		expect(rw.takeApplied()).toBeNull();
	});

	it('aborts the in-flight request and drops its stale response on reset', async () => {
		const r = deferredRewrite();
		const rw = usePostboxSelectionRewrite({ requestRewrite: r.fn });
		const p = rw.start(INPUT);
		expect(rw.isLoading()).toBe(true);

		rw.reset(); // e.g. the selection changed under the request
		expect(r.signal()!.aborted).toBe(true);
		expect(rw.status.value).toBe('idle');

		// A late response for the aborted request must not resurface a preview.
		await r.resolveWith('too late');
		await p;
		expect(rw.hasPreview()).toBe(false);
		expect(rw.status.value).toBe('idle');
	});

	it('a newer start supersedes an older in-flight request on the same instance', async () => {
		// A fetcher that hands back a fresh, hand-resolved promise per call.
		const resolvers: ((v: string) => void)[] = [];
		const signals: AbortSignal[] = [];
		const fn = vi.fn((_input: SelectionRewriteInput, signal: AbortSignal) => {
			signals.push(signal);
			return new Promise<string>((res) => resolvers.push(res));
		});
		const rw = usePostboxSelectionRewrite({ requestRewrite: fn });

		const p1 = rw.start(INPUT);
		const p2 = rw.start({ ...INPUT, intent: 'friendlier' }); // supersedes #1
		expect(signals[0]!.aborted).toBe(true); // the first was aborted
		expect(rw.activeIntent.value).toBe('friendlier');

		// Resolving the stale first request must not surface a preview.
		resolvers[0]!('from first');
		await p1;
		expect(rw.hasPreview()).toBe(false);

		// Resolving the current request wins.
		resolvers[1]!('from second');
		await p2;
		expect(rw.rewritten.value).toBe('from second');
	});

	it('fails soft on error: idle + onError, selection untouched', async () => {
		const r = deferredRewrite();
		const onError = vi.fn();
		const rw = usePostboxSelectionRewrite({ requestRewrite: r.fn, onError });
		const p = rw.start(INPUT);
		await r.rejectWith(new Error('boom'));
		await p;

		expect(rw.status.value).toBe('idle');
		expect(rw.hasPreview()).toBe(false);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it('treats an empty rewrite as no suggestion (idle + onError)', async () => {
		const r = deferredRewrite();
		const onError = vi.fn();
		const rw = usePostboxSelectionRewrite({ requestRewrite: r.fn, onError });
		const p = rw.start(INPUT);
		await r.resolveWith('   ');
		await p;

		expect(rw.status.value).toBe('idle');
		expect(onError).toHaveBeenCalledTimes(1);
	});
});
