/**
 * Bundled inbox feed (utils/postboxBundles): which runs fold, where the bundle
 * lands, and what it carries. The two properties the whole feature rests on —
 * nothing is lost, and the arrival order is never rearranged — are pinned here.
 */
import { describe, it, expect } from 'vitest';
import {
	POSTBOX_BUNDLE_CATEGORIES,
	POSTBOX_BUNDLE_META,
	POSTBOX_BUNDLE_MIN_SIZE,
	bundleMessageIds,
	bundleOneClickSenders,
	bundlePostboxFeed,
	type PostboxBundleMessage,
} from '../postboxBundles';

interface Row extends PostboxBundleMessage {
	category?: string;
}

function row(id: string, category?: string, overrides: Partial<Row> = {}): Row {
	return {
		_id: id,
		fromAddress: `${id}@example.com`,
		flagSeen: true,
		...(category === undefined ? {} : { category }),
		...overrides,
	};
}

const fold = (rows: Row[]) => bundlePostboxFeed(rows, { categoryOf: (r) => r.category });

/** The feed as a flat list of ids, in render order, bundles expanded again. */
function idsOf(rows: Row[]): string[] {
	return fold(rows).flatMap((entry) =>
		entry.kind === 'bundle' ? entry.messages.map((m) => m._id) : [entry.message._id]
	);
}

describe('bundlePostboxFeed', () => {
	it('leaves a feed of people exactly as it found it', () => {
		const rows = [row('a', 'person'), row('b', 'person'), row('c')];
		expect(fold(rows).map((e) => e.kind)).toEqual(['message', 'message', 'message']);
	});

	it('folds a run of one category into a single bundle', () => {
		const rows = [row('n1', 'newsletter'), row('n2', 'newsletter'), row('n3', 'newsletter')];
		const entries = fold(rows);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ kind: 'bundle', category: 'newsletter', count: 3 });
	});

	it('emits one bundle PER CATEGORY inside the same run', () => {
		const rows = [
			row('n1', 'newsletter'),
			row('n2', 'newsletter'),
			row('t1', 'notification'),
			row('t2', 'notification'),
		];
		const entries = fold(rows);
		expect(entries.map((e) => (e.kind === 'bundle' ? e.category : 'message'))).toEqual([
			'newsletter',
			'notification',
		]);
	});

	it('never folds across a person row — a run is not a filter', () => {
		const rows = [
			row('n1', 'newsletter'),
			row('n2', 'newsletter'),
			row('p1', 'person'),
			row('n3', 'newsletter'),
			row('n4', 'newsletter'),
		];
		const entries = fold(rows);
		expect(entries.map((e) => e.kind)).toEqual(['bundle', 'message', 'bundle']);
		// Two separate bundles, not one bundle of four.
		expect(entries.filter((e) => e.kind === 'bundle').map((e) => e.count)).toEqual([2, 2]);
	});

	it('keeps a lone low-signal row as its own row', () => {
		expect(POSTBOX_BUNDLE_MIN_SIZE).toBe(2);
		const rows = [row('p1', 'person'), row('n1', 'newsletter'), row('p2', 'person')];
		expect(fold(rows).map((e) => e.kind)).toEqual(['message', 'message', 'message']);
	});

	it('leaves the odd category out of a run loose, in place', () => {
		const rows = [
			row('n1', 'newsletter'),
			row('r1', 'receipt'),
			row('n2', 'newsletter'),
			row('n3', 'newsletter'),
		];
		const entries = fold(rows);
		// The newsletter bundle takes the position of its FIRST member, so the
		// lone receipt still reads after it, exactly where it arrived.
		expect(entries.map((e) => e.kind)).toEqual(['bundle', 'message']);
		expect(entries[1]).toMatchObject({ kind: 'message', message: { _id: 'r1' } });
	});

	it('never loses or duplicates a message', () => {
		const rows = [
			row('p1', 'person'),
			row('n1', 'newsletter'),
			row('n2', 'newsletter'),
			row('r1', 'receipt'),
			row('r2', 'receipt'),
			row('u1'),
			row('t1', 'notification'),
		];
		expect(idsOf(rows)).toEqual(['p1', 'n1', 'n2', 'r1', 'r2', 'u1', 't1']);
	});

	it('never folds an unclassified row — fail open', () => {
		// The classifier has not run yet: folding here could hide a real reply.
		const rows = [row('u1'), row('u2'), row('u3')];
		expect(fold(rows).every((e) => e.kind === 'message')).toBe(true);
	});

	it('does not fold when no category is supplied at all', () => {
		const rows = [row('n1', 'newsletter'), row('n2', 'newsletter')];
		expect(bundlePostboxFeed(rows).every((e) => e.kind === 'message')).toBe(true);
	});

	it('names the newest sender and counts the unread rows inside', () => {
		const rows = [
			row('n1', 'newsletter', { fromName: 'Northwind Digest', flagSeen: false }),
			row('n2', 'newsletter', { flagSeen: false }),
			row('n3', 'newsletter'),
		];
		expect(fold(rows)[0]).toMatchObject({
			kind: 'bundle',
			latestFrom: 'Northwind Digest',
			unreadCount: 2,
		});
	});

	it('falls back to the address when the sender has no display name', () => {
		const rows = [row('n1', 'newsletter', { fromName: '   ' }), row('n2', 'newsletter')];
		expect(fold(rows)[0]).toMatchObject({ latestFrom: 'n1@example.com' });
	});

	it('gives each bundle an id tied to its category and first message', () => {
		const rows = [row('n1', 'newsletter'), row('n2', 'newsletter')];
		expect(fold(rows)[0]).toMatchObject({ id: 'newsletter:n1' });
	});

	it('honours a caller-supplied minimum', () => {
		const rows = [row('n1', 'newsletter'), row('n2', 'newsletter')];
		const entries = bundlePostboxFeed(rows, { categoryOf: (r) => r.category, minSize: 3 });
		expect(entries.every((e) => e.kind === 'message')).toBe(true);
	});
});

describe('bundle registries', () => {
	it('folds the three low-signal categories and never `person`', () => {
		expect([...POSTBOX_BUNDLE_CATEGORIES]).toEqual(['newsletter', 'notification', 'receipt']);
		expect(POSTBOX_BUNDLE_CATEGORIES as readonly string[]).not.toContain('person');
	});

	it('carries a catalog KEY, not a sentence, for each category', () => {
		for (const category of POSTBOX_BUNDLE_CATEGORIES) {
			expect(POSTBOX_BUNDLE_META[category].label).toMatch(/^shared\.postboxBundles\./);
			expect(POSTBOX_BUNDLE_META[category].icon).toMatch(/^lucide:/);
		}
	});
});

describe('bundleOneClickSenders', () => {
	it('takes only senders a batch can actually unsubscribe without a browser', () => {
		const rows = [
			row('a', 'newsletter', { unsubscribe: { oneClick: true, httpUrl: 'https://x/u' } }),
			row('b', 'newsletter', { unsubscribe: { oneClick: false, httpUrl: 'https://y/u' } }),
			row('c', 'newsletter'),
		];
		expect(bundleOneClickSenders(rows)).toEqual(['a@example.com']);
	});

	it('deduplicates a sender that appears several times, case-insensitively', () => {
		const unsubscribe = { oneClick: true };
		const rows = [
			row('a', 'newsletter', { fromAddress: 'News@Example.com', unsubscribe }),
			row('b', 'newsletter', { fromAddress: 'news@example.com ', unsubscribe }),
		];
		expect(bundleOneClickSenders(rows)).toEqual(['news@example.com']);
	});

	it('is empty when nothing in the bundle can be unsubscribed from', () => {
		expect(bundleOneClickSenders([row('a', 'newsletter')])).toEqual([]);
	});
});

describe('bundleMessageIds', () => {
	it('is every id in the bundle, in order', () => {
		expect(bundleMessageIds([row('a'), row('b')])).toEqual(['a', 'b']);
	});
});
