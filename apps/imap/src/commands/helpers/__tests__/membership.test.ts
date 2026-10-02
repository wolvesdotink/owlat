/**
 * #927: the folder's UID list is reused only while the backend says the
 * folder's membership version has not moved, and every fallback answers
 * exactly what the old per-command listing did.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import type { ConvexClient } from '../../../convex.js';
import {
	forgetCachedMemberships,
	loadCurrentUids,
	MembershipUnsettledError,
} from '../membership.js';
import { membershipDelta } from '../sequenceView.js';

// convex/server declares AnyFunctionReference without exporting it.
type AnyFunctionReference = Parameters<typeof getFunctionName>[0];

type Mode = 'none' | 'walking' | 'ready';

/**
 * One folder as the backend serves it: `listFolderUidsPage` pages of 1,000,
 * and `folderMembershipPage` blocks of `blockSize`, `blocksPerPage` per page,
 * under a version that `change()` bumps. `beforeRead` runs before every query,
 * so a test can change the folder between two pages of one walk.
 */
function folder(initial: number[], mode: Mode, blockSize = 256, blocksPerPage = 512) {
	let uids = [...initial];
	let revision = 0;
	const counts = { membership: 0, blocks: 0, listing: 0, listed: 0 };
	let beforeRead: (name: string) => void = () => {};
	const version = () => `s1:${revision}`;
	const blocks = () => {
		const out: number[][] = [];
		for (let i = 0; i < uids.length; i += blockSize) out.push(uids.slice(i, i + blockSize));
		return out;
	};
	const query = vi.fn(async (ref: AnyFunctionReference, args: Record<string, unknown>) => {
		const name = getFunctionName(ref);
		beforeRead(name);
		if (name.endsWith(':folderMembershipPage')) {
			counts.membership += 1;
			if (mode === 'none') return null;
			if (args['knownVersion'] === version()) {
				return { version: version(), isReady: mode === 'ready', unchanged: true };
			}
			if (mode === 'walking') return { version: version(), isReady: false };
			const all = blocks();
			const after = args['afterFirstUid'] as number | undefined;
			const start = after === undefined ? 0 : all.findIndex((b) => b[0]! > after);
			const page = start < 0 ? [] : all.slice(start, start + blocksPerPage);
			counts.blocks += page.length;
			const more = start >= 0 && start + blocksPerPage < all.length;
			return {
				version: version(),
				isReady: true,
				blocks: page,
				nextFirstUid: more ? page[page.length - 1]![0]! : null,
			};
		}
		if (name.endsWith(':listFolderUidsPage')) {
			counts.listing += 1;
			const after = (args['afterUid'] as number | undefined) ?? 0;
			const page = uids.filter((u) => u >= after).slice(0, 1000);
			counts.listed += page.length;
			return { uids: page, nextUid: page.length < 1000 ? null : page[page.length - 1]! + 1 };
		}
		throw new Error(`unexpected query ${name}`);
	});
	return {
		convex: { query, mutation: vi.fn(), action: vi.fn() } as unknown as ConvexClient,
		counts,
		change(next: number[]) {
			uids = [...next];
			revision += 1;
		},
		setBeforeRead(fn: (name: string) => void) {
			beforeRead = fn;
		},
	};
}

const range = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => from + i);

beforeEach(() => forgetCachedMemberships());

describe('loadCurrentUids', () => {
	it('lists a folder that is not maintained, every time, as before', async () => {
		const f = folder(range(1, 2500), 'none');
		expect(await loadCurrentUids(f.convex, 'f1')).toEqual(range(1, 2500));
		expect(await loadCurrentUids(f.convex, 'f1')).toEqual(range(1, 2500));
		expect(f.counts).toMatchObject({ membership: 2, listing: 6, listed: 5000 });
	});

	it('reads a ready folder from its blocks and reuses them while the version holds', async () => {
		const f = folder(range(1, 100_000), 'ready');
		const first = await loadCurrentUids(f.convex, 'f1');
		expect(first).toHaveLength(100_000);
		// One query: 391 blocks fit one page. No message document read.
		expect(f.counts).toEqual({ membership: 1, blocks: 391, listing: 0, listed: 0 });

		for (let i = 0; i < 5; i++) expect(await loadCurrentUids(f.convex, 'f1')).toBe(first);
		// Five more commands: one version check each, nothing else.
		expect(f.counts).toEqual({ membership: 6, blocks: 391, listing: 0, listed: 0 });
	});

	it('reloads once another session changed the folder', async () => {
		const f = folder([1, 2, 3], 'ready');
		await loadCurrentUids(f.convex, 'f1');
		f.change([1, 3]);
		expect(await loadCurrentUids(f.convex, 'f1')).toEqual([1, 3]);
		f.change([1, 3, 4]);
		expect(await loadCurrentUids(f.convex, 'f1')).toEqual([1, 3, 4]);
		expect(await loadCurrentUids(f.convex, 'f1')).toEqual([1, 3, 4]);
		expect(f.counts.membership).toBe(4);
	});

	it('walks several block pages and restarts when the folder changes between two', async () => {
		const f = folder(range(1, 50), 'ready', 4, 3);
		let pages = 0;
		f.setBeforeRead((name) => {
			if (!name.endsWith(':folderMembershipPage')) return;
			pages += 1;
			// The second page of the first walk sees a newer membership.
			if (pages === 2) f.change(range(2, 50));
		});
		expect(await loadCurrentUids(f.convex, 'f1')).toEqual(range(2, 50));
		f.setBeforeRead(() => {});
		const calls = f.counts.membership;
		// What the restart cached is current, so the next command reads nothing.
		await loadCurrentUids(f.convex, 'f1');
		expect(f.counts.membership).toBe(calls + 1);
	});

	it('retries a torn walk after a backoff until the folder holds still', async () => {
		vi.useFakeTimers();
		try {
			const f = folder(range(1, 50), 'ready', 4, 3);
			let pages = 0;
			f.setBeforeRead((name) => {
				if (!name.endsWith(':folderMembershipPage')) return;
				pages += 1;
				// A delivery lands between the two pages of each of the first three walks.
				if (pages <= 6 && pages % 2 === 0) f.change(range(1, 50 + pages / 2));
			});
			const read = loadCurrentUids(f.convex, 'f1');
			await vi.runAllTimersAsync();
			expect(await read).toEqual(range(1, 53));
			expect(f.counts.listing).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('fails instead of answering from the listing when the folder never holds still', async () => {
		vi.useFakeTimers();
		try {
			const f = folder(range(1, 50), 'ready', 4, 3);
			let n = 0;
			f.setBeforeRead((name) => {
				if (name.endsWith(':folderMembershipPage')) f.change(range(1, 50 + (n += 1)));
			});
			const read = loadCurrentUids(f.convex, 'f1');
			const failed = expect(read).rejects.toBeInstanceOf(MembershipUnsettledError);
			await vi.runAllTimersAsync();
			await failed;
			// Six walks of two pages each, and not one full-document listing.
			expect(f.counts).toMatchObject({ membership: 12, listing: 0, listed: 0 });
		} finally {
			vi.useRealTimers();
		}
	});

	it('stops waiting between walks once the command is aborted', async () => {
		const f = folder(range(1, 50), 'ready', 4, 3);
		const controller = new AbortController();
		let pages = 0;
		f.setBeforeRead((name) => {
			if (!name.endsWith(':folderMembershipPage')) return;
			pages += 1;
			if (pages === 2) {
				f.change(range(1, 51));
				// The connection goes while the read waits to walk again.
				setTimeout(() => controller.abort(new Error('connection closed')), 0);
			}
		});
		await expect(loadCurrentUids(f.convex, 'f1', controller.signal)).rejects.toThrow(
			'connection closed'
		);
		expect(f.counts.membership).toBe(2);
	});

	it('mid-backfill, caches a listing only if the version held across its pages', async () => {
		const f = folder(range(1, 2500), 'walking');
		expect(await loadCurrentUids(f.convex, 'f1')).toEqual(range(1, 2500));
		const listed = f.counts.listing;
		await loadCurrentUids(f.convex, 'f1');
		// Cached: the second command only asked whether the version moved.
		expect(f.counts.listing).toBe(listed);

		forgetCachedMemberships();
		let changed = false;
		f.setBeforeRead((name) => {
			// A delivery lands between two listing pages.
			if (name.endsWith(':listFolderUidsPage') && !changed) {
				changed = true;
				f.change(range(1, 2501));
			}
		});
		await loadCurrentUids(f.convex, 'f1');
		f.setBeforeRead(() => {});
		const before = f.counts.listing;
		expect(await loadCurrentUids(f.convex, 'f1')).toEqual(range(1, 2501));
		// The torn listing was not cached, so this command listed again.
		expect(f.counts.listing).toBeGreaterThan(before);
	});
});

describe('membershipDelta', () => {
	it('numbers removals against the old list, highest first, and notices arrivals', () => {
		expect(membershipDelta([1, 2, 3, 4], [1, 3])).toEqual({ expunged: [4, 2], hasArrivals: false });
		expect(membershipDelta([1, 2, 3], [1, 3, 7])).toEqual({ expunged: [2], hasArrivals: true });
		expect(membershipDelta([5, 9], [2, 5, 9])).toEqual({ expunged: [], hasArrivals: true });
		expect(membershipDelta([1, 2], [1, 2])).toEqual({ expunged: [], hasArrivals: false });
		expect(membershipDelta([], [])).toEqual({ expunged: [], hasArrivals: false });
		expect(membershipDelta([1, 2], [])).toEqual({ expunged: [2, 1], hasArrivals: false });
	});
});
