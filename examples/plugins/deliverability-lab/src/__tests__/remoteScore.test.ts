import { describe, expect, it } from 'vitest';
import {
	localFallbackScore,
	parseScoreHookResult,
	scoreDeliverability,
	SCORE_HOOK_REASON_MAX_LENGTH,
	type RemoteScoreHook,
	type ScoreDeliverabilityOptions,
} from '../remoteScore';
import { CLEAN_EMAIL, SPAMMY_EMAIL } from './fixtures';

/** A timer that never fires — the deadline stays pending so the hook always wins. */
const NEVER_TIMER: Pick<ScoreDeliverabilityOptions, 'setTimer' | 'clearTimer'> = {
	setTimer: () => 0,
	clearTimer: () => undefined,
};

/** A timer that fires immediately — forces the deadline branch deterministically. */
const IMMEDIATE_TIMER: Pick<ScoreDeliverabilityOptions, 'setTimer' | 'clearTimer'> = {
	setTimer: (callback) => {
		callback();
		return 0;
	},
	clearTimer: () => undefined,
};

describe('parseScoreHookResult', () => {
	it('accepts a bounded score and an optional reason', () => {
		expect(parseScoreHookResult({ score: 0.42 })).toEqual({ score: 0.42 });
		expect(parseScoreHookResult({ score: 0.9, reason: 'shouty subject' })).toEqual({
			score: 0.9,
			reason: 'shouty subject',
		});
	});

	it('strips control characters and clamps an over-long reason', () => {
		const parsed = parseScoreHookResult({ score: 0.5, reason: `a\x00b${'x'.repeat(500)}` });
		expect(parsed?.reason).not.toContain('\x00');
		expect((parsed?.reason ?? '').length).toBeLessThanOrEqual(SCORE_HOOK_REASON_MAX_LENGTH);
	});

	it.each([
		['null', null],
		['an array', [{ score: 0.5 }]],
		['a non-number score', { score: 'high' }],
		['an out-of-range score', { score: 1.5 }],
		['a negative score', { score: -0.1 }],
		['a NaN score', { score: Number.NaN }],
		['a missing score', { reason: 'no score here' }],
		['a non-string reason', { score: 0.5, reason: 5 }],
	])('rejects %s by failing closed to null', (_label, value) => {
		expect(parseScoreHookResult(value)).toBeNull();
	});

	it('rejects an inherited score that is not an own property', () => {
		expect(parseScoreHookResult(Object.create({ score: 0.5 }))).toBeNull();
	});
});

describe('scoreDeliverability', () => {
	const options = (
		hook: RemoteScoreHook | undefined,
		signal: AbortSignal
	): ScoreDeliverabilityOptions => ({ hook, deadlineMs: 5_000, signal, ...NEVER_TIMER });

	it('uses the local engine when no hook is configured', async () => {
		const result = await scoreDeliverability(
			SPAMMY_EMAIL,
			options(undefined, new AbortController().signal)
		);
		expect(result.source).toBe('fallback');
		expect(result).toEqual(localFallbackScore(SPAMMY_EMAIL));
	});

	it('falls back immediately when the signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const hook: RemoteScoreHook = async () => ({ score: 0.9 });
		const result = await scoreDeliverability(CLEAN_EMAIL, options(hook, controller.signal));
		expect(result.source).toBe('fallback');
	});

	it('prefers a valid remote score', async () => {
		const hook: RemoteScoreHook = async () => ({ score: 0.73, reason: 'vendor flagged' });
		const result = await scoreDeliverability(
			CLEAN_EMAIL,
			options(hook, new AbortController().signal)
		);
		expect(result).toEqual({ score: 0.73, source: 'remote', reason: 'vendor flagged' });
	});

	it('falls back to the local score when the remote response is malformed', async () => {
		const hook: RemoteScoreHook = async () => ({ score: 'not a number' });
		const result = await scoreDeliverability(
			SPAMMY_EMAIL,
			options(hook, new AbortController().signal)
		);
		expect(result.source).toBe('fallback');
	});

	it('falls back when the remote hook rejects', async () => {
		const hook: RemoteScoreHook = async () => {
			throw new Error('vendor down');
		};
		const result = await scoreDeliverability(
			CLEAN_EMAIL,
			options(hook, new AbortController().signal)
		);
		expect(result.source).toBe('fallback');
	});

	it('falls back when the remote hook exceeds its deadline', async () => {
		const hook: RemoteScoreHook = () => new Promise<unknown>(() => undefined);
		const result = await scoreDeliverability(CLEAN_EMAIL, {
			hook,
			deadlineMs: 5_000,
			signal: new AbortController().signal,
			...IMMEDIATE_TIMER,
		});
		expect(result.source).toBe('fallback');
	});
});
