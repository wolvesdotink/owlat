/**
 * #927: a sparse message set reads the messages it names, not the span
 * between its smallest and largest UID.
 *
 * FETCH used to turn `UID FETCH 1,100000` into one `1..100000` envelope window
 * and throw away everything but two rows; STORE / COPY / MOVE did the same with
 * message ids. The set is now sent as the runs of consecutive sequence numbers
 * it resolves to (each run's UID range holds only requested messages), batched
 * into bounded windowed reads, and FETCH sends each envelope page as it
 * arrives. These tests bound the documents read and pin the wire output:
 * true sequence numbers, ascending, each message once.
 */

import { describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { fetchModule, type FetchArgs } from '../index.js';
import { storeModule, type StoreArgs } from '../../store/index.js';
import { MAX_RANGES_PER_READ } from '../../helpers/folderPaging.js';
import { resolveSet, buildSeqMap, uidRuns } from '../../helpers/seqMap.js';
import type { FetchEnvelope } from '../format.js';
import type { CommandDeps, ConnectionState, ImapVerb, StartArgs } from '../../types.js';

// convex/server declares AnyFunctionReference without exporting it.
type AnyFunctionReference = Parameters<typeof getFunctionName>[0];

vi.mock('../../../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** The backend's page sizes (apps/api `mail/imap/fetch.ts`). */
const UID_PAGE = 1_000;
const ENVELOPE_PAGE = 200;

function envelope(uid: number): FetchEnvelope {
	return {
		_id: `m-${uid}`,
		uid,
		modseq: uid,
		rawSize: 10,
		rfc822MessageId: `mid-${uid}@owlat.test`,
		fromAddress: 'jane@owlat.test',
		toAddresses: ['bob@owlat.test'],
		ccAddresses: [],
		bccAddresses: [],
		subject: `s${uid}`,
		internalDate: Date.UTC(2026, 5, 9, 10, 30, 5),
		flagSeen: true,
		flagFlagged: false,
		flagAnswered: false,
		flagDraft: false,
		flagDeleted: false,
		customFlags: [],
	};
}

type Range = { low: number; high: number };

interface Counters {
	uidPages: number;
	envelopeReads: Array<{ uidLow: number; uidHigh: number; ranges?: Range[] }>;
	envelopeDocs: number;
	idReads: number;
	idDocs: number;
	/** Convex calls made before the first `* n FETCH` line went out. */
	callsBeforeFirstResponse: number | null;
}

/**
 * A Convex stub that pages like the backend and counts every row a page
 * returns as a document read. It enforces the backend's `ranges` contract
 * (ascending, disjoint, at most the cap), so a client bug fails loudly.
 */
function makeFolder(initialUids: readonly number[]) {
	let uids = [...initialUids];
	const c: Counters = {
		uidPages: 0,
		envelopeReads: [],
		envelopeDocs: 0,
		idReads: 0,
		idDocs: 0,
		callsBeforeFirstResponse: null,
	};
	const window = (p: Record<string, unknown>): number[] => {
		const low = p['uidLow'] as number;
		const high = p['uidHigh'] as number;
		const ranges = (p['ranges'] as Range[] | undefined) ?? [{ low, high }];
		expect(ranges.length).toBeLessThanOrEqual(MAX_RANGES_PER_READ);
		for (const [i, r] of ranges.entries()) {
			expect(r.low).toBeLessThanOrEqual(r.high);
			if (i > 0) expect(r.low).toBeGreaterThan(ranges[i - 1]!.high);
		}
		const out: number[] = [];
		for (const r of ranges) {
			for (const uid of uids) {
				if (out.length >= ENVELOPE_PAGE) break;
				if (uid >= Math.max(r.low, low) && uid <= Math.min(r.high, high)) out.push(uid);
			}
		}
		return out;
	};
	const next = (page: number[], limit: number) =>
		page.length < limit ? null : (page[page.length - 1] ?? 0) + 1;
	const calls = () => c.uidPages + c.envelopeReads.length + c.idReads;
	const convex = {
		query: vi.fn(async (fnRef: AnyFunctionReference, p: Record<string, unknown>) => {
			const ref = getFunctionName(fnRef);
			if (ref.endsWith(':folderMembershipPage')) return null;
			if (ref.endsWith(':listFolderUidsPage')) {
				c.uidPages += 1;
				const after = (p['afterUid'] as number | undefined) ?? 0;
				const page = uids.filter((u) => u >= after).slice(0, UID_PAGE);
				return { uids: page, nextUid: next(page, UID_PAGE) };
			}
			if (ref.endsWith(':fetchEnvelopes')) {
				c.envelopeReads.push(p as Counters['envelopeReads'][number]);
				const page = window(p);
				c.envelopeDocs += page.length;
				return { rows: page.map(envelope), nextUid: next(page, ENVELOPE_PAGE) };
			}
			if (ref.endsWith(':resolveMessageIdsByUid')) {
				c.idReads += 1;
				const page = window(p);
				c.idDocs += page.length;
				return {
					rows: page.map((uid) => ({ _id: `m-${uid}`, uid, modseq: uid })),
					nextUid: next(page, ENVELOPE_PAGE),
				};
			}
			throw new Error(`unexpected query ${ref}`);
		}),
		mutation: vi.fn(async (_ref: AnyFunctionReference, p: { messageIds: string[] }) => ({
			updated: p.messageIds.map((id) => {
				const uid = Number(id.slice(2));
				return { messageId: id, uid, modseq: uid + 1, flags: ['\\Flagged'] };
			}),
			unchanged: [],
		})),
		action: vi.fn(),
	};
	return {
		convex,
		counters: c,
		calls,
		expunge: (uid: number) => {
			uids = uids.filter((u) => u !== uid);
		},
	};
}

function selectedState(total: number): ConnectionState {
	return {
		auth: { mailboxId: 'mb1', appPasswordId: 'ap1', address: 'a@owlat.test', userId: 'u1' },
		selected: {
			folderId: 'f1',
			folderName: 'INBOX',
			uidValidity: 1,
			uidNext: total + 1,
			highestModseq: total,
			totalCount: total,
			readOnly: false,
		},
		clientId: null,
	};
}

async function runFetch(
	folder: ReturnType<typeof makeFolder>,
	total: number,
	args: FetchArgs
): Promise<string[]> {
	const lines: string[] = [];
	const session = fetchModule.start({
		deps: { convex: folder.convex } as unknown as CommandDeps,
		state: selectedState(total),
		args,
		tag: 'a1',
		verb: 'FETCH' as ImapVerb,
		send: (line: string) => {
			if (line.startsWith('* ') && folder.counters.callsBeforeFirstResponse === null) {
				folder.counters.callsBeforeFirstResponse = folder.calls();
			}
			lines.push(line);
		},
	} as StartArgs<FetchArgs>);
	await session.completion;
	return lines;
}

const range = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('sparse FETCH reads the requested messages, not their min..max span', () => {
	it('UID FETCH 1,10000 in a 10,000-message folder reads two envelopes in one call', async () => {
		const folder = makeFolder(range(1, 10_000));
		const lines = await runFetch(folder, 10_000, {
			set: '1,10000',
			itemsToken: '(FLAGS UID)',
			byUid: true,
		});

		expect(lines).toEqual([
			'* 1 FETCH (UID 1 FLAGS (\\Seen))',
			'* 10000 FETCH (UID 10000 FLAGS (\\Seen))',
			'a1 OK UID FETCH completed',
		]);
		expect(folder.counters.envelopeReads).toEqual([
			{
				folderId: 'f1',
				uidLow: 1,
				uidHigh: 10_000,
				ranges: [
					{ low: 1, high: 1 },
					{ low: 10_000, high: 10_000 },
				],
			},
		]);
		expect(folder.counters.envelopeDocs).toBe(2);
	});

	it('reads grow with the set, not with the folder or the span it covers', async () => {
		const small = makeFolder(range(1, 1_000));
		await runFetch(small, 1_000, { set: '1,1000', itemsToken: '(UID)', byUid: true });
		const large = makeFolder(range(1, 20_000));
		await runFetch(large, 20_000, { set: '1,20000', itemsToken: '(UID)', byUid: true });

		expect(large.counters.envelopeDocs).toBe(small.counters.envelopeDocs);
		expect(large.counters.envelopeReads).toHaveLength(small.counters.envelopeReads.length);
	});

	it('overlapping, repeated and out-of-order parts give each message once, in sequence order', async () => {
		// UIDs with gaps, so UID and sequence number differ.
		const uids = range(1, 3_000).map((n) => n * 3);
		const folder = makeFolder(uids);
		const lines = await runFetch(folder, uids.length, {
			set: '9000,6:12,9,12,8997:9000,30',
			itemsToken: '(UID)',
			byUid: true,
		});

		expect(lines).toEqual([
			'* 2 FETCH (UID 6)',
			'* 3 FETCH (UID 9)',
			'* 4 FETCH (UID 12)',
			'* 10 FETCH (UID 30)',
			'* 2999 FETCH (UID 8997)',
			'* 3000 FETCH (UID 9000)',
			'a1 OK UID FETCH completed',
		]);
		expect(folder.counters.envelopeDocs).toBe(6);
	});

	it('a sequence set resolves through the map and reads only its positions', async () => {
		const uids = range(1, 5_000).map((n) => n * 2);
		const folder = makeFolder(uids);
		const lines = await runFetch(folder, uids.length, {
			set: '1,2500:2501,*',
			itemsToken: '(UID)',
			byUid: false,
		});

		expect(lines).toEqual([
			'* 1 FETCH (UID 2)',
			'* 2500 FETCH (UID 5000)',
			'* 2501 FETCH (UID 5002)',
			'* 5000 FETCH (UID 10000)',
			'a1 OK FETCH completed',
		]);
		expect(folder.counters.envelopeDocs).toBe(4);
	});

	it('more runs than one read carries are batched, each read bounded', async () => {
		// 250 isolated messages: every 20th of 5,000.
		const wanted = range(0, 249).map((i) => 1 + i * 20);
		const folder = makeFolder(range(1, 5_000));
		const lines = await runFetch(folder, 5_000, {
			set: wanted.join(','),
			itemsToken: '(UID)',
			byUid: true,
		});

		expect(lines.filter((l) => l.startsWith('* '))).toEqual(
			wanted.map((uid) => `* ${uid} FETCH (UID ${uid})`)
		);
		expect(folder.counters.envelopeDocs).toBe(250);
		expect(folder.counters.envelopeReads).toHaveLength(Math.ceil(250 / MAX_RANGES_PER_READ));
	});

	it('resumes inside a batch when a page fills up, without re-reading or skipping', async () => {
		// Three runs of 150 messages: the first page (200 rows) ends inside the
		// second run.
		const folder = makeFolder(range(1, 2_000));
		const lines = await runFetch(folder, 2_000, {
			set: '1:150,501:650,1001:1150',
			itemsToken: '(UID)',
			byUid: true,
		});

		const uidsOut = lines
			.filter((l) => l.startsWith('* '))
			.map((l) => Number(/UID (\d+)/.exec(l)?.[1]));
		expect(uidsOut).toEqual([...range(1, 150), ...range(501, 650), ...range(1001, 1150)]);
		expect(folder.counters.envelopeDocs).toBe(450);
		expect(folder.counters.envelopeReads.map((r) => r.uidLow)).toEqual([1, 551, 1101]);
	});

	it('a message expunged between the UID list and the envelope read is dropped, the rest keep their numbers', async () => {
		const folder = makeFolder(range(1, 100));
		const real = folder.convex.query.getMockImplementation()!;
		folder.convex.query.mockImplementation(async (fnRef, p) => {
			// Another session expunges UID 50 right after this one listed UIDs.
			if (getFunctionName(fnRef).endsWith(':fetchEnvelopes')) folder.expunge(50);
			return await real(fnRef, p);
		});
		const lines = await runFetch(folder, 100, {
			set: '49:51,100',
			itemsToken: '(UID)',
			byUid: true,
		});

		expect(lines).toEqual([
			'* 49 FETCH (UID 49)',
			'* 51 FETCH (UID 51)',
			'* 100 FETCH (UID 100)',
			'a1 OK UID FETCH completed',
		]);
	});

	it('a whole-folder FETCH sends its first response after one envelope page, not all of them', async () => {
		const folder = makeFolder(range(1, 3_000));
		const lines = await runFetch(folder, 3_000, { set: '1:*', itemsToken: '(UID)', byUid: false });

		expect(lines.filter((l) => l.startsWith('* '))).toHaveLength(3_000);
		// 4 UID pages (3 full + the empty completion page) and one envelope page.
		expect(folder.counters.callsBeforeFirstResponse).toBe(folder.counters.uidPages + 1);
		// Still one plain window per page, as a contiguous set always read.
		expect(folder.counters.envelopeReads.every((r) => r.ranges === undefined)).toBe(true);
		expect(folder.counters.envelopeDocs).toBe(3_000);
	});
});

describe('sparse STORE resolves only the named message ids', () => {
	it('UID STORE 1,10000 reads two id rows and reports true sequence numbers', async () => {
		const folder = makeFolder(range(1, 10_000));
		const lines: string[] = [];
		const args: StoreArgs = {
			set: '1,10000',
			silent: false,
			mode: 'add',
			flagsToken: '(\\Flagged)',
			byUid: true,
		};
		await storeModule.start({
			deps: { convex: folder.convex } as unknown as CommandDeps,
			state: selectedState(10_000),
			args,
			tag: 'a1',
			verb: 'STORE' as ImapVerb,
			send: (line: string) => lines.push(line),
		} as StartArgs<StoreArgs>).completion;

		expect(folder.counters.idDocs).toBe(2);
		expect(folder.counters.idReads).toBe(1);
		expect(folder.convex.mutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ messageIds: ['m-1', 'm-10000'] })
		);
		expect(lines).toEqual([
			'* 1 FETCH (UID 1 MODSEQ (2) FLAGS (\\Flagged))',
			'* 10000 FETCH (UID 10000 MODSEQ (10001) FLAGS (\\Flagged))',
			'a1 OK UID STORE completed',
		]);
	});
});

describe('uidRuns', () => {
	it('splits on sequence gaps, so each range holds only resolved messages', () => {
		const map = buildSeqMap([2, 4, 6, 8, 10, 12]);
		expect(uidRuns(resolveSet(map, '1:2,4,6', false))).toEqual([
			{ low: 2, high: 4 },
			{ low: 8, high: 8 },
			{ low: 12, high: 12 },
		]);
		// UID gaps inside a run of positions do not split it: nothing lies between.
		expect(uidRuns(resolveSet(map, '2:12', true))).toEqual([{ low: 2, high: 12 }]);
		expect(uidRuns([])).toEqual([]);
	});
});
