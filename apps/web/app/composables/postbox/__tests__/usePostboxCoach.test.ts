import { describe, it, expect, vi } from 'vitest';
import {
	usePostboxCoach,
	isCoachEligible,
	countWords,
	MIN_COACH_WORDS,
	type CoachSuggestion,
} from '../usePostboxCoach';

const WEAK: CoachSuggestion[] = [
	{ category: 'tone', message: 'The tone reads as curt.' },
	{ category: 'missing-answer', message: 'The refund question is unanswered.' },
];

/** A requestCoach fake whose in-flight promise the test resolves by hand. */
function deferredCoach() {
	let resolve!: (v: CoachSuggestion[]) => void;
	let reject!: (e: unknown) => void;
	let capturedSignal: AbortSignal | undefined;
	let capturedDraft: string | undefined;
	const fn = vi.fn((draftText: string, signal: AbortSignal) => {
		capturedSignal = signal;
		capturedDraft = draftText;
		return new Promise<CoachSuggestion[]>((res, rej) => {
			resolve = res;
			reject = rej;
		});
	});
	return {
		fn,
		resolveWith: async (v: CoachSuggestion[]) => {
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
		draft: () => capturedDraft,
	};
}

describe('visibility rules', () => {
	it('counts whitespace-delimited words', () => {
		expect(countWords('')).toBe(0);
		expect(countWords('   ')).toBe(0);
		expect(countWords('  one   two three ')).toBe(3);
	});

	it('hides for a short draft even when AI is enabled', () => {
		expect(MIN_COACH_WORDS).toBe(6);
		expect(isCoachEligible(true, 'thanks a lot friend')).toBe(false);
		expect(isCoachEligible(true, 'thanks a lot for the update I appreciate it')).toBe(true);
	});

	it('hides entirely when AI is disabled, regardless of length', () => {
		expect(isCoachEligible(false, 'this is a long enough draft to normally coach')).toBe(false);
	});
});

describe('usePostboxCoach lifecycle', () => {
	it('run -> loading -> ready with structured suggestions for a weak draft', async () => {
		const c = deferredCoach();
		const coach = usePostboxCoach({ requestCoach: c.fn });

		const p = coach.run('We regret we cannot approve the refund at this time.');
		expect(coach.isLoading()).toBe(true);
		expect(c.draft()).toBe('We regret we cannot approve the refund at this time.');

		await c.resolveWith(WEAK);
		await p;
		expect(coach.isReady()).toBe(true);
		expect(coach.isClean()).toBe(false);
		expect(coach.suggestions.value).toEqual(WEAK);
	});

	it('a clean draft resolves ready with NO suggestions ("looks solid")', async () => {
		const c = deferredCoach();
		const coach = usePostboxCoach({ requestCoach: c.fn });
		const p = coach.run('This is a clean, complete, well-grounded reply.');
		await c.resolveWith([]);
		await p;
		expect(coach.isReady()).toBe(true);
		expect(coach.isClean()).toBe(true);
		expect(coach.suggestions.value).toEqual([]);
	});

	it('never returns or mutates the draft — it only exposes suggestions', async () => {
		const c = deferredCoach();
		const coach = usePostboxCoach({ requestCoach: c.fn });
		// The public surface has no draft/text field — only suggestions.
		expect(Object.keys(coach)).not.toContain('draft');
		expect(Object.keys(coach)).not.toContain('rewritten');
		const p = coach.run('Please find the signed contract attached for your review.');
		await c.resolveWith(WEAK);
		await p;
		expect('draft' in coach).toBe(false);
	});

	it('drops a stale response after reset', async () => {
		const c = deferredCoach();
		const coach = usePostboxCoach({ requestCoach: c.fn });
		const p = coach.run('A high-stakes reply we are about to send to a client.');
		expect(coach.isLoading()).toBe(true);

		coach.reset();
		expect(c.signal()!.aborted).toBe(true);
		expect(coach.status.value).toBe('idle');

		await c.resolveWith(WEAK);
		await p;
		expect(coach.isReady()).toBe(false);
		expect(coach.suggestions.value).toEqual([]);
	});

	it('a newer run supersedes an older in-flight one', async () => {
		const resolvers: ((v: CoachSuggestion[]) => void)[] = [];
		const signals: AbortSignal[] = [];
		const fn = vi.fn((_draft: string, signal: AbortSignal) => {
			signals.push(signal);
			return new Promise<CoachSuggestion[]>((res) => resolvers.push(res));
		});
		const coach = usePostboxCoach({ requestCoach: fn });

		const p1 = coach.run('first high-stakes draft to be superseded now');
		const p2 = coach.run('second high-stakes draft that should win here');
		expect(signals[0]!.aborted).toBe(true);

		resolvers[0]!([{ category: 'tone', message: 'stale' }]);
		await p1;
		expect(coach.isReady()).toBe(false);

		resolvers[1]!(WEAK);
		await p2;
		expect(coach.suggestions.value).toEqual(WEAK);
	});

	it('fails soft on error: idle + onError, no suggestions', async () => {
		const c = deferredCoach();
		const onError = vi.fn();
		const coach = usePostboxCoach({ requestCoach: c.fn, onError });
		const p = coach.run('A legally-sensitive reply we do not want to auto-send.');
		await c.rejectWith(new Error('boom'));
		await p;

		expect(coach.status.value).toBe('idle');
		expect(coach.isReady()).toBe(false);
		expect(coach.suggestions.value).toEqual([]);
		expect(onError).toHaveBeenCalledTimes(1);
	});
});
