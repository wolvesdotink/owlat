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
	progress: Array<{ newCursor: number; importedDelta: number; failedDelta: number }>;
	fetchedRanges: Array<{ start: number; end: number }>;
	failures: Array<{ uid: number; error: unknown }>;
}

/** A recorder with every list empty. */
function recorder(): Recorder {
	return { ingested: [], progress: [], fetchedRanges: [], failures: [] };
}

/** A fake folder of sparse UIDs, wired into BackfillFolderDeps. */
function fakeDeps(opts: {
	uids: number[];
	batchSize: number;
	startCursor: number | null; // null ⇒ initFolder returns null
	stopAfterBatches?: number;
	// recordProgress returns false from this batch on (simulates Cancel).
	cancelAfterBatches?: number;
	// UIDs the mailbox already holds — returned with no body, as the two-phase
	// fetch does once the Message-ID lookup recognises them.
	alreadyPresent?: number[];
}): { deps: BackfillFolderDeps; rec: Recorder } {
	const rec = recorder();
	let batches = 0;
	const deps: BackfillFolderDeps = {
		batchSize: opts.batchSize,
		initFolder: async () => (opts.startCursor === null ? null : { startCursor: opts.startCursor }),
		fetchBatch: async (_remoteName, start, end): Promise<BackfillFetchedMessage[]> => {
			rec.fetchedRanges.push({ start, end });
			batches++;
			const present = new Set(opts.alreadyPresent ?? []);
			return opts.uids
				.filter((u) => u >= start && u <= end)
				.map((u) =>
					present.has(u)
						? { uid: u, source: null, flags: new Set<string>(), alreadyPresent: true }
						: { uid: u, source: Buffer.from(`raw-${u}`), flags: new Set<string>() }
				);
		},
		ingest: async (_remoteName, _role, uid) => {
			rec.ingested.push(uid);
			return true;
		},
		reportIngestFailure: (_remoteName, uid, error) => {
			rec.failures.push({ uid, error });
		},
		recordProgress: async (_remoteName, newCursor, importedDelta, failedDelta) => {
			rec.progress.push({ newCursor, importedDelta, failedDelta });
			return !(opts.cancelAfterBatches !== undefined && batches >= opts.cancelAfterBatches);
		},
		isStopped: () => opts.stopAfterBatches !== undefined && batches >= opts.stopAfterBatches,
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

	it('counts a message the mailbox already holds without ingesting it', async () => {
		// The shape a resumed / re-walked import takes: the provider's bandwidth
		// was never spent on these, and the walk still converges on the folder's
		// denominator.
		const { deps, rec } = fakeDeps({
			uids: [1, 2, 5, 10],
			batchSize: 3,
			startCursor: 10,
			alreadyPresent: [5, 10],
		});
		const done = await backfillFolder(deps, target);

		expect(done).toBe(true);
		expect(rec.ingested).toEqual([2, 1]); // only the two it did not have
		// Counted exactly as the ingest path counts the `duplicate` it would
		// otherwise have returned, so the reported numbers do not move.
		expect(rec.progress.reduce((n, p) => n + p.importedDelta, 0)).toBe(4);
		expect(rec.progress.reduce((n, p) => n + p.failedDelta, 0)).toBe(0);
		expect(rec.failures).toHaveLength(0);
	});

	it('never reports an already-held message as failed for having no body', async () => {
		// `alreadyPresent` has a null source by construction; without the earlier
		// branch it would fall into the "server returned no body" failure arm.
		const { deps, rec } = fakeDeps({
			uids: [4],
			batchSize: 10,
			startCursor: 4,
			alreadyPresent: [4],
		});
		await backfillFolder(deps, target);
		expect(rec.progress.map((p) => p.importedDelta)).toEqual([1]);
		expect(rec.progress.map((p) => p.failedDelta)).toEqual([0]);
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
		expect(rec.progress.map((p) => p.failedDelta)).toEqual([0, 0]);
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
		const rec = recorder();
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
				return true;
			},
			reportIngestFailure: (_n, uid, error) => {
				rec.failures.push({ uid, error });
			},
			recordProgress: async (_n, newCursor, importedDelta, failedDelta) => {
				rec.progress.push({ newCursor, importedDelta, failedDelta });
				return true;
			},
			isStopped: () => false,
		};
		const done = await backfillFolder(deps, target);
		expect(done).toBe(true);
		// uid 2 had no source → not ingested, and NOT counted as imported; it is
		// still counted as walked so the percentage can reach `messageCount`.
		expect(rec.ingested.sort()).toEqual([1, 3]);
		expect(rec.progress.reduce((n, p) => n + p.importedDelta, 0)).toBe(2);
		expect(rec.progress.reduce((n, p) => n + p.failedDelta, 0)).toBe(1);
	});

	it('keeps advancing when a single message fails to ingest', async () => {
		const rec = recorder();
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
				return true;
			},
			reportIngestFailure: (_n, uid, error) => {
				rec.failures.push({ uid, error });
			},
			recordProgress: async (_n, newCursor, importedDelta, failedDelta) => {
				rec.progress.push({ newCursor, importedDelta, failedDelta });
				return true;
			},
			isStopped: () => false,
		};
		const done = await backfillFolder(deps, target);
		expect(done).toBe(true);
		// uid 2 threw but 1 and 3 still ingested; cursor still reached 0.
		expect(rec.ingested.sort()).toEqual([1, 3]);
		expect(rec.progress.at(-1)!.newCursor).toBe(0);
		// The message that threw is reported, not swallowed...
		expect(rec.failures.map((f) => f.uid)).toEqual([2]);
		// ...and counted as failed, never as imported.
		expect(rec.progress.reduce((n, p) => n + p.importedDelta, 0)).toBe(2);
		expect(rec.progress.reduce((n, p) => n + p.failedDelta, 0)).toBe(1);
	});

	it('counts an ingest that stored nothing without throwing as failed', async () => {
		// `ingestExternalRaw` answers `{skipped: 'no_target'}` — mailbox suspended,
		// folder row missing — without raising. Reading only the throw would call
		// that an import and hand back the original lie.
		const rec = recorder();
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
			// uid 2 lands, the others are skipped server-side.
			ingest: async (_n, _r, uid) => {
				if (uid !== 2) return false;
				rec.ingested.push(uid);
				return true;
			},
			reportIngestFailure: (_n, uid, error) => {
				rec.failures.push({ uid, error });
			},
			recordProgress: async (_n, newCursor, importedDelta, failedDelta) => {
				rec.progress.push({ newCursor, importedDelta, failedDelta });
				return true;
			},
			isStopped: () => false,
		};

		const done = await backfillFolder(deps, target);

		expect(done).toBe(true);
		expect(rec.ingested).toEqual([2]);
		expect(rec.progress.reduce((n, p) => n + p.importedDelta, 0)).toBe(1);
		expect(rec.progress.reduce((n, p) => n + p.failedDelta, 0)).toBe(2);
	});

	it('reports a wholly failed walk as zero imported, not as a full import', async () => {
		// The shape the `Buffer is not defined` ingest took: every message fetched,
		// every ingest throwing, the walk finishing cleanly. It must not be
		// indistinguishable from importing the same messages successfully.
		const rec = recorder();
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
			ingest: async () => {
				throw new ReferenceError('Buffer is not defined');
			},
			reportIngestFailure: (_n, uid, error) => {
				rec.failures.push({ uid, error });
			},
			recordProgress: async (_n, newCursor, importedDelta, failedDelta) => {
				rec.progress.push({ newCursor, importedDelta, failedDelta });
				return true;
			},
			isStopped: () => false,
		};

		const done = await backfillFolder(deps, target);

		expect(done).toBe(true); // the walk did finish — that part was never a lie
		expect(rec.ingested).toEqual([]);
		expect(rec.failures.map((f) => f.uid)).toEqual([1, 2, 3]);
		expect(rec.progress.reduce((n, p) => n + p.importedDelta, 0)).toBe(0);
		expect(rec.progress.reduce((n, p) => n + p.failedDelta, 0)).toBe(3);
	});
});

describe('backfillFolder — the betweenBatches hook', () => {
	const target = { remoteName: 'INBOX', role: 'inbox' as const, ceilingUid: 6, messageCount: 6 };

	/** Wraps fakeDeps so the trace shows where the hook ran relative to batches. */
	function traced(opts: Parameters<typeof fakeDeps>[0]) {
		const { deps, rec } = fakeDeps(opts);
		const trace: string[] = [];
		const fetchBatch = deps.fetchBatch;
		const recordProgress = deps.recordProgress;
		deps.fetchBatch = async (remoteName, start, end) => {
			trace.push(`fetch:${start}-${end}`);
			return await fetchBatch(remoteName, start, end);
		};
		deps.recordProgress = async (remoteName, newCursor, imported, failed) => {
			trace.push(`progress:${newCursor}`);
			return await recordProgress(remoteName, newCursor, imported, failed);
		};
		deps.betweenBatches = async () => {
			trace.push('between');
		};
		return { deps, rec, trace };
	}

	it('runs after each persisted batch that has a successor, never after the last', async () => {
		const { deps, trace } = traced({ uids: [1, 2, 3, 4, 5, 6], batchSize: 2, startCursor: 6 });
		expect(await backfillFolder(deps, target)).toBe(true);
		expect(trace).toEqual([
			'fetch:5-6',
			'progress:4',
			'between',
			'fetch:3-4',
			'progress:2',
			'between',
			'fetch:1-2',
			'progress:0',
		]);
	});

	it('does not run once the migration is cancelled or the worker stops', async () => {
		const cancelled = traced({
			uids: [1, 2, 3, 4, 5, 6],
			batchSize: 2,
			startCursor: 6,
			cancelAfterBatches: 1,
		});
		await backfillFolder(cancelled.deps, target);
		expect(cancelled.trace).not.toContain('between');

		const stopped = traced({
			uids: [1, 2, 3, 4, 5, 6],
			batchSize: 2,
			startCursor: 6,
			stopAfterBatches: 1,
		});
		await backfillFolder(stopped.deps, target);
		expect(stopped.trace).not.toContain('between');
	});
});

describe('backfillFolder with a staged ingest (plan 3.6)', () => {
	it('uploads ahead, commits in fetch order and counts the same', async () => {
		const { deps, rec } = fakeDeps({
			uids: [1, 2, 3, 4, 5, 6],
			batchSize: 10,
			startCursor: 6,
			alreadyPresent: [4],
		});
		const events: string[] = [];
		const uploads: Array<() => void> = [];
		deps.ingestConcurrency = 3;
		deps.stageIngest = async (_remoteName, _role, uid) => {
			events.push(`stage:${uid}`);
			// Uploads finish in reverse: the commits must not follow them.
			await new Promise<void>((resolve) => uploads.unshift(resolve));
			return {
				commit: async () => {
					events.push(`commit:${uid}`);
					if (uid === 5) throw new Error('ingest failed');
					return uid !== 2; // 2 is a server-side skip
				},
				discard: async () => {
					events.push(`discard:${uid}`);
				},
			};
		};
		const run = backfillFolder(deps, {
			remoteName: 'INBOX',
			role: 'inbox',
			ceilingUid: 6,
			messageCount: 6,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		// Three uploads started before any commit.
		expect(events).toEqual(['stage:1', 'stage:2', 'stage:3']);
		// Release uploads as they queue up, newest first, until the walk ends.
		while (!rec.progress.length) {
			for (const release of uploads.splice(0)) release();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		await run;

		expect(events.filter((e) => e.startsWith('commit:'))).toEqual([
			'commit:1',
			'commit:2',
			'commit:3',
			'commit:5',
			'commit:6',
		]);
		// 1, 3, 6 landed; 4 was already present; 2 was skipped and 5 threw.
		expect(rec.progress).toEqual([{ newCursor: 0, importedDelta: 4, failedDelta: 2 }]);
		expect(rec.failures.map((f) => f.uid)).toEqual([5]);
		// The plain `ingest` dep is not used when a staged one is given.
		expect(rec.ingested).toEqual([]);
	});
});
