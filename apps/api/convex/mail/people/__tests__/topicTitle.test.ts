import { describe, expect, it } from 'vitest';
import {
	RETITLE_GROWTH,
	TOPIC_TITLE_MAX_CHARS,
	isTitleShown,
	normalizeTopicTitle,
	wantsModelTitle,
} from '../topicTitle';

const NOW = 1_800_000_000_000;

describe('normalizeTopicTitle', () => {
	it('drops wrapping quotes, a full stop and extra whitespace', () => {
		expect(normalizeTopicTitle('  "Contract   renewal for 2027."  ')).toBe(
			'Contract renewal for 2027'
		);
		expect(normalizeTopicTitle('„Workshop im Dezember“')).toBe('Workshop im Dezember');
	});

	it('caps the length', () => {
		expect(normalizeTopicTitle('x'.repeat(200))).toHaveLength(TOPIC_TITLE_MAX_CHARS);
	});
});

describe('wantsModelTitle', () => {
	const title = (source: 'ai' | 'user', messageCount: number) => ({
		text: 'sealed',
		source,
		messageCount,
		updatedAt: NOW,
	});

	it('waits for a second message', () => {
		expect(wantsModelTitle({ messageCount: 1 }, NOW)).toBe(false);
		expect(wantsModelTitle({ messageCount: 2 }, NOW)).toBe(true);
	});

	it('never replaces the owner’s title', () => {
		expect(wantsModelTitle({ messageCount: 40, topicTitle: title('user', 2) }, NOW)).toBe(false);
	});

	it('renames a model title only after the thread grew', () => {
		expect(wantsModelTitle({ messageCount: 5, topicTitle: title('ai', 2) }, NOW)).toBe(false);
		expect(
			wantsModelTitle({ messageCount: 2 + RETITLE_GROWTH, topicTitle: title('ai', 2) }, NOW)
		).toBe(true);
	});

	it('asks once while a run is in flight, and again after it went stale', () => {
		expect(wantsModelTitle({ messageCount: 3, topicTitlePendingAt: NOW - 1000 }, NOW)).toBe(false);
		expect(
			wantsModelTitle({ messageCount: 3, topicTitlePendingAt: NOW - 60 * 60 * 1000 }, NOW)
		).toBe(true);
	});

	it('leaves a fenced thread alone', () => {
		expect(wantsModelTitle({ messageCount: 3, interpretationStaleSince: NOW }, NOW)).toBe(false);
	});
});

describe('isTitleShown', () => {
	const sealed = 'sealed' as never;
	it('withdraws the model’s name from a fenced thread and keeps the owner’s', () => {
		const ai = { text: sealed, source: 'ai' as const, messageCount: 2, updatedAt: NOW };
		const user = { ...ai, source: 'user' as const };
		expect(isTitleShown({ topicTitle: ai })).toBe(true);
		expect(isTitleShown({ topicTitle: ai, interpretationStaleSince: NOW })).toBe(false);
		expect(isTitleShown({ topicTitle: user, interpretationStaleSince: NOW })).toBe(true);
		expect(isTitleShown({})).toBe(false);
	});
});
