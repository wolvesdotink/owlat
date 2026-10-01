/**
 * PR-61 — IDLE must push the full set of unsolicited mailbox changes a
 * second client makes, not just `* n EXISTS`.
 *
 * Two clients on one folder: A enters IDLE; B mutates the folder. The poll
 * loop must translate what it observes into the RFC 3501 §7.4 responses:
 *
 *   (1) B APPENDs            → A gets `* n EXISTS`
 *   (2) B STOREs \Seen UID 1 → A gets `* 1 FETCH (… FLAGS (\Seen))`
 *   (3) B \Deleted + EXPUNGE → A gets `* k EXPUNGE`, NOT a lower EXISTS
 *
 * Before the fix only (1) worked: a modseq bump was swallowed (no FETCH)
 * and a count decrease emitted a (wrong) lower EXISTS instead of EXPUNGE.
 *
 * RFC 2177 (IDLE); RFC 3501 §7.4.1 (EXPUNGE), §7.4.2 (FETCH/EXISTS).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getFunctionName } from 'convex/server';
import { idleModule, diffIdle } from '../commands/idle/index.js';
import { dispatch } from '../commands/walker.js';
import type { FetchEnvelope } from '../commands/fetch/format.js';
import type {
	CommandDeps,
	CommandSession,
	ConnectionState,
	SelectedState,
	StartArgs,
} from '../commands/types.js';

// convex/server declares AnyFunctionReference without exporting it.
type AnyFunctionReference = Parameters<typeof getFunctionName>[0];

vi.mock('../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

interface MockConvex {
	query: ReturnType<typeof vi.fn>;
	mutation: ReturnType<typeof vi.fn>;
	action: ReturnType<typeof vi.fn>;
}

const SELECTED: SelectedState = {
	folderId: 'f1',
	folderName: 'INBOX',
	role: 'inbox',
	uidValidity: 4242,
	uidNext: 3,
	highestModseq: 7,
	totalCount: 2,
	readOnly: false,
};

function selectedState(over: Partial<SelectedState> = {}): ConnectionState {
	return {
		auth: { mailboxId: 'mb1', appPasswordId: 'ap1', address: 'a@t', userId: 'u1' },
		selected: { ...SELECTED, ...over },
		clientId: null,
	};
}

function makeDeps(convex: MockConvex): {
	deps: CommandDeps;
	committed: ConnectionState[];
} {
	const committed: ConnectionState[] = [];
	const deps = {
		convex: convex as never,
		config: { idleTimeoutMs: 30 * 60 * 1000 },
		rateLimiter: {} as never,
		remoteIp: '10.0.0.1',
		capabilityLine: 'CAPABILITY IMAP4rev1',
		tls: true,
		closeConnection: vi.fn(),
		commit: (s: ConnectionState) => committed.push(s),
	} as unknown as CommandDeps;
	return { deps, committed };
}

function startArgs(
	deps: CommandDeps,
	state: ConnectionState
): { start: StartArgs<void>; lines: string[] } {
	const lines: string[] = [];
	return {
		start: {
			deps,
			state,
			args: undefined,
			tag: 'a1',
			verb: 'IDLE',
			send: (l) => lines.push(l as string),
		},
		lines,
	};
}

function mockConvex(): MockConvex {
	return { query: vi.fn(), mutation: vi.fn(), action: vi.fn() };
}

/** Minimal envelope row carrying just the fields the FLAGS push reads. */
function envelope(over: Partial<FetchEnvelope> & { uid: number; modseq: number }): FetchEnvelope {
	return {
		_id: `m${over.uid}`,
		rawSize: 100,
		rfc822MessageId: `id${over.uid}@t`,
		fromAddress: 'b@t',
		toAddresses: ['a@t'],
		ccAddresses: [],
		bccAddresses: [],
		subject: 's',
		internalDate: 0,
		flagSeen: false,
		flagFlagged: false,
		flagAnswered: false,
		flagDraft: false,
		flagDeleted: false,
		customFlags: [],
		...over,
	};
}

/** Run every queued poll tick (the module polls on a 5s interval). */
async function flushPoll(): Promise<void> {
	await vi.advanceTimersByTimeAsync(5_000);
}

describe('IDLE — pushes EXISTS + FETCH FLAGS + EXPUNGE during a single IDLE (PR-61)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('two clients on one folder: A sees B’s append, flag-change, and expunge live', async () => {
		const convex = mockConvex();
		// Folder starts with UIDs 1,2 / count 2 / modseq 7 (matches SELECTED).
		// The query mock answers by function-ref + args across the three poll
		// ticks. peekFolderModseq returns counters; listFolderUidsPage returns the
		// live UID list as one page; fetchChangedEnvelopes returns the rows the
		// `by_folder_and_modseq` index would yield for modseq > modseqSince.
		convex.query.mockImplementation(
			(fnRef: AnyFunctionReference, qargs: Record<string, unknown>) => {
				const ref = getFunctionName(fnRef);
				if (ref === 'mail/imap/session:peekFolderModseq') return Promise.resolve(peek);
				if (ref === 'mail/imap/fetch:folderMembershipPage') return Promise.resolve(null);
				if (ref === 'mail/imap/fetch:listFolderUidsPage') {
					return Promise.resolve({ uids, nextUid: null });
				}
				if (ref === 'mail/imap/fetch:fetchChangedEnvelopes') {
					const since = (qargs['modseqSince'] as number) ?? 0;
					return Promise.resolve({
						page: rows.filter((r) => r.modseq > since),
						isDone: true,
						continueCursor: null,
					});
				}
				return Promise.resolve(null);
			}
		);

		// Mutable folder fixtures the implementation reads each tick.
		let peek = { highestModseq: 7, uidNext: 3, totalCount: 2, unseenCount: 2 };
		let uids: number[] = [1, 2];
		let rows: FetchEnvelope[] = [];

		const { deps, committed } = makeDeps(convex);
		// The client's sequence view, as SELECT left it.
		const view = { uids: [1, 2] as readonly number[] };
		const { start, lines } = startArgs(deps, selectedState({ view }));
		const session: CommandSession = idleModule.start(start);

		expect(lines[0]).toBe('+ idling');

		// ── (1) B APPENDs a new message (UID 3) → count 2→3, modseq bumps.
		peek = { highestModseq: 8, uidNext: 4, totalCount: 3, unseenCount: 3 };
		uids = [1, 2, 3];
		rows = [envelope({ uid: 3, modseq: 8, flagSeen: false })]; // arrival, not a flag-change push
		await flushPoll();
		expect(lines).toContain('* 3 EXISTS');
		// The appended message must NOT also produce a spurious FETCH FLAGS row.
		expect(lines.some((l) => /^\* \d+ FETCH/.test(l))).toBe(false);

		// ── (2) B STOREs \Seen on UID 1 → modseq bumps, count unchanged.
		peek = { highestModseq: 9, uidNext: 4, totalCount: 3, unseenCount: 2 };
		uids = [1, 2, 3];
		rows = [envelope({ uid: 1, modseq: 9, flagSeen: true })];
		await flushPoll();
		expect(lines).toContain('* 1 FETCH (UID 1 MODSEQ (9) FLAGS (\\Seen))');

		// ── (3) B marks UID 2 \Deleted then EXPUNGEs it → count 3→2.
		peek = { highestModseq: 10, uidNext: 4, totalCount: 2, unseenCount: 2 };
		uids = [1, 3]; // UID 2 gone
		rows = []; // the expunged row is no longer fetchable
		await flushPoll();
		// UID 2 was sequence number 2 in the pre-expunge view (1,2,3).
		expect(lines).toContain('* 2 EXPUNGE');
		// A count DECREASE must never be reported as a lower EXISTS.
		expect(lines).not.toContain('* 2 EXISTS');

		// ── A's DONE → tagged OK.
		const verdict = session.onClientLine?.('DONE');
		expect(verdict).toBe('absorbed');
		await session.completion;
		expect(lines[lines.length - 1]).toBe('a1 OK IDLE terminated');

		// The tracked SelectedState the pump commits reflects the final folder.
		expect(committed.at(-1)!.selected!.totalCount).toBe(2);
		expect(committed.at(-1)!.selected!.highestModseq).toBe(10);
		expect(committed.at(-1)!.selected!.uidNext).toBe(4);
		// …and the view holds what the client was told: UID 3 arrived, UID 2 went.
		expect(view.uids).toEqual([1, 3]);
		expect(committed.at(-1)!.selected!.view).toBe(view);
	});

	it('refuses IDLE without a SELECTed mailbox', async () => {
		// The precondition is IDLE's declared `requires`, enforced by the
		// walker before `start` runs.
		const convex = mockConvex();
		const { deps } = makeDeps(convex);
		const lines: string[] = [];
		const session = dispatch(
			deps,
			{
				auth: { mailboxId: 'mb1', appPasswordId: 'ap1', address: 'a@t', userId: 'u1' },
				selected: null,
				clientId: null,
			},
			{ tag: 'a1', command: 'IDLE', args: [] },
			(l) => lines.push(l as string)
		);
		await session.completion;
		expect(lines).toEqual(['a1 BAD No mailbox selected']);
		expect(convex.query).not.toHaveBeenCalled();
	});
});

describe('IDLE — a poll never outlives its session or overlaps the next tick', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	type Read =
		| 'mail/imap/session:peekFolderModseq'
		| 'mail/imap/fetch:listFolderUidsPage'
		| 'mail/imap/fetch:fetchChangedEnvelopes';

	/**
	 * A folder that starts as UIDs 1,2 (matching SELECTED) and, from the first
	 * poll on, reads as "UID 1 expunged, UID 2 marked \Seen". `hold(read)`
	 * makes the next call to that read wait for `release()`; the IDLE seed's
	 * own UID read is never held. `uidPages` splits the post-change UID list
	 * into that many pages.
	 */
	function changedFolder(uidPages = 1) {
		const convex = mockConvex();
		let held: { read: Read; gate: Promise<void> } | null = null;
		let release = (): void => {};
		let seeded = false;
		const answer = (ref: string, qargs: Record<string, unknown>): unknown => {
			if (ref === 'mail/imap/session:peekFolderModseq') {
				return { highestModseq: 8, uidNext: 3, totalCount: 1, unseenCount: 0 };
			}
			if (ref === 'mail/imap/fetch:listFolderUidsPage') {
				if (!seeded) {
					seeded = true;
					return { uids: [1, 2], nextUid: null };
				}
				// One UID (2) is left; extra pages are empty, each advancing.
				const after = (qargs['afterUid'] as number | undefined) ?? 0;
				const page = after === 0 ? 1 : after - 1;
				return { uids: page === 1 ? [2] : [], nextUid: page < uidPages ? page + 2 : null };
			}
			if (ref === 'mail/imap/fetch:fetchChangedEnvelopes') {
				return {
					page: [envelope({ uid: 2, modseq: 8, flagSeen: true })],
					isDone: true,
					continueCursor: null,
				};
			}
			return null;
		};
		convex.query.mockImplementation(
			(fnRef: AnyFunctionReference, qargs: Record<string, unknown>) => {
				const ref = getFunctionName(fnRef);
				const value = answer(ref, qargs);
				if (held && held.read === ref && seeded) {
					const { gate } = held;
					held = null;
					return gate.then(() => value);
				}
				return Promise.resolve(value);
			}
		);
		const calls = (ref: Read): number =>
			convex.query.mock.calls.filter(([r]) => getFunctionName(r as AnyFunctionReference) === ref)
				.length;
		return {
			convex,
			calls,
			hold(read: Read): void {
				held = {
					read,
					gate: new Promise<void>((resolve) => {
						release = resolve;
					}),
				};
			},
			release: () => release(),
		};
	}

	it.each<Read>([
		'mail/imap/session:peekFolderModseq',
		'mail/imap/fetch:listFolderUidsPage',
		'mail/imap/fetch:fetchChangedEnvelopes',
	])(
		'DONE while the poll waits on %s: nothing is written or committed afterwards',
		async (read) => {
			const folder = changedFolder();
			const { deps, committed } = makeDeps(folder.convex);
			const { start, lines } = startArgs(deps, selectedState());
			const session = idleModule.start(start);
			await vi.advanceTimersByTimeAsync(0); // seed the client's UID view

			folder.hold(read);
			await flushPoll();
			expect(folder.calls(read)).toBeGreaterThanOrEqual(1);
			expect(lines).toEqual(['+ idling']);

			expect(session.onClientLine?.('DONE')).toBe('absorbed');
			await session.completion;
			expect(lines).toEqual(['+ idling', 'a1 OK IDLE terminated']);
			const commits = committed.length;

			folder.release();
			await vi.advanceTimersByTimeAsync(30_000);

			expect(lines).toEqual(['+ idling', 'a1 OK IDLE terminated']);
			expect(committed).toHaveLength(commits);
			expect(folder.calls('mail/imap/session:peekFolderModseq')).toBe(1);
		}
	);

	it('server timeout while a poll is in flight: the late result is dropped', async () => {
		const folder = changedFolder();
		const { deps } = makeDeps(folder.convex);
		const timedDeps = { ...deps, config: { ...deps.config, idleTimeoutMs: 7_000 } };
		const { start, lines } = startArgs(timedDeps, selectedState());
		const session = idleModule.start(start);
		await vi.advanceTimersByTimeAsync(0);

		folder.hold('mail/imap/session:peekFolderModseq');
		await flushPoll();
		await vi.advanceTimersByTimeAsync(2_000); // 7s: the idle timer fires
		await session.completion;
		const ended = [
			'+ idling',
			'* OK [TIMEOUT] IDLE timeout — re-issue IDLE',
			'a1 OK IDLE terminated by server',
		];
		expect(lines).toEqual(ended);

		folder.release();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(lines).toEqual(ended);
	});

	it('disconnect mid page walk: the walk stops reading and nothing is written', async () => {
		// Three UID pages: the first is held, the other two must never be read.
		const folder = changedFolder(3);
		const { deps, committed } = makeDeps(folder.convex);
		const { start, lines } = startArgs(deps, selectedState());
		const session = idleModule.start(start);
		await vi.advanceTimersByTimeAsync(0);

		folder.hold('mail/imap/fetch:listFolderUidsPage');
		await flushPoll();
		const uidReads = folder.calls('mail/imap/fetch:listFolderUidsPage');

		session.cancel();
		await session.completion;
		const commits = committed.length;

		folder.release();
		await vi.advanceTimersByTimeAsync(30_000);

		expect(folder.calls('mail/imap/fetch:listFolderUidsPage')).toBe(uidReads);
		expect(folder.calls('mail/imap/fetch:fetchChangedEnvelopes')).toBe(0);
		expect(lines).toEqual(['+ idling']);
		expect(committed).toHaveLength(commits);
	});

	it('a poll slower than the interval is not overlapped, and its responses keep their order', async () => {
		const folder = changedFolder();
		const { deps, committed } = makeDeps(folder.convex);
		const { start, lines } = startArgs(deps, selectedState());
		const session = idleModule.start(start);
		await vi.advanceTimersByTimeAsync(0);

		folder.hold('mail/imap/session:peekFolderModseq');
		await flushPoll();
		// Three more intervals pass while the first poll still waits.
		await vi.advanceTimersByTimeAsync(15_000);
		expect(folder.calls('mail/imap/session:peekFolderModseq')).toBe(1);

		folder.release();
		await vi.advanceTimersByTimeAsync(0);
		// EXPUNGE against the client's old view first, then FLAGS at the new seq.
		expect(lines).toEqual([
			'+ idling',
			'* 1 EXPUNGE',
			'* 1 FETCH (UID 2 MODSEQ (8) FLAGS (\\Seen))',
		]);

		// The next poll follows a full interval later and finds nothing new.
		await flushPoll();
		expect(folder.calls('mail/imap/session:peekFolderModseq')).toBe(2);
		expect(lines).toHaveLength(3);

		session.onClientLine?.('DONE');
		await session.completion;
		expect(committed.at(-1)!.selected).toMatchObject({ totalCount: 1, highestModseq: 8 });
	});
});

describe('diffIdle — pure RFC 3501 §7.4 response computation', () => {
	const base = {
		prevUids: [1, 2, 3] as readonly number[],
		nextUids: [1, 2, 3] as readonly number[],
		prevTotal: 3,
		nextTotal: 3,
		nextUidNext: 4,
		lastModseq: 7,
		changedRows: [] as readonly FetchEnvelope[],
	};

	it('emits EXISTS whenever a UID arrived, never on a pure decrease or no-op', () => {
		// Pure append: count grew, new UID 4 present → EXISTS 4.
		expect(diffIdle({ ...base, nextUids: [1, 2, 3, 4], nextTotal: 4, nextUidNext: 5 }).exists).toBe(
			4
		);
		// Pure expunge: count dropped, no new UID → no EXISTS.
		expect(diffIdle({ ...base, nextUids: [1, 2], nextTotal: 2 }).exists).toBeUndefined();
		// No change at all → no EXISTS.
		expect(diffIdle(base).exists).toBeUndefined();
	});

	it('emits EXISTS for a mixed append+expunge window that nets to a *lower* count', () => {
		// One coalesced 5s window: UIDs 2,3 expunged AND UID 4 appended.
		// Count 3→2 (a decrease) yet a new message arrived — RFC 3501 §7.4.1
		// still requires EXISTS so the client doesn't silently lose UID 4.
		const delta = diffIdle({
			...base,
			prevUids: [1, 2, 3],
			nextUids: [1, 4],
			prevTotal: 3,
			nextTotal: 2,
			nextUidNext: 5,
		});
		// Both expunges announced first, descending against the prior view…
		expect(delta.expunged).toEqual([3, 2]);
		// …and the arrival announced via the new total, not hidden behind them.
		expect(delta.exists).toBe(2);
		expect(delta.uidNext).toBe(5);
	});

	it('emits EXISTS for a mixed window that nets to an *unchanged* count', () => {
		// 1 append + 1 expunge → count stays 3 but UID 4 is new.
		const delta = diffIdle({
			...base,
			prevUids: [1, 2, 3],
			nextUids: [1, 2, 4],
			prevTotal: 3,
			nextTotal: 3,
			nextUidNext: 5,
		});
		expect(delta.expunged).toEqual([3]);
		expect(delta.exists).toBe(3);
	});

	it('resolves expunged UIDs to DESCENDING sequence numbers against the prior view', () => {
		// Drop UID 2 (seq 2) and UID 4 (seq 4) from a 1,2,3,4 view.
		const delta = diffIdle({
			...base,
			prevUids: [1, 2, 3, 4],
			nextUids: [1, 3],
			prevTotal: 4,
			nextTotal: 2,
		});
		expect(delta.expunged).toEqual([4, 2]);
		expect(delta.exists).toBeUndefined();
	});

	it('pushes a FETCH FLAGS line per changed pre-existing row at its current seq', () => {
		const delta = diffIdle({
			...base,
			changedRows: [envelope({ uid: 1, modseq: 9, flagSeen: true })],
		});
		expect(delta.fetches).toEqual(['* 1 FETCH (UID 1 MODSEQ (9) FLAGS (\\Seen))']);
	});

	it('does NOT push FETCH FLAGS for a brand-new (appended) UID — EXISTS covers it', () => {
		const delta = diffIdle({
			...base,
			nextUids: [1, 2, 3, 4],
			nextTotal: 4,
			nextUidNext: 5,
			changedRows: [envelope({ uid: 4, modseq: 8 })],
		});
		expect(delta.exists).toBe(4);
		expect(delta.fetches).toEqual([]);
	});

	it('does NOT push FETCH FLAGS for a row that was expunged this poll', () => {
		const delta = diffIdle({
			...base,
			prevUids: [1, 2, 3],
			nextUids: [1, 3],
			prevTotal: 3,
			nextTotal: 2,
			changedRows: [envelope({ uid: 2, modseq: 9, flagDeleted: true })],
		});
		expect(delta.expunged).toEqual([2]);
		expect(delta.fetches).toEqual([]);
	});
});
