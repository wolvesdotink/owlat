/**
 * Pure-helper coverage for the recipient autocomplete frecency ranking
 * (mail/contacts.ts): the `contactFrecencyScore` blend and the `rankContacts`
 * comparator (match-quality first, then recency × frequency).
 */
import { describe, it, expect } from 'vitest';
import {
	contactFrecencyScore,
	rankContacts,
	type RankableContact,
} from '../contacts';

const NOW = 1_000 * 86_400_000; // an arbitrary fixed "now" in ms

function contact(overrides: Partial<RankableContact> = {}): RankableContact {
	return {
		email: 'alice@example.com',
		displayName: 'Alice',
		useCount: 1,
		lastUsedAt: NOW,
		...overrides,
	};
}

describe('contactFrecencyScore', () => {
	it('scores a more-recent contact above a stale one at equal frequency', () => {
		const fresh = contact({ lastUsedAt: NOW }); // < 1 day
		const stale = contact({ lastUsedAt: NOW - 200 * 86_400_000 }); // > 90 days
		expect(contactFrecencyScore(fresh, NOW)).toBeGreaterThan(
			contactFrecencyScore(stale, NOW)
		);
	});

	it('scores a more-frequent contact above a rare one at equal recency', () => {
		const frequent = contact({ useCount: 8 });
		const rare = contact({ useCount: 1 });
		expect(contactFrecencyScore(frequent, NOW)).toBeGreaterThan(
			contactFrecencyScore(rare, NOW)
		);
	});

	it('bounds the frequency boost so recency is never fully drowned out', () => {
		const runaway = contact({ useCount: 10_000, lastUsedAt: NOW - 200 * 86_400_000 });
		const recent = contact({ useCount: 1, lastUsedAt: NOW });
		// recency bucket 100 + freq 5 = 105 beats bucket 10 + capped freq 50 = 60
		expect(contactFrecencyScore(recent, NOW)).toBeGreaterThan(
			contactFrecencyScore(runaway, NOW)
		);
	});
});

describe('rankContacts', () => {
	it('orders matches by frecency, most recent-and-frequent first', () => {
		const rows: RankableContact[] = [
			{ email: 'ann.old@example.com', displayName: 'Ann Old', useCount: 1, lastUsedAt: NOW - 120 * 86_400_000 },
			{ email: 'ann.hot@example.com', displayName: 'Ann Hot', useCount: 9, lastUsedAt: NOW },
			{ email: 'ann.mid@example.com', displayName: 'Ann Mid', useCount: 2, lastUsedAt: NOW - 10 * 86_400_000 },
		];
		const ranked = rankContacts(rows, 'ann', NOW, 6);
		expect(ranked.map((r) => r.email)).toEqual([
			'ann.hot@example.com',
			'ann.mid@example.com',
			'ann.old@example.com',
		]);
	});

	it('prefers an email/name prefix match over a mid-name substring match', () => {
		const rows: RankableContact[] = [
			// stale but a real name-prefix match
			{ email: 'bob@example.com', displayName: 'Bob Bee', useCount: 1, lastUsedAt: NOW - 300 * 86_400_000 },
			// very recent+frequent but only a mid-string name match
			{ email: 'zed@example.com', displayName: 'Zed Bobson', useCount: 50, lastUsedAt: NOW },
		];
		const ranked = rankContacts(rows, 'bob', NOW, 6);
		expect(ranked[0]?.email).toBe('bob@example.com');
	});

	it('filters out non-matches and respects the limit', () => {
		const rows: RankableContact[] = [
			{ email: 'dev1@x.com', displayName: 'Dev One', useCount: 1, lastUsedAt: NOW },
			{ email: 'dev2@x.com', displayName: 'Dev Two', useCount: 1, lastUsedAt: NOW - 86_400_000 },
			{ email: 'dev3@x.com', displayName: 'Dev Three', useCount: 1, lastUsedAt: NOW - 2 * 86_400_000 },
			{ email: 'nope@y.com', displayName: 'Nope', useCount: 9, lastUsedAt: NOW },
		];
		const ranked = rankContacts(rows, 'dev', NOW, 2);
		expect(ranked).toHaveLength(2);
		expect(ranked.every((r) => r.email.startsWith('dev'))).toBe(true);
	});

	it('returns nothing for an empty prefix', () => {
		expect(rankContacts([contact()], '  ', NOW, 6)).toEqual([]);
	});
});
