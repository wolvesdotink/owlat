import { describe, it, expect } from 'vitest';
import {
	compareReplyQueueItems,
	replyQueueHeadline,
	formatReplyQueueDueHint,
} from '../postboxReplyQueue';

const item = (urgency: 'high' | 'normal' | 'low', receivedAt: number) => ({
	urgency,
	receivedAt,
});

describe('compareReplyQueueItems', () => {
	it('ranks by urgency first: high before normal before low', () => {
		const sorted = [item('low', 1000), item('high', 3000), item('normal', 2000)].sort(
			compareReplyQueueItems
		);
		expect(sorted.map((i) => i.urgency)).toEqual(['high', 'normal', 'low']);
	});

	it('breaks urgency ties by age — longest-waiting (oldest) first', () => {
		const sorted = [item('normal', 3000), item('normal', 1000), item('normal', 2000)].sort(
			compareReplyQueueItems
		);
		expect(sorted.map((i) => i.receivedAt)).toEqual([1000, 2000, 3000]);
	});

	it('a fresh high-urgency item outranks an old normal one', () => {
		expect(compareReplyQueueItems(item('high', 9000), item('normal', 1))).toBeLessThan(0);
	});

	it('ranks by priority score, not urgency: a VIP terse note beats a wordy stranger', () => {
		// Terse VIP note (low urgency, high score) must sort before a wordy
		// stranger (high urgency, low score) — the whole point of the score.
		const vipTerse = { urgency: 'low' as const, receivedAt: 5000, priorityScore: 68 };
		const strangerWordy = { urgency: 'high' as const, receivedAt: 1000, priorityScore: 40 };
		const sorted = [strangerWordy, vipTerse].sort(compareReplyQueueItems);
		expect(sorted[0]).toBe(vipTerse);
		expect(compareReplyQueueItems(vipTerse, strangerWordy)).toBeLessThan(0);
	});

	it('breaks score ties by age — longest-waiting (oldest) first', () => {
		const a = { urgency: 'normal' as const, receivedAt: 3000, priorityScore: 60 };
		const b = { urgency: 'normal' as const, receivedAt: 1000, priorityScore: 60 };
		const sorted = [a, b].sort(compareReplyQueueItems);
		expect(sorted.map((i) => i.receivedAt)).toEqual([1000, 3000]);
	});

	it('falls back to the urgency bucket when a row has no priority score', () => {
		// A scored VIP row (85) outranks an unscored high-urgency row (fallback 100)?
		// No — 100 > 85, so the unscored high row wins; mixed rows stay comparable.
		const scoredVip = { urgency: 'low' as const, receivedAt: 1000, priorityScore: 85 };
		const unscoredHigh = { urgency: 'high' as const, receivedAt: 1000 };
		expect(compareReplyQueueItems(unscoredHigh, scoredVip)).toBeLessThan(0);
	});
});

describe('replyQueueHeadline', () => {
	it('uses the AI askSummary when present', () => {
		expect(replyQueueHeadline({ askSummary: 'Wants the Q3 numbers', subject: 'Re: numbers' })).toBe(
			'Wants the Q3 numbers'
		);
	});

	it('falls back to the subject when askSummary is absent (deterministic mode)', () => {
		expect(replyQueueHeadline({ subject: 'Quarterly numbers' })).toBe('Quarterly numbers');
	});

	it('falls back to the subject when askSummary is blank', () => {
		expect(replyQueueHeadline({ askSummary: '  ', subject: 'Quarterly numbers' })).toBe(
			'Quarterly numbers'
		);
	});

	it('labels a missing subject', () => {
		expect(replyQueueHeadline({ subject: '' })).toBe('(no subject)');
	});

	it('inverts the framing for follow-up items using waitingOn', () => {
		expect(
			replyQueueHeadline({ kind: 'followup', subject: 'Re: proposal', waitingOn: 'Dana' })
		).toBe("You're waiting on Dana");
	});

	it('falls back to fromAddress when a follow-up has no waitingOn', () => {
		expect(
			replyQueueHeadline({
				kind: 'followup',
				subject: 'Re: proposal',
				fromAddress: 'dana@acme.test',
			})
		).toBe("You're waiting on dana@acme.test");
	});

	it('falls back to a generic follow-up headline when waitingOn is blank and no fromAddress', () => {
		expect(
			replyQueueHeadline({ kind: 'followup', subject: 'Re: proposal', waitingOn: '   ' })
		).toBe("You're waiting on a reply");
	});
});

describe('formatReplyQueueDueHint', () => {
	it('formats an ISO date as a short due label (timezone-independent)', () => {
		// Must be the stated calendar date in EVERY runner timezone — a
		// west-of-UTC machine used to render "Due Jul 2" for a Jul 3 deadline.
		expect(formatReplyQueueDueHint('2026-07-03')).toBe('Due Jul 3');
	});

	it('returns null for missing or unparseable hints', () => {
		expect(formatReplyQueueDueHint(undefined)).toBeNull();
		expect(formatReplyQueueDueHint('whenever you can')).toBeNull();
	});
});
