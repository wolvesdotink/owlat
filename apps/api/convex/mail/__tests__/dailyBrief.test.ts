/**
 * Pure-helper coverage for the Daily Brief assembly (mail/dailyBrief.ts):
 * priority ranking of the "needs you" list and the auditable low-signal bundle
 * (counts always equal the listed entries).
 */
import { describe, it, expect } from 'vitest';
import {
	rankBriefItems,
	bundleLowSignal,
	isBundledCategory,
	type BriefItem,
	type BundledEntry,
} from '../dailyBrief';
import type { Id } from '../../_generated/dataModel';

const tid = (n: number) => `thread${n}` as Id<'mailThreads'>;

function item(overrides: Partial<BriefItem>): BriefItem {
	return {
		kind: 'needs_reply',
		threadId: tid(1),
		priorityScore: 50,
		title: 'subject',
		...overrides,
	};
}

describe('rankBriefItems', () => {
	it('ranks higher priority first', () => {
		const ranked = rankBriefItems([
			item({ threadId: tid(1), priorityScore: 20 }),
			item({ threadId: tid(2), priorityScore: 90 }),
			item({ threadId: tid(3), priorityScore: 50 }),
		]);
		expect(ranked.map((i) => i.threadId)).toEqual([tid(2), tid(3), tid(1)]);
	});

	it('breaks a score tie by the sooner deadline (dated outranks undated)', () => {
		const ranked = rankBriefItems([
			item({ threadId: tid(1), priorityScore: 50, dueAt: undefined }),
			item({ threadId: tid(2), priorityScore: 50, dueAt: 2000 }),
			item({ threadId: tid(3), priorityScore: 50, dueAt: 1000 }),
		]);
		expect(ranked.map((i) => i.threadId)).toEqual([tid(3), tid(2), tid(1)]);
	});

	it('does not mutate the input array', () => {
		const input = [item({ priorityScore: 1 }), item({ priorityScore: 9 })];
		const before = input.map((i) => i.priorityScore);
		rankBriefItems(input);
		expect(input.map((i) => i.priorityScore)).toEqual(before);
	});
});

describe('bundleLowSignal (auditable)', () => {
	it('counts equal the listed entries — nothing hidden without a trail', () => {
		const entries: BundledEntry[] = [
			{ threadId: tid(1), category: 'newsletter', fromAddress: 'a@x.com', subject: 's1' },
			{ threadId: tid(2), category: 'newsletter', fromAddress: 'b@x.com', subject: 's2' },
			{ threadId: tid(3), category: 'receipt', fromAddress: 'c@x.com', subject: 's3' },
			{ threadId: tid(4), category: 'notification', fromAddress: 'd@x.com', subject: 's4' },
		];
		const { bundled, bundledCounts } = bundleLowSignal(entries);
		expect(bundled).toHaveLength(4);
		expect(bundledCounts).toEqual({ newsletter: 2, receipt: 1, notification: 1 });
		// The sum of the counts equals the number of inspectable entries.
		const total = bundledCounts.newsletter + bundledCounts.receipt + bundledCounts.notification;
		expect(total).toBe(bundled.length);
	});

	it('is empty for no low-signal mail', () => {
		expect(bundleLowSignal([])).toEqual({
			bundled: [],
			bundledCounts: { newsletter: 0, notification: 0, receipt: 0 },
		});
	});
});

describe('isBundledCategory', () => {
	it('bundles only low-signal categories, never person/other', () => {
		expect(isBundledCategory('newsletter')).toBe(true);
		expect(isBundledCategory('notification')).toBe(true);
		expect(isBundledCategory('receipt')).toBe(true);
		expect(isBundledCategory('person')).toBe(false);
		expect(isBundledCategory('other')).toBe(false);
	});
});
