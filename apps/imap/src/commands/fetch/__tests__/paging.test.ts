/**
 * The sidecar half of the "never read a whole folder" contract.
 *
 * The Convex reads behind FETCH now answer with one page plus a resume point,
 * so the command modules have to stitch pages back together — and the stitching
 * must not disturb what the wire sees. A `FETCH 1:*` over a folder several
 * pages deep still has to emit every message exactly once, in ascending
 * sequence order, with the TRUE sequence number (RFC 3501 §2.3.1.2), while
 * every individual Convex read stays inside a bounded window.
 *
 * The IDLE poll is checked here too: it must ask `fetchChangedEnvelopes`
 * (`by_folder_and_modseq`) what changed, never a UID window it then filters.
 */

import { describe, expect, it, vi } from 'vitest';
import { fetchModule, type FetchArgs } from '../index.js';
import { idleModule } from '../../idle/index.js';
import { loadChangedEnvelopes } from '../../helpers/folderPaging.js';
import type { FetchEnvelope } from '../format.js';
import type { CommandDeps, ConnectionState, ImapVerb, StartArgs } from '../../types.js';

vi.mock('../../../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Page size the fake backend serves — small, so a 7-UID folder is 3 pages. */
const PAGE = 3;

function envelope(uid: number): FetchEnvelope {
	return {
		_id: `m-${uid}`,
		uid,
		modseq: uid,
		rawSize: 10,
		rfc822MessageId: `mid-${uid}@example.com`,
		fromAddress: 'jane@example.com',
		toAddresses: ['bob@example.com'],
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

interface QueryCall {
	readonly ref: string;
	readonly params: Record<string, unknown>;
}

/**
 * A Convex stub that pages exactly like the backend: `limit` rows at a time,
 * `nextUid` set only when the page came back full.
 */
function makePagingConvex(uids: readonly number[], calls: QueryCall[]) {
	const rows = uids.map(envelope);
	return {
		query: vi.fn(async (ref: string, params: Record<string, unknown>) => {
			calls.push({ ref, params });
			if (ref.endsWith(':listFolderUidsPage')) {
				const after = (params.afterUid as number | undefined) ?? 0;
				const page = uids.filter((u) => u >= after).slice(0, PAGE);
				return {
					uids: page,
					nextUid: page.length < PAGE ? null : (page[page.length - 1] ?? 0) + 1,
				};
			}
			if (ref.endsWith(':fetchEnvelopes')) {
				const low = params.uidLow as number;
				const high = params.uidHigh as number;
				const page = rows.filter((r) => r.uid >= low && r.uid <= high).slice(0, PAGE);
				return {
					rows: page,
					nextUid: page.length < PAGE ? null : (page[page.length - 1]?.uid ?? 0) + 1,
				};
			}
			return null;
		}),
		mutation: vi.fn(),
		action: vi.fn(),
	};
}

function selectedState(total: number): ConnectionState {
	return {
		auth: { mailboxId: 'mb1', appPasswordId: 'ap1', address: 'a@test', userId: 'u1' },
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

describe('FETCH over a folder deeper than one page', () => {
	it('FETCH 1:* emits every message once, in true sequence order', async () => {
		const uids = [2, 4, 6, 8, 10, 12, 14];
		const calls: QueryCall[] = [];
		const convex = makePagingConvex(uids, calls);
		const lines: string[] = [];
		const args: FetchArgs = { set: '1:*', itemsToken: '(UID)', byUid: false };
		const session = fetchModule.start({
			deps: { convex } as unknown as CommandDeps,
			state: selectedState(uids.length),
			args,
			tag: 'a001',
			verb: 'FETCH' as ImapVerb,
			send: (line: string) => lines.push(line as string),
		} as StartArgs<FetchArgs>);
		await session.completion;

		expect(lines.filter((l) => l.startsWith('* '))).toEqual([
			'* 1 FETCH (UID 2)',
			'* 2 FETCH (UID 4)',
			'* 3 FETCH (UID 6)',
			'* 4 FETCH (UID 8)',
			'* 5 FETCH (UID 10)',
			'* 6 FETCH (UID 12)',
			'* 7 FETCH (UID 14)',
		]);
		expect(lines.pop()).toBe('a001 OK FETCH completed');

		// The UID list took three pages, each resuming past the previous one —
		// no single read asked for the folder.
		const uidPages = calls.filter((c) => c.ref.endsWith(':listFolderUidsPage'));
		expect(uidPages.map((c) => c.params.afterUid)).toEqual([undefined, 7, 13]);
		// Envelope reads stay inside the requested 2..14 window.
		const envelopePages = calls.filter((c) => c.ref.endsWith(':fetchEnvelopes'));
		expect(envelopePages.length).toBeGreaterThan(1);
		for (const call of envelopePages) {
			expect(call.params.uidHigh).toBe(14);
			expect(call.params.uidLow as number).toBeGreaterThanOrEqual(2);
		}
	});

	it('a UID FETCH of one message reads only that UID window', async () => {
		const uids = [2, 4, 6, 8, 10, 12, 14];
		const calls: QueryCall[] = [];
		const convex = makePagingConvex(uids, calls);
		const lines: string[] = [];
		const args: FetchArgs = { set: '10', itemsToken: '(UID)', byUid: true };
		const session = fetchModule.start({
			deps: { convex } as unknown as CommandDeps,
			state: selectedState(uids.length),
			args,
			tag: 'a002',
			verb: 'FETCH' as ImapVerb,
			send: (line: string) => lines.push(line as string),
		} as StartArgs<FetchArgs>);
		await session.completion;

		expect(lines.filter((l) => l.startsWith('* '))).toEqual(['* 5 FETCH (UID 10)']);
		const envelopePages = calls.filter((c) => c.ref.endsWith(':fetchEnvelopes'));
		expect(envelopePages).toHaveLength(1);
		expect(envelopePages[0]!.params).toMatchObject({ uidLow: 10, uidHigh: 10 });
	});
});

describe('CHANGEDSINCE reads go through the modseq index', () => {
	it('loadChangedEnvelopes follows the pagination cursor to the end', async () => {
		const pages = [
			{ page: [envelope(1), envelope(2)], isDone: false, continueCursor: 'c1' },
			{ page: [envelope(3)], isDone: true, continueCursor: null },
		];
		const seen: Array<Record<string, unknown>> = [];
		const convex = {
			query: vi.fn(async (ref: string, params: Record<string, unknown>) => {
				expect(ref).toMatch(/:fetchChangedEnvelopes$/);
				seen.push(params);
				return pages[seen.length - 1];
			}),
		};

		const rows = await loadChangedEnvelopes(convex as never, 'f1', 7, 2);

		expect(rows.map((r) => r.uid)).toEqual([1, 2, 3]);
		expect(seen[0]).toMatchObject({ modseqSince: 7 });
		expect(seen[1]!.paginationOpts).toMatchObject({ cursor: 'c1' });
	});

	it('the IDLE poll asks what changed, never a UID window it filters afterwards', async () => {
		vi.useFakeTimers();
		try {
			const refs: string[] = [];
			const convex = {
				query: vi.fn(async (ref: string) => {
					refs.push(ref);
					if (ref.endsWith(':peekFolderModseq')) {
						return { highestModseq: 9, uidNext: 4, totalCount: 3, unseenCount: 1 };
					}
					if (ref.endsWith(':listFolderUidsPage')) return { uids: [1, 2, 3], nextUid: null };
					if (ref.endsWith(':fetchChangedEnvelopes')) {
						return { page: [envelope(1)], isDone: true, continueCursor: null };
					}
					return null;
				}),
				mutation: vi.fn(),
				action: vi.fn(),
			};
			const lines: string[] = [];
			const session = idleModule.start({
				deps: {
					convex,
					config: { idleTimeoutMs: 60_000 },
					commit: () => {},
				} as unknown as CommandDeps,
				state: selectedState(2),
				args: undefined,
				tag: 'a003',
				verb: 'IDLE' as ImapVerb,
				send: (line: string) => lines.push(line as string),
			} as StartArgs<void>);

			await vi.advanceTimersByTimeAsync(5_000);
			session.cancel();
			await session.completion;

			expect(refs).toContain('mail/imap/fetch:fetchChangedEnvelopes');
			expect(refs).not.toContain('mail/imap/fetch:fetchEnvelopes');
		} finally {
			vi.useRealTimers();
		}
	});
});
