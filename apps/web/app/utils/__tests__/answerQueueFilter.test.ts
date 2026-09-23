import { describe, expect, it } from 'vitest';
import { answerItemMatches, parseAnswerFilter } from '../answerQueue';

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
