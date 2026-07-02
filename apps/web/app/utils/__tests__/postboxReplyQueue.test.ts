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
		const sorted = [
			item('low', 1000),
			item('high', 3000),
			item('normal', 2000),
		].sort(compareReplyQueueItems);
		expect(sorted.map((i) => i.urgency)).toEqual(['high', 'normal', 'low']);
	});

	it('breaks urgency ties by age — longest-waiting (oldest) first', () => {
		const sorted = [
			item('normal', 3000),
			item('normal', 1000),
			item('normal', 2000),
		].sort(compareReplyQueueItems);
		expect(sorted.map((i) => i.receivedAt)).toEqual([1000, 2000, 3000]);
	});

	it('a fresh high-urgency item outranks an old normal one', () => {
		expect(compareReplyQueueItems(item('high', 9000), item('normal', 1))).toBeLessThan(0);
	});
});

describe('replyQueueHeadline', () => {
	it('uses the AI askSummary when present', () => {
		expect(
			replyQueueHeadline({ askSummary: 'Wants the Q3 numbers', subject: 'Re: numbers' })
		).toBe('Wants the Q3 numbers');
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
