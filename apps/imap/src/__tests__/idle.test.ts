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
import { idleModule, diffIdle } from '../commands/idle/index.js';
import type { FetchEnvelope } from '../commands/fetch/format.js';
import type {
	CommandDeps,
	CommandSession,
	ConnectionState,
	SelectedState,
	StartArgs,
} from '../commands/types.js';

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
	state: ConnectionState,
): { start: StartArgs<void>; lines: string[] } {
	const lines: string[] = [];
	return {
		start: {
			deps,
			state,
			args: undefined,
			tag: 'a1',
			verb: 'IDLE',
			send: (l: string) => lines.push(l),
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
		// ticks. peekFolderModseq returns counters; listFolderUids returns the
		// live UID list; fetchEnvelopes returns rows changed since modseqSince.
		convex.query.mockImplementation((ref: string, qargs: Record<string, unknown>) => {
			if (ref === 'mail/imap:peekFolderModseq') return Promise.resolve(peek);
			if (ref === 'mail/imap:listFolderUids') return Promise.resolve(uids);
			if (ref === 'mail/imap:fetchEnvelopes') {
				const since = (qargs.modseqSince as number) ?? 0;
				return Promise.resolve(rows.filter((r) => r.modseq > since));
			}
			return Promise.resolve(null);
		});

		// Mutable folder fixtures the implementation reads each tick.
		let peek = { highestModseq: 7, uidNext: 3, totalCount: 2, unseenCount: 2 };
		let uids: number[] = [1, 2];
		let rows: FetchEnvelope[] = [];

		const { deps, committed } = makeDeps(convex);
		const { start, lines } = startArgs(deps, selectedState());
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
	});

	it('refuses IDLE without a SELECTed mailbox', async () => {
		const convex = mockConvex();
		const { deps } = makeDeps(convex);
		const { start, lines } = startArgs(deps, {
			auth: { mailboxId: 'mb1', appPasswordId: 'ap1', address: 'a@t', userId: 'u1' },
			selected: null,
			clientId: null,
		});
		const session = idleModule.start(start);
		await session.completion;
		expect(lines.some((l) => l.includes('a1 BAD') || l.includes('a1 NO'))).toBe(true);
		expect(convex.query).not.toHaveBeenCalled();
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
		expect(diffIdle({ ...base, nextUids: [1, 2, 3, 4], nextTotal: 4, nextUidNext: 5 }).exists).toBe(4);
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
