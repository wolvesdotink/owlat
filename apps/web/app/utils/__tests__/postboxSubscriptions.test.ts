/**
 * Subscriptions panel — the pure half: the last-read column, which selected
 * senders the batch can actually finish, and the partial-failure summary.
 */
import { describe, it, expect } from 'vitest';
import {
	selectableSubscriptionSenders,
	subscriptionBatchSummary,
	subscriptionLastReadMessage,
	summarizeSubscriptionBatch,
	type PostboxSubscriptionOutcome,
	type PostboxSubscriptionSender,
} from '../postboxSubscriptions';

const NOW = Date.UTC(2026, 7, 27);
const DAY = 86_400_000;

function sender(overrides: Partial<PostboxSubscriptionSender> = {}): PostboxSubscriptionSender {
	return {
		senderEmail: 'news@a.example',
		messageCount: 10,
		unreadCount: 2,
		lastReceivedAt: NOW,
		lastReadAt: null,
		method: 'one-click',
		...overrides,
	};
}

describe('subscriptionLastReadMessage', () => {
	it('calls out a sender nothing was ever opened from', () => {
		expect(subscriptionLastReadMessage(null, NOW)).toEqual({
			key: 'shared.postboxSubscriptions.lastRead.never',
			params: { count: 0 },
		});
	});

	it('coarsens into today / days / months / years', () => {
		expect(subscriptionLastReadMessage(NOW - 3600_000, NOW).key).toContain('.today');
		expect(subscriptionLastReadMessage(NOW - 5 * DAY, NOW)).toEqual({
			key: 'shared.postboxSubscriptions.lastRead.days',
			params: { count: 5 },
		});
		expect(subscriptionLastReadMessage(NOW - 200 * DAY, NOW)).toEqual({
			key: 'shared.postboxSubscriptions.lastRead.months',
			params: { count: 6 },
		});
		expect(subscriptionLastReadMessage(NOW - 800 * DAY, NOW)).toEqual({
			key: 'shared.postboxSubscriptions.lastRead.years',
			params: { count: 2 },
		});
	});
});

describe('selectableSubscriptionSenders', () => {
	it('splits the selection into what the batch can and cannot finish', () => {
		const senders = [
			sender({ senderEmail: 'a@x.example', method: 'one-click' }),
			sender({ senderEmail: 'b@x.example', method: 'http' }),
			sender({ senderEmail: 'c@x.example', method: 'mailto' }),
			sender({ senderEmail: 'd@x.example', method: 'one-click' }),
		];
		const picked = new Set(['a@x.example', 'b@x.example', 'c@x.example']);
		expect(selectableSubscriptionSenders(senders, picked)).toEqual({
			oneClick: ['a@x.example'],
			manual: ['b@x.example', 'c@x.example'],
		});
	});

	it('ignores senders that are not selected', () => {
		expect(selectableSubscriptionSenders([sender()], new Set())).toEqual({
			oneClick: [],
			manual: [],
		});
	});
});

function outcome(overrides: Partial<PostboxSubscriptionOutcome> = {}): PostboxSubscriptionOutcome {
	return { senderEmail: 'news@a.example', status: 'unsubscribed', archived: 0, ...overrides };
}

describe('summarizeSubscriptionBatch', () => {
	it('counts every outcome kind and the archived total', () => {
		expect(
			summarizeSubscriptionBatch([
				outcome({ status: 'unsubscribed', archived: 12 }),
				outcome({ status: 'unsubscribed', archived: 3 }),
				outcome({ status: 'failed' }),
				outcome({ status: 'manual' }),
				outcome({ status: 'not_found' }),
			])
		).toEqual({ unsubscribed: 2, failed: 1, manual: 1, notFound: 1, archived: 15 });
	});
});

describe('subscriptionBatchSummary', () => {
	it('reads as a success when every sender was finished', () => {
		const summary = subscriptionBatchSummary(
			summarizeSubscriptionBatch([outcome({ archived: 8 }), outcome({ archived: 2 })])
		);
		expect(summary.tone).toBe('success');
		expect(summary.lines).toEqual([
			{ key: 'shared.postboxSubscriptions.summary.unsubscribed', count: 2 },
			{ key: 'shared.postboxSubscriptions.summary.archived', count: 10 },
		]);
	});

	it('names each unfinished kind on its own line rather than one red blob', () => {
		const summary = subscriptionBatchSummary(
			summarizeSubscriptionBatch([
				outcome({ archived: 5 }),
				outcome({ status: 'failed' }),
				outcome({ status: 'manual' }),
			])
		);
		expect(summary.tone).toBe('warning');
		expect(summary.lines.map((line) => line.key)).toEqual([
			'shared.postboxSubscriptions.summary.unsubscribed',
			'shared.postboxSubscriptions.summary.archived',
			'shared.postboxSubscriptions.summary.failed',
			'shared.postboxSubscriptions.summary.manual',
		]);
	});

	it('leads with "nothing was unsubscribed" when nothing landed', () => {
		const summary = subscriptionBatchSummary(
			summarizeSubscriptionBatch([outcome({ status: 'failed' })])
		);
		expect(summary.tone).toBe('error');
		expect(summary.lines[0]).toEqual({
			key: 'shared.postboxSubscriptions.summary.noneDone',
			count: 0,
		});
	});

	it('omits the archived line when nothing moved', () => {
		const summary = subscriptionBatchSummary(summarizeSubscriptionBatch([outcome()]));
		expect(summary.lines.map((line) => line.key)).toEqual([
			'shared.postboxSubscriptions.summary.unsubscribed',
		]);
	});
});
