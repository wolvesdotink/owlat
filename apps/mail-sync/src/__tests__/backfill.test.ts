import { describe, it, expect } from 'vitest';
import {
	nextBackfillRange,
	backfillFolder,
	type BackfillFetchedMessage,
	type BackfillFolderDeps,
} from '../backfill.js';

describe('nextBackfillRange', () => {
	it('returns null once the cursor reaches 0 or below', () => {
		expect(nextBackfillRange(0, 50)).toBeNull();
		expect(nextBackfillRange(-5, 50)).toBeNull();
	});

	it('produces a descending batch capped at batchSize', () => {
		expect(nextBackfillRange(100, 50)).toEqual({ start: 51, end: 100 });
		expect(nextBackfillRange(50, 50)).toEqual({ start: 1, end: 50 });
		expect(nextBackfillRange(1, 10)).toEqual({ start: 1, end: 1 });
	});

	it('clamps the start to 1 when the batch overshoots the bottom', () => {
		expect(nextBackfillRange(30, 100)).toEqual({ start: 1, end: 30 });
	});

	it('treats a non-positive batchSize as 1', () => {
		expect(nextBackfillRange(5, 0)).toEqual({ start: 5, end: 5 });
		expect(nextBackfillRange(5, -3)).toEqual({ start: 5, end: 5 });
	});
});

// ── backfillFolder ──────────────────────────────────────────────────────────

interface Recorder {
	ingested: number[];
	progress: Array<{ newCursor: number; importedDelta: number }>;
	fetchedRanges: Array<{ start: number; end: number }>;
}

/** A fake folder of sparse UIDs, wired into BackfillFolderDeps. */
function fakeDeps(opts: {
	uids: number[];
	batchSize: number;
	startCursor: number | null; // null ⇒ initFolder returns null
	stopAfterBatches?: number;
	// recordProgress returns false from this batch on (simulates Cancel).
	cancelAfterBatches?: number;
}): { deps: BackfillFolderDeps; rec: Recorder } {
	const rec: Recorder = { ingested: [], progress: [], fetchedRanges: [] };
	let batches = 0;
	const deps: BackfillFolderDeps = {
		batchSize: opts.batchSize,
		initFolder: async () =>
			opts.startCursor === null ? null : { startCursor: opts.startCursor },
		fetchBatch: async (_remoteName, start, end): Promise<BackfillFetchedMessage[]> => {
			rec.fetchedRanges.push({ start, end });
			batches++;
			return opts.uids
				.filter((u) => u >= start && u <= end)
				.map((u) => ({ uid: u, source: Buffer.from(`raw-${u}`), flags: new Set<string>() }));
		},
		ingest: async (_remoteName, _role, uid) => {
			rec.ingested.push(uid);
		},
		recordProgress: async (_remoteName, newCursor, importedDelta) => {
			rec.progress.push({ newCursor, importedDelta });
			return !(opts.cancelAfterBatches !== undefined && batches >= opts.cancelAfterBatches);
		},
		isStopped: () =>
			opts.stopAfterBatches !== undefined && batches >= opts.stopAfterBatches,
	};
	return { deps, rec };
}

describe('backfillFolder', () => {
	const target = { remoteName: 'INBOX', role: 'inbox' as const, ceilingUid: 10, messageCount: 4 };

	it('walks the UID space newest→oldest and ingests every message', async () => {
		const { deps, rec } = fakeDeps({ uids: [1, 2, 5, 10], batchSize: 3, startCursor: 10 });
		const done = await backfillFolder(deps, target);

		expect(done).toBe(true);
		// Fetched in descending batches of 3 down to 1.
		expect(rec.fetchedRanges).toEqual([
			{ start: 8, end: 10 },
			{ start: 5, end: 7 },
			{ start: 2, end: 4 },
			{ start: 1, end: 1 },
		]);
		// Ingested every existing message, newest first.
		expect(rec.ingested).toEqual([10, 5, 2, 1]);
		// Cursor dropped past each whole range, ending at 0.
		expect(rec.progress.map((p) => p.newCursor)).toEqual([7, 4, 1, 0]);
		// Per-batch imported counts (sparse) sum to messageCount.
		expect(rec.progress.reduce((n, p) => n + p.importedDelta, 0)).toBe(4);
	});

	it('skips the folder when there is no active migration (initFolder null)', async () => {
		const { deps, rec } = fakeDeps({ uids: [1, 2, 3], batchSize: 10, startCursor: null });
		const done = await backfillFolder(deps, target);
		expect(done).toBe(false);
		expect(rec.fetchedRanges).toHaveLength(0);
		expect(rec.ingested).toHaveLength(0);
	});

	it('advances the cursor past an empty range (gap) without ingesting', async () => {
		// All messages are at the top; the lower ranges are empty gaps.
		const { deps, rec } = fakeDeps({ uids: [9, 10], batchSize: 5, startCursor: 10 });
		const done = await backfillFolder(deps, target);
		expect(done).toBe(true);
		// Newest BATCH first; within a batch, ascending UID (as IMAP returns it).
		expect(rec.ingested).toEqual([9, 10]);
		// Two batches: [6,10] then [1,5] (empty), cursor 5 → 0.
		expect(rec.progress.map((p) => p.newCursor)).toEqual([5, 0]);
		expect(rec.progress.map((p) => p.importedDelta)).toEqual([2, 0]);
	});

	it('stops cooperatively mid-walk and reports interrupted', async () => {
		const { deps, rec } = fakeDeps({
			uids: [1, 2, 3, 4, 5, 6],
			batchSize: 2,
			startCursor: 6,
			stopAfterBatches: 1, // isStopped flips true after the first fetchBatch
		});
		const done = await backfillFolder(deps, target);
		expect(done).toBe(false); // interrupted
		// Only the first batch [5,6] ran before stop.
		expect(rec.fetchedRanges).toEqual([{ start: 5, end: 6 }]);
	});

	it('stops promptly when the migration is cancelled mid-folder', async () => {
		// recordProgress returns false from the first batch on (Cancel pressed).
		const { deps, rec } = fakeDeps({
			uids: [1, 2, 3, 4, 5, 6],
			batchSize: 2,
			startCursor: 6,
			cancelAfterBatches: 1,
		});
		const done = await backfillFolder(deps, target);
		expect(done).toBe(false); // interrupted by cancel
		// First batch [5,6] was imported + recorded, then the walk stopped — the
		// rest of the folder was NOT fetched.
		expect(rec.fetchedRanges).toEqual([{ start: 5, end: 6 }]);
		expect(rec.ingested).toEqual([5, 6]);
		expect(rec.progress).toHaveLength(1);
	});

	it('counts a source-less message toward progress without ingesting it', async () => {
		const rec: Recorder = { ingested: [], progress: [], fetchedRanges: [] };
		const deps: BackfillFolderDeps = {
			batchSize: 10,
			initFolder: async () => ({ startCursor: 3 }),
			fetchBatch: async (_n, start, end) => {
				rec.fetchedRanges.push({ start, end });
				return [
					{ uid: 1, source: Buffer.from('r-1'), flags: new Set<string>() },
					{ uid: 2, source: null, flags: new Set<string>() }, // server returned no body
					{ uid: 3, source: Buffer.from('r-3'), flags: new Set<string>() },
				];
			},
			ingest: async (_n, _r, uid) => {
				rec.ingested.push(uid);
			},
			recordProgress: async (_n, newCursor, importedDelta) => {
				rec.progress.push({ newCursor, importedDelta });
				return true;
			},
			isStopped: () => false,
		};
		const done = await backfillFolder(deps, target);
		expect(done).toBe(true);
		// uid 2 had no source → not ingested, but still counted so the percentage
		// can reach the `messageCount` denominator.
		expect(rec.ingested.sort()).toEqual([1, 3]);
		expect(rec.progress.reduce((n, p) => n + p.importedDelta, 0)).toBe(3);
	});

	it('keeps advancing when a single message fails to ingest', async () => {
		const rec: Recorder = { ingested: [], progress: [], fetchedRanges: [] };
		const deps: BackfillFolderDeps = {
			batchSize: 10,
			initFolder: async () => ({ startCursor: 3 }),
			fetchBatch: async (_n, start, end) => {
				rec.fetchedRanges.push({ start, end });
				return [1, 2, 3].map((u) => ({
					uid: u,
					source: Buffer.from(`r-${u}`),
					flags: new Set<string>(),
				}));
			},
			ingest: async (_n, _r, uid) => {
				if (uid === 2) throw new Error('oversized');
				rec.ingested.push(uid);
			},
			recordProgress: async (_n, newCursor, importedDelta) => {
				rec.progress.push({ newCursor, importedDelta });
				return true;
			},
			isStopped: () => false,
		};
		const done = await backfillFolder(deps, target);
		expect(done).toBe(true);
		// uid 2 threw but 1 and 3 still ingested; cursor still reached 0.
		expect(rec.ingested.sort()).toEqual([1, 3]);
		expect(rec.progress.at(-1)!.newCursor).toBe(0);
		// All 3 counted as processed (progress %, not insert count).
		expect(rec.progress.reduce((n, p) => n + p.importedDelta, 0)).toBe(3);
	});
});
