import { describe, expect, it } from 'vitest';
import {
	answerItemMatches,
	answerModeTarget,
	answerQueueIndexHref,
	answerQueueItemHref,
	answerTargetMatchesRoute,
	opensInAnswerMode,
	parseAnswerFilter,
} from '../answerQueue';

const team = { source: 'team' as const };
const mention = { source: 'mention' as const };
const ada = { source: 'mail' as const, mailboxId: 'mb_ada' };
const bob = { source: 'mail' as const, mailboxId: 'mb_bob' };

describe('Answer queue ?in= filter', () => {
	it('reads the query value, defaulting to everything', () => {
		expect(parseAnswerFilter('team')).toBe('team');
		expect(parseAnswerFilter(undefined)).toBe('all');
		expect(parseAnswerFilter('')).toBe('all');
		expect(parseAnswerFilter(['team'])).toBe('all');
	});

	it('?in=team shows only team inbox drafts (where "Review drafts" lands)', () => {
		expect([team, mention, ada].filter((i) => answerItemMatches(i, 'team'))).toEqual([team]);
	});

	it('?in=chat shows mentions, ?in=<mailbox> that mailbox only', () => {
		expect(answerItemMatches(mention, 'chat')).toBe(true);
		expect(answerItemMatches(team, 'chat')).toBe(false);
		expect(answerItemMatches(ada, 'mb_ada')).toBe(true);
		expect(answerItemMatches(bob, 'mb_ada')).toBe(false);
		expect(answerItemMatches(team, 'mb_ada')).toBe(false);
	});

	it('all shows everything', () => {
		for (const item of [team, mention, ada]) expect(answerItemMatches(item, 'all')).toBe(true);
	});
});

describe('the queue on Answer mode', () => {
	const mailItem = { source: 'mail' as const, row: { kind: 'needs_reply', messageId: 'msg_1' } };
	const followUp = { source: 'mail' as const, row: { kind: 'followup', messageId: 'msg_2' } };
	const teamItem = {
		source: 'team' as const,
		entry: { message: { _id: 'in_1' }, thread: { _id: 'ct_1' } },
	};
	const orphan = { source: 'team' as const, entry: { message: { _id: 'in_2' }, thread: null } };

	it('answers mail on its message and team drafts on their thread', () => {
		expect(answerModeTarget(mailItem)).toEqual({ kind: 'mail', messageId: 'msg_1' });
		expect(answerModeTarget(teamItem)).toEqual({
			kind: 'team',
			threadId: 'ct_1',
			messageId: 'in_1',
		});
		expect(answerModeTarget(orphan)).toBeNull();
		expect(answerModeTarget({ source: 'mention' })).toBeNull();
	});

	it('keeps follow-up reminders, mentions and thread-less drafts as cards', () => {
		expect(opensInAnswerMode(mailItem)).toBe(true);
		expect(opensInAnswerMode(teamItem)).toBe(true);
		expect(opensInAnswerMode(followUp)).toBe(false);
		expect(opensInAnswerMode(orphan)).toBe(false);
		expect(opensInAnswerMode({ source: 'mention' })).toBe(false);
	});

	it('carries the filter on the Answer mode route and back to the queue page', () => {
		expect(answerQueueItemHref({ kind: 'mail', messageId: 'msg_1' }, 'all')).toBe(
			'/dashboard/answer/m/msg_1?queue=all'
		);
		expect(answerQueueItemHref(answerModeTarget(teamItem)!, 'team')).toBe(
			'/dashboard/answer/t/ct_1?message=in_1&queue=team'
		);
		expect(answerQueueIndexHref('all')).toBe('/dashboard/answer');
		expect(answerQueueIndexHref('mb_ada')).toBe('/dashboard/answer?in=mb_ada');
	});

	it('matches a route to its item', () => {
		const target = answerModeTarget(teamItem)!;
		expect(answerTargetMatchesRoute(target, { path: '/dashboard/answer/t/ct_1', query: {} })).toBe(
			true
		);
		expect(
			answerTargetMatchesRoute(target, {
				path: '/dashboard/answer/t/ct_1',
				query: { message: 'in_9' },
			})
		).toBe(false);
		expect(
			answerTargetMatchesRoute(
				{ kind: 'mail', messageId: 'msg_1' },
				{ path: '/dashboard/answer/m/msg_1', query: { queue: 'all' } }
			)
		).toBe(true);
	});
});
