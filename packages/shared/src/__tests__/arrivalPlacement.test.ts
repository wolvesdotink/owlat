import { describe, expect, it } from 'vitest';
import type { MailCategory } from '../arrival';
import { computePlacement, doesThreadOverrideHold } from '../arrivalPlacement';

const noThread = { isReplyNeeded: false };

describe('computePlacement precedence (§2.8)', () => {
	it('1: the thread override wins over everything', () => {
		expect(
			computePlacement(
				{ rulePlacement: 'digest', category: 'newsletter' },
				{ placementOverride: { placement: 'updates' }, isReplyNeeded: true },
				{ status: 'unsubscribed', placementOverride: 'needs_me' }
			)
		).toEqual({ placement: 'updates', decidedBy: 'thread_override' });
	});

	it('2: a settled needs-reply verdict is needs_me, over sender status', () => {
		expect(
			computePlacement({ category: 'newsletter' }, { isReplyNeeded: true }, { status: 'digest' })
		).toEqual({ placement: 'needs_me', decidedBy: 'needs_reply' });
	});

	it('a heuristic candidate whose verdict is still pending reads as today', () => {
		expect(computePlacement({ category: 'person' }, { isReplyNeeded: false }, null)).toEqual({
			placement: 'today',
			decidedBy: 'category',
		});
	});

	it('3: sender status files archived or digest', () => {
		for (const status of ['unsubscribed', 'auto_archive'] as const) {
			expect(computePlacement({ category: 'person' }, noThread, { status })).toEqual({
				placement: 'archived',
				decidedBy: 'sender_status',
			});
		}
		expect(
			computePlacement({ category: 'person' }, noThread, {
				status: 'digest',
				placementOverride: 'today',
			})
		).toEqual({ placement: 'digest', decidedBy: 'sender_status' });
	});

	it('4: the sender override comes before rules and category', () => {
		expect(
			computePlacement({ rulePlacement: 'digest', category: 'newsletter' }, noThread, {
				status: 'keep',
				placementOverride: 'today',
			})
		).toEqual({ placement: 'today', decidedBy: 'sender_override' });
	});

	it('5: a rule placement comes before the category', () => {
		expect(
			computePlacement({ rulePlacement: 'needs_me', category: 'newsletter' }, noThread, null)
		).toEqual({ placement: 'needs_me', decidedBy: 'rule' });
	});

	it('6: the category decides last', () => {
		const cases: [MailCategory | undefined, string][] = [
			['newsletter', 'digest'],
			['promotion', 'digest'],
			['notification', 'updates'],
			['receipt', 'updates'],
			['person', 'today'],
			['other', 'today'],
			['spam', 'today'],
			[undefined, 'today'],
		];
		for (const [category, placement] of cases) {
			expect(computePlacement(category ? { category } : {}, noThread, { status: 'keep' })).toEqual({
				placement,
				decidedBy: 'category',
			});
		}
	});
});

describe('computePlacement, exact-wording candidates (#1384)', () => {
	const exact = { isExactWordingCandidate: true };
	const today = { placement: 'today', decidedBy: 'exact_wording' };

	it('lifts a digest or updates placement by sender, sender override, rule or category to today', () => {
		expect(
			computePlacement({ ...exact, category: 'person' }, noThread, { status: 'digest' })
		).toEqual(today);
		expect(
			computePlacement({ ...exact, category: 'person' }, noThread, {
				status: 'keep',
				placementOverride: 'updates',
			})
		).toEqual(today);
		for (const rulePlacement of ['digest', 'updates'] as const) {
			expect(computePlacement({ ...exact, rulePlacement }, noThread, null)).toEqual(today);
		}
		for (const category of ['newsletter', 'promotion', 'notification', 'receipt'] as const) {
			expect(computePlacement({ ...exact, category }, noThread, { status: 'keep' })).toEqual(today);
			expect(computePlacement({ ...exact, category }, noThread, null)).toEqual(today);
		}
	});

	it('keeps the explicit choices: a thread override made after it arrived, auto-archive and unsubscribe', () => {
		for (const placement of ['digest', 'updates', 'archived'] as const) {
			// Set after it arrived, at the same moment, or with times unknown.
			for (const setAt of [2_000, 1_000, undefined]) {
				expect(
					computePlacement(
						{ ...exact, category: 'newsletter', arrivedAt: 1_000 },
						{ placementOverride: { placement, setAt }, isReplyNeeded: false },
						null
					)
				).toEqual({ placement, decidedBy: 'thread_override' });
			}
		}
		for (const status of ['unsubscribed', 'auto_archive'] as const) {
			expect(computePlacement({ ...exact, category: 'newsletter' }, noThread, { status })).toEqual({
				placement: 'archived',
				decidedBy: 'sender_status',
			});
		}
	});

	it('a digest or updates thread override set before it arrived does not bury it (Sol r1 F1)', () => {
		for (const placement of ['digest', 'updates'] as const) {
			expect(
				computePlacement(
					{ ...exact, category: 'person', arrivedAt: 2_000 },
					{ placementOverride: { placement, setAt: 1_000 }, isReplyNeeded: false },
					null
				)
			).toEqual(today);
			// The sender's digest status below it is lifted too.
			expect(
				computePlacement(
					{ ...exact, category: 'newsletter', arrivedAt: 2_000 },
					{ placementOverride: { placement, setAt: 1_000 }, isReplyNeeded: false },
					{ status: 'digest' }
				)
			).toEqual(today);
		}
		// A settled needs-reply verdict still places it.
		expect(
			computePlacement(
				{ ...exact, category: 'person', arrivedAt: 2_000 },
				{ placementOverride: { placement: 'digest', setAt: 1_000 }, isReplyNeeded: true },
				null
			)
		).toEqual({ placement: 'needs_me', decidedBy: 'needs_reply' });
	});

	it('an older thread override that buries nothing, or a message that is no candidate, keeps it', () => {
		for (const placement of ['archived', 'needs_me', 'today'] as const) {
			expect(
				computePlacement(
					{ ...exact, category: 'person', arrivedAt: 2_000 },
					{ placementOverride: { placement, setAt: 1_000 }, isReplyNeeded: false },
					null
				)
			).toEqual({ placement, decidedBy: 'thread_override' });
		}
		expect(
			computePlacement(
				{ isExactWordingCandidate: false, category: 'person', arrivedAt: 2_000 },
				{ placementOverride: { placement: 'digest', setAt: 1_000 }, isReplyNeeded: false },
				null
			)
		).toEqual({ placement: 'digest', decidedBy: 'thread_override' });
	});

	it('doesThreadOverrideHold matches computePlacement', () => {
		const old = { placement: 'digest' as const, setAt: 1_000 };
		expect(doesThreadOverrideHold({ ...exact, arrivedAt: 2_000 }, old)).toBe(false);
		expect(doesThreadOverrideHold({ ...exact, arrivedAt: 1_000 }, old)).toBe(true);
		expect(doesThreadOverrideHold({ ...exact }, old)).toBe(true);
		expect(doesThreadOverrideHold({ arrivedAt: 2_000 }, old)).toBe(true);
	});

	it('never lowers a placement: needs_me stays, today stays decided as before', () => {
		expect(
			computePlacement(
				{ ...exact, category: 'newsletter' },
				{ isReplyNeeded: true },
				{
					status: 'digest',
				}
			)
		).toEqual({ placement: 'needs_me', decidedBy: 'needs_reply' });
		expect(
			computePlacement(
				{ ...exact, rulePlacement: 'needs_me', category: 'newsletter' },
				noThread,
				null
			)
		).toEqual({ placement: 'needs_me', decidedBy: 'rule' });
		expect(computePlacement({ ...exact, category: 'person' }, noThread, null)).toEqual({
			placement: 'today',
			decidedBy: 'category',
		});
	});

	it('a message that is no candidate is placed as before', () => {
		expect(
			computePlacement({ isExactWordingCandidate: false, category: 'newsletter' }, noThread, {
				status: 'digest',
			})
		).toEqual({ placement: 'digest', decidedBy: 'sender_status' });
	});
});
