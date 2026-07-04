/**
 * Curated-answer precedence (lib/knowledgePrecedence.ts).
 *
 * A curated canonical answer (isAuthoritative:true) must outrank a scraped fact that
 * competes with it in the same fused pool — UNLESS a newer fact has superseded
 * it (`_stale`), in which case the fresher fact still wins. Pure unit test; no
 * backend.
 */

import { describe, it, expect } from 'vitest';
import { applyAuthorityPrecedence, isPrioritizedAuthority } from '../knowledgePrecedence';

interface Row {
	id: string;
	isAuthoritative?: boolean;
	_stale?: boolean;
}

describe('applyAuthorityPrecedence', () => {
	it('promotes a curated policy ahead of a conflicting scraped fact that fused higher', () => {
		// Scraped fact ranked first by RRF; curated policy ranked second.
		const scraped: Row = { id: 'scraped-returns-30d' };
		const policy: Row = { id: 'policy-returns-14d', isAuthoritative: true };

		const ordered = applyAuthorityPrecedence([scraped, policy]);

		expect(ordered.map((r) => r.id)).toEqual(['policy-returns-14d', 'scraped-returns-30d']);
	});

	it('does NOT promote a curated policy that a newer fact has superseded (_stale) — the fresher fact wins', () => {
		// The curated policy is out of date: a newer scraped fact supersedes it, so
		// graph expansion marked it `_stale`. Precedence must leave it demoted.
		const stalePolicy: Row = { id: 'policy-hours-old', isAuthoritative: true, _stale: true };
		const freshFact: Row = { id: 'fact-hours-new' };

		const ordered = applyAuthorityPrecedence([freshFact, stalePolicy]);

		expect(ordered.map((r) => r.id)).toEqual(['fact-hours-new', 'policy-hours-old']);
		expect(isPrioritizedAuthority(stalePolicy)).toBe(false);
	});

	it('is a stable partition — relative order is preserved within each group', () => {
		const rows: Row[] = [
			{ id: 'f1' },
			{ id: 'p1', isAuthoritative: true },
			{ id: 'f2' },
			{ id: 'p2', isAuthoritative: true },
		];

		const ordered = applyAuthorityPrecedence(rows);

		expect(ordered.map((r) => r.id)).toEqual(['p1', 'p2', 'f1', 'f2']);
	});

	it('returns a new array and does not mutate the input', () => {
		const rows: Row[] = [{ id: 'f1' }, { id: 'p1', isAuthoritative: true }];
		const ordered = applyAuthorityPrecedence(rows);
		expect(ordered).not.toBe(rows);
		expect(rows.map((r) => r.id)).toEqual(['f1', 'p1']);
	});
});
