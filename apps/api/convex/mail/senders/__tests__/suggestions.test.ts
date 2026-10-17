/**
 * The suggestion rules of the Senders page and the weekly brief line (SPEC §5).
 */

import { describe, expect, it } from 'vitest';
import { suggestSenderStatus } from '../suggestions';
import { isWeeklySenderBriefDay, opensEverythingInUpdates } from '../brief';
import { addSenderDelivery, addSenderOpen, emptySenderWeeks } from '../counters';

const totals = (delivered: number, opened: number) => ({
	delivered,
	opened,
	readRate: delivered > 0 ? opened / delivered : 0,
});

describe('suggestSenderStatus', () => {
	const base = { status: 'keep' as const, statusSource: 'default' as const, hasOneClick: false };

	it('suggests Digest for ≥5 deliveries under 10% read', () => {
		expect(suggestSenderStatus({ ...base, kind: 'newsletter', totals: totals(20, 1) })).toBe(
			'digest'
		);
		expect(suggestSenderStatus({ ...base, kind: 'newsletter', totals: totals(10, 1) })).toBeNull();
		expect(suggestSenderStatus({ ...base, kind: 'newsletter', totals: totals(4, 0) })).toBeNull();
	});

	it('suggests Unsubscribe for a never-read promotion with one-click, else Auto-archive', () => {
		const promo = { ...base, kind: 'promotion' as const, totals: totals(2, 0) };
		expect(suggestSenderStatus({ ...promo, hasOneClick: true })).toBe('unsubscribe');
		expect(suggestSenderStatus(promo)).toBe('auto_archive');
		// Read once: not "never read", and too few for the digest rule.
		expect(suggestSenderStatus({ ...promo, totals: totals(2, 1) })).toBeNull();
	});

	it('never argues with a status the person chose, or one already set', () => {
		const quiet = { kind: 'newsletter' as const, totals: totals(20, 0), hasOneClick: false };
		expect(suggestSenderStatus({ ...quiet, status: 'keep', statusSource: 'user' })).toBeNull();
		expect(suggestSenderStatus({ ...quiet, status: 'digest', statusSource: 'default' })).toBeNull();
	});
});

describe('the weekly brief line', () => {
	const WED = Date.UTC(2026, 9, 14, 12);

	it('rides along on Mondays only', () => {
		expect(isWeeklySenderBriefDay(Date.UTC(2026, 9, 12, 7))).toBe(true);
		expect(isWeeklySenderBriefDay(WED)).toBe(false);
	});

	it('names a keep sender in Updates that is opened nearly always', () => {
		let weeks = emptySenderWeeks(WED);
		for (let i = 0; i < 6; i++) {
			weeks = addSenderDelivery(weeks, WED);
			weeks = addSenderOpen(weeks, WED, WED);
		}
		const profile = { status: 'keep' as const, kind: 'notification' as const, ...weeks };
		expect(opensEverythingInUpdates(profile, WED)).toBe(true);
		expect(opensEverythingInUpdates({ ...profile, kind: 'newsletter' }, WED)).toBe(false);
		expect(opensEverythingInUpdates({ ...profile, placementOverride: 'today' }, WED)).toBe(false);
		expect(opensEverythingInUpdates({ ...profile, status: 'digest' }, WED)).toBe(false);
	});
});
