import { describe, expect, it } from 'vitest';
import type { MailCategory } from '../arrival';
import { computePlacement } from '../arrivalPlacement';

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

	it('a cold-pitch verdict outranks the inferred needs-reply verdict (#1381)', () => {
		// The bug: a pitch asking for a call was placed in Needs you.
		expect(computePlacement({ category: 'promotion' }, { isReplyNeeded: true }, null)).toEqual({
			placement: 'needs_me',
			decidedBy: 'needs_reply',
		});
		expect(
			computePlacement({ category: 'promotion', isColdPitch: true }, { isReplyNeeded: true }, null)
		).toEqual({ placement: 'digest', decidedBy: 'cold_pitch' });
		expect(
			computePlacement({ category: 'other', isColdPitch: true }, { isReplyNeeded: false }, null)
		).toEqual({ placement: 'digest', decidedBy: 'cold_pitch' });
	});

	it('a cold-pitch verdict never outranks a choice the owner made', () => {
		const pitch = { category: 'other' as const, isColdPitch: true };
		expect(
			computePlacement(
				pitch,
				{ placementOverride: { placement: 'today' }, isReplyNeeded: false },
				null
			)
		).toEqual({ placement: 'today', decidedBy: 'thread_override' });
		expect(computePlacement(pitch, noThread, { status: 'auto_archive' })).toEqual({
			placement: 'archived',
			decidedBy: 'sender_status',
		});
		expect(
			computePlacement(pitch, noThread, { status: 'keep', placementOverride: 'today' })
		).toEqual({ placement: 'today', decidedBy: 'sender_override' });
		expect(computePlacement({ ...pitch, rulePlacement: 'updates' }, noThread, null)).toEqual({
			placement: 'updates',
			decidedBy: 'rule',
		});
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
