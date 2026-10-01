/**
 * The cost of a reconcile follows what changed, not the account's size (#928),
 * without giving up what the full UID census guaranteed:
 *   - one flag change on a stable account takes no census anywhere and asks
 *     the provider for a bounded number of UIDs, whatever the folder sizes;
 *   - a message that left a folder no event reports is still found, by the
 *     folder's message count, and only that folder takes a census;
 *   - a census still runs on a known expunge, on a server that reports no
 *     count, and at the latest every CENSUS_INTERVAL_MS;
 *   - a pass cut short hands what it noticed to the next one;
 *   - over a random run of moves, deletions, copies, flag changes and resets,
 *     the local state ends where a full census every cycle would have left it.
 */

import { describe, expect, it } from 'vitest';
import {
	CENSUS_INTERVAL_MS,
	FolderView,
	noPendingChanges,
	reconcile,
	type LocalMessageRow,
	type ReconcileDeps,
	type RemoteObservation,
} from '../remoteState.js';
import { FakeImap, type FakeImapOptions } from './fakeImap.js';

const NO_FLAGS = { seen: false, flagged: false, answered: false };
const FOLDERS = ['INBOX', 'Work', 'Archive', 'Trash'];
const ROLES: Record<string, LocalMessageRow['role']> = {
	INBOX: 'inbox',
	Work: null,
	Archive: 'archive',
	Trash: 'trash',
};

/** A provider account plus the local mirror a reconcile keeps in step with it. */
function account(sizes: Record<string, number>, options: FakeImapOptions = {}) {
	const boxes: Record<string, string[]> = {};
	const local = new Map<string, LocalMessageRow>();
	let n = 0;
	for (const [folder, size] of Object.entries(sizes)) {
		boxes[folder] = [];
		for (let i = 0; i < size; i++) {
			const id = `m${n++}@x`;
			boxes[folder]!.push(id);
			local.set(id, { messageId: id, remoteName: folder, role: ROLES[folder]!, flags: NO_FLAGS });
		}
	}
	const imap = new FakeImap(boxes, options);
	let clock = 1_000_000;
	const lookups: string[][] = [];
	const applied: RemoteObservation[] = [];
	const deps: ReconcileDeps = {
		client: imap,
		tracked: Object.keys(sizes),
		allMail: null,
		views: new Map(),
		allMailCursor: { uidValidity: null, highestModseq: null },
		isAligned: true,
		forceFull: false,
		now: () => clock,
		pending: noPendingChanges(),
		listLocal: async () => ({ page: [...local.values()], isDone: true, continueCursor: '' }),
		lookupLocal: async (ids) => {
			lookups.push(ids);
			return ids.flatMap((id) => local.get(id) ?? []);
		},
		apply: async (observations) => {
			for (const o of observations) {
				applied.push(o);
				const row = local.get(o.messageId);
				if (!row) continue;
				if (o.isGone) local.delete(o.messageId);
				if (o.remoteFolders) row.remoteName = o.remoteFolders[0]!;
				if (o.flags) row.flags = o.flags;
				const here = o.sightings?.find((s) => s.remoteName === row.remoteName);
				if (here) row.sighting = here;
			}
		},
		markAligned: async () => undefined,
		isStopped: () => false,
	};
	return {
		imap,
		deps,
		local,
		lookups,
		applied,
		advance(ms: number) {
			clock += ms;
		},
		/** One pass, with the provider's tally and the observations it made. */
		async pass() {
			imap.resetTally();
			applied.length = 0;
			lookups.length = 0;
			const result = await reconcile(deps);
			return { ...result, tally: imap.tally, applied: [...applied], lookups: [...lookups] };
		},
	};
}

const STABLE = { INBOX: 2000, Work: 500, Archive: 6000, Trash: 500 };

async function warm(acc: ReturnType<typeof account>) {
	await acc.pass(); // cold start: every view is built by a census
	acc.advance(5 * 60_000);
	await acc.pass();
	acc.advance(10_000);
}

describe('incremental reconcile (#928)', () => {
	it('handles one flag change with no census and a bounded transfer, whatever the account size', async () => {
		for (const scale of [1, 4]) {
			const sizes = Object.fromEntries(
				Object.entries(STABLE).map(([f, n]) => [f, n * scale])
			) as typeof STABLE;
			const acc = account(sizes);
			await warm(acc);
			acc.imap.setFlag('INBOX', 'm7@x', '\\Seen', true);

			const pass = await acc.pass();

			expect(pass.full).toBe(false);
			expect(pass.tally.searchAll).toEqual([]);
			// Per folder one arrival search (answering only its highest UID) and
			// one CHANGEDSINCE fetch; the flag change is the only record fetched.
			expect(pass.tally.searches).toBe(FOLDERS.length);
			expect(pass.tally.uidsReturned).toBeLessThanOrEqual(FOLDERS.length + 1);
			expect(pass.lookups).toEqual([['m7@x']]);
			expect(pass.applied).toEqual([
				{ messageId: 'm7@x', flags: { seen: true, flagged: false, answered: false } },
			]);
		}
	});

	it('reads the newest flags without CONDSTORE and without a census', async () => {
		const acc = account(STABLE, { condstore: false });
		await warm(acc);
		acc.imap.setFlag('INBOX', 'm1999@x', '\\Flagged', true);

		const pass = await acc.pass();

		expect(pass.tally.searchAll).toEqual([]);
		expect(pass.applied).toEqual([
			{ messageId: 'm1999@x', flags: { seen: false, flagged: true, answered: false } },
		]);
	});

	it('finds a deletion in a folder no event reports by its count, with a census of that folder only', async () => {
		const acc = account(STABLE);
		await warm(acc);
		acc.imap.remove('Archive', 'm3000@x');

		const pass = await acc.pass();

		expect(pass.tally.searchAll).toEqual(['Archive']);
		expect(pass.applied).toEqual([{ messageId: 'm3000@x', isGone: true }]);
	});

	it('follows a move by the arrival in one folder and the count of the other', async () => {
		const acc = account(STABLE);
		await warm(acc);
		acc.imap.move('INBOX', 'Work', 'm5@x');

		const pass = await acc.pass();

		expect(pass.tally.searchAll).toEqual(['INBOX']);
		expect(pass.applied).toEqual([{ messageId: 'm5@x', remoteFolders: ['Work'] }]);
	});

	it('takes a census where a known expunge or a reconnect says so', async () => {
		const acc = account(STABLE);
		await warm(acc);
		acc.deps.views.get('Work')!.censusDue = true;

		expect((await acc.pass()).tally.searchAll).toEqual(['Work']);
		acc.advance(10_000);
		expect((await acc.pass()).tally.searchAll).toEqual([]);
	});

	it('takes a census every cycle when the server reports no message count', async () => {
		const acc = account(STABLE, { reportsCount: false });
		await warm(acc);

		expect((await acc.pass()).tally.searchAll).toEqual(FOLDERS);
	});

	it('still takes a full census of every folder at least every CENSUS_INTERVAL_MS', async () => {
		const acc = account(STABLE);
		await acc.pass();
		const censuses: string[] = [];
		const cycles = 24; // two hours of five-minute cycles
		for (let i = 0; i < cycles; i++) {
			acc.advance(5 * 60_000);
			censuses.push(...(await acc.pass()).tally.searchAll);
		}
		const perFolder = (cycles * 5 * 60_000) / CENSUS_INTERVAL_MS;
		for (const folder of FOLDERS) {
			expect(censuses.filter((f) => f === folder)).toHaveLength(perFolder);
		}
	});

	it('hands a deletion noticed by an interrupted pass to the next one', async () => {
		const acc = account(STABLE);
		await warm(acc);
		acc.imap.remove('INBOX', 'm9@x');
		let checks = 0;
		acc.deps.isStopped = () => ++checks > 1; // the connection drops after INBOX

		expect((await acc.pass()).completed).toBe(false);
		acc.deps.isStopped = () => false;
		acc.advance(10_000);

		expect((await acc.pass()).applied).toEqual([{ messageId: 'm9@x', isGone: true }]);
	});

	it('hands a deletion to the next pass when a fetch throws after the census', async () => {
		const acc = account(STABLE);
		await warm(acc);
		acc.imap.remove('INBOX', 'm9@x');
		// The count check sends INBOX to a census, which drops m9@x from the view;
		// then the connection is lost on the flag fetch that follows it.
		const realFetch = acc.imap.fetch.bind(acc.imap);
		let armed = true;
		acc.imap.fetch = (range, query, options) => {
			if (armed && options.changedSince !== undefined) {
				armed = false;
				const cut = realFetch(range, query, options);
				return (async function* () {
					await Promise.reject(new Error('connection lost'));
					yield* cut;
				})();
			}
			return realFetch(range, query, options);
		};

		await expect(acc.pass()).rejects.toThrow('connection lost');
		acc.advance(10_000);

		expect((await acc.pass()).applied).toEqual([{ messageId: 'm9@x', isGone: true }]);
	});
});

describe('FolderView', () => {
	const cached = (messageId: string | null) => ({ messageId, flags: NO_FLAGS });

	it('answers which of its UIDs hold a Message-ID as copies come and go', () => {
		const view = new FolderView();
		view.set(1, { messageId: 'a@x', flags: { ...NO_FLAGS, seen: true } });
		view.set(2, cached('a@x'));
		expect(view.flagsOf('a@x')?.seen).toBe(true);
		view.delete(1);
		expect(view.flagsOf('a@x')?.seen).toBe(false);
		view.delete(2);
		expect(view.flagsOf('a@x')).toBeUndefined();
	});

	it('lists the newest UIDs without re-sorting, and after out-of-order arrivals', () => {
		const view = new FolderView();
		for (const uid of [5, 3, 9, 1, 7]) view.set(uid, cached(`${uid}@x`));
		expect(view.newest(3)).toEqual([9, 7, 5]);
		view.delete(9);
		view.set(12, cached('12@x'));
		expect(view.newest(3)).toEqual([12, 7, 5]);
		view.compact();
		expect(view.newest(10)).toEqual([12, 7, 5, 3, 1]);
		expect(view.maxUid).toBe(12);
	});
});

/** Deterministic PRNG, so a failing run replays. */
function prng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

describe('incremental reconcile converges with a full census every cycle', () => {
	for (const seed of [1, 2, 3, 4, 5]) {
		it(`random provider changes, seed ${seed}`, async () => {
			const sizes = { INBOX: 40, Work: 20, Archive: 60, Trash: 10 };
			const incremental = account(sizes);
			const reference = account(sizes);
			reference.deps.forceFull = true;
			await incremental.pass();
			await reference.pass();
			const rand = prng(seed);
			const pick = <T>(xs: T[]): T | undefined => xs[Math.floor(rand() * xs.length)];
			let fresh = 0;

			for (let step = 0; step < 40; step++) {
				for (let k = 0, ops = 1 + Math.floor(rand() * 3); k < ops; k++) {
					const from = pick(FOLDERS)!;
					const to = pick(FOLDERS.filter((f) => f !== from))!;
					const ids = incremental.imap.boxes.get(from)!.messages.map((m) => m.messageId);
					const id = pick(ids);
					const op = rand();
					const flag = pick(['\\Seen', '\\Flagged'])!;
					const on = rand() < 0.5;
					for (const acc of [incremental, reference]) {
						if (op < 0.1) acc.imap.add(from, `new${fresh}@x`);
						else if (!id) continue;
						else if (op < 0.35) acc.imap.move(from, to, id);
						else if (op < 0.5) acc.imap.remove(from, id);
						else if (op < 0.55) acc.imap.add(to, id); // a copy
						else if (op < 0.6) acc.imap.boxes.get(from)!.uidValidity += 1n;
						else acc.imap.setFlag(from, id, flag, on);
					}
					if (op < 0.1) fresh++;
				}
				for (const acc of [incremental, reference]) {
					acc.advance(60_000);
					await acc.pass();
				}
				// Sightings may lag a pulled move until the next full pass; they are
				// evidence for the next restart, not part of the mirrored state.
				const mirrored = (acc: typeof incremental) =>
					[...acc.local.values()].map(({ sighting: _, ...row }) => row);
				expect(mirrored(incremental)).toEqual(mirrored(reference));
			}
		});
	}
});
