/**
 * PR-62 regression-lock for the IMAP write/UID commands, exercised at the
 * module level (real `parseArgs` + `start`, a fake `send`, a stubbed
 * ConvexClient). Covers:
 *
 *   (6) EXPUNGE — descending `* n EXPUNGE` order, `\Deleted`-only scope
 *       (driven by the convex contract), and the folder modseq bump applied
 *       to the committed SelectedState.
 *   (7) UIDPLUS — COPYUID / APPENDUID carry the folder's uidValidity, and
 *       UID EXPUNGE threads the UID set through to the mutation.
 *   (8) CONDSTORE — UNCHANGEDSINCE is passed to the mutation, [MODIFIED] is
 *       reported for skipped UIDs, and the modseq the client sees is
 *       monotonic across stores.
 *
 * RFC 3501 §6.4.3 (EXPUNGE), RFC 4315 (UIDPLUS), RFC 7162 (CONDSTORE).
 */

import { describe, it, expect, vi } from 'vitest';
import { expungeModule } from '../expunge/index.js';
import { copyModule } from '../copy/index.js';
import { storeModule } from '../store/index.js';
import { uidModule } from '../uid/index.js';
import type {
	CommandDeps,
	ConnectionState,
	SelectedState,
	StartArgs,
} from '../types.js';

vi.mock('../../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

interface MockConvex {
	query: ReturnType<typeof vi.fn>;
	mutation: ReturnType<typeof vi.fn>;
	action: ReturnType<typeof vi.fn>;
}

function makeDeps(convex: MockConvex): { deps: CommandDeps; committed: ConnectionState[] } {
	const committed: ConnectionState[] = [];
	const deps = {
		convex: convex as never,
		config: {} as never,
		rateLimiter: {} as never,
		remoteIp: '10.0.0.1',
		capabilityLine: 'CAPABILITY IMAP4rev1',
		tls: true,
		closeConnection: vi.fn(),
		commit: (s: ConnectionState) => committed.push(s),
	} as unknown as CommandDeps;
	return { deps, committed };
}

const SELECTED: SelectedState = {
	folderId: 'f1',
	folderName: 'INBOX',
	role: 'inbox',
	uidValidity: 4242,
	uidNext: 11,
	highestModseq: 7,
	totalCount: 5,
	readOnly: false,
};

function selectedState(over: Partial<SelectedState> = {}): ConnectionState {
	return {
		auth: { mailboxId: 'mb1', appPasswordId: 'ap1', address: 'a@t', userId: 'u1' },
		selected: { ...SELECTED, ...over },
		clientId: null,
	};
}

/** Build a StartArgs for a module's `start`, capturing emitted lines. */
function startArgs<T>(
	deps: CommandDeps,
	state: ConnectionState,
	args: T,
	verb: StartArgs<T>['verb'],
): { start: StartArgs<T>; lines: string[] } {
	const lines: string[] = [];
	return {
		start: { deps, state, args, tag: 'a1', verb, send: (l: string) => lines.push(l) },
		lines,
	};
}

function mockConvex(): MockConvex {
	return { query: vi.fn(), mutation: vi.fn(), action: vi.fn() };
}

describe('EXPUNGE — descending order + \\Deleted-only + modseq bump (RFC 3501 §6.4.3)', () => {
	it('emits * n EXPUNGE in strictly DESCENDING sequence order', async () => {
		const convex = mockConvex();
		// Convex returns ascending sequence numbers; the module must reverse them.
		convex.mutation.mockResolvedValue({ sequenceNumbers: [2, 4, 5], modseq: 9 });
		const { deps } = makeDeps(convex);
		const parsed = expungeModule.parseArgs([]);
		expect(parsed.ok).toBe(true);
		const { start, lines } = startArgs(deps, selectedState(), (parsed as { args: never }).args, 'EXPUNGE');
		await expungeModule.start(start).completion;

		const expunges = lines.filter((l) => l.endsWith('EXPUNGE'));
		expect(expunges).toEqual(['* 5 EXPUNGE', '* 4 EXPUNGE', '* 2 EXPUNGE']);
		expect(lines.pop()).toBe('a1 OK EXPUNGE completed');
	});

	it('delegates the \\Deleted-only filter to the convex mutation (no client-side uidSet for bare EXPUNGE)', async () => {
		const convex = mockConvex();
		convex.mutation.mockResolvedValue({ sequenceNumbers: [], modseq: 8 });
		const { deps } = makeDeps(convex);
		const parsed = expungeModule.parseArgs([]);
		const { start } = startArgs(deps, selectedState(), (parsed as { args: never }).args, 'EXPUNGE');
		await expungeModule.start(start).completion;

		// Bare EXPUNGE sends no uidSet — the convex side scans \Deleted only.
		expect(convex.mutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ folderId: 'f1', uidSet: undefined }),
		);
	});

	it('commits the bumped modseq + decremented totalCount onto SelectedState', async () => {
		const convex = mockConvex();
		convex.mutation.mockResolvedValue({ sequenceNumbers: [1, 2], modseq: 12 });
		const { deps, committed } = makeDeps(convex);
		const parsed = expungeModule.parseArgs([]);
		const { start } = startArgs(deps, selectedState(), (parsed as { args: never }).args, 'EXPUNGE');
		await expungeModule.start(start).completion;

		expect(committed).toHaveLength(1);
		expect(committed[0]!.selected!.highestModseq).toBe(12); // monotonic bump
		expect(committed[0]!.selected!.totalCount).toBe(SELECTED.totalCount - 2);
	});

	it('refuses EXPUNGE on a read-only mailbox', async () => {
		const convex = mockConvex();
		const { deps } = makeDeps(convex);
		const parsed = expungeModule.parseArgs([]);
		const { start, lines } = startArgs(
			deps,
			selectedState({ readOnly: true }),
			(parsed as { args: never }).args,
			'EXPUNGE',
		);
		await expungeModule.start(start).completion;
		expect(lines.pop()).toBe('a1 NO Mailbox is read-only');
		expect(convex.mutation).not.toHaveBeenCalled();
	});
});

describe('UIDPLUS — COPYUID carries the folder uidValidity (RFC 4315)', () => {
	it('emits [COPYUID <uidvalidity> <src> <dst>] from the mutation result', async () => {
		const convex = mockConvex();
		convex.query
			.mockResolvedValueOnce([{ _id: 'tf', name: 'Archive', role: 'archive' }]) // resolveFolderByName
			.mockResolvedValueOnce([{ _id: 'm1' }, { _id: 'm2' }]); // resolveMessageIdsByUid
		convex.mutation.mockResolvedValue({
			uidValidity: 9999,
			pairs: [
				{ sourceUid: 3, targetUid: 17 },
				{ sourceUid: 4, targetUid: 18 },
			],
		});
		const { deps } = makeDeps(convex);
		const parsed = copyModule.parseArgs(['3:4', 'Archive']);
		expect(parsed.ok).toBe(true);
		const { start, lines } = startArgs(deps, selectedState(), (parsed as { args: never }).args, 'COPY');
		await copyModule.start(start).completion;

		expect(lines.pop()).toBe('a1 OK [COPYUID 9999 3,4 17,18] COPY completed');
	});
});

describe('UIDPLUS — UID EXPUNGE honors the UID set (RFC 4315 §2.1)', () => {
	it('threads the parsed UID set into the expunge mutation', async () => {
		const convex = mockConvex();
		convex.mutation.mockResolvedValue({ sequenceNumbers: [3], modseq: 13 });
		const { deps } = makeDeps(convex);

		const parsed = uidModule.parseArgs(['EXPUNGE', '5,7:8']);
		expect(parsed.ok).toBe(true);
		const { start, lines } = startArgs(deps, selectedState(), (parsed as { args: never }).args, 'UID');
		await uidModule.start(start).completion;

		// 5,7:8 → {5,7,8}; bare EXPUNGE would send uidSet undefined.
		expect(convex.mutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ folderId: 'f1', uidSet: [5, 7, 8] }),
		);
		expect(lines.pop()).toBe('a1 OK UID EXPUNGE completed');
	});

	it('UID EXPUNGE with no UID set falls back to a whole-folder \\Deleted sweep', async () => {
		const convex = mockConvex();
		convex.mutation.mockResolvedValue({ sequenceNumbers: [], modseq: 8 });
		const { deps } = makeDeps(convex);
		const parsed = uidModule.parseArgs(['EXPUNGE']);
		const { start } = startArgs(deps, selectedState(), (parsed as { args: never }).args, 'UID');
		await uidModule.start(start).completion;
		expect(convex.mutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ uidSet: undefined }),
		);
	});
});

describe('CONDSTORE — UNCHANGEDSINCE skip + [MODIFIED] + monotonic modseq (RFC 7162)', () => {
	it('passes UNCHANGEDSINCE through to storeFlags as unchangedSinceModseq', async () => {
		const convex = mockConvex();
		convex.query
			.mockResolvedValueOnce([1]) // listFolderUids
			.mockResolvedValueOnce([{ _id: 'm1', uid: 1 }]); // resolveMessageIdsByUid
		convex.mutation.mockResolvedValue({
			updated: [{ uid: 1, modseq: 8, flags: ['\\Seen'] }],
			unchanged: [],
		});
		const { deps } = makeDeps(convex);
		const parsed = storeModule.parseArgs(['1', '(UNCHANGEDSINCE 5)', '+FLAGS', '(\\Seen)']);
		expect(parsed.ok).toBe(true);
		expect((parsed as { args: { unchangedSince?: number } }).args.unchangedSince).toBe(5);

		const { start } = startArgs(deps, selectedState(), (parsed as { args: never }).args, 'STORE');
		await storeModule.start(start).completion;

		expect(convex.mutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ unchangedSinceModseq: 5, mode: 'add', flags: ['\\Seen'] }),
		);
	});

	it('reports [MODIFIED <uids>] for messages the UNCHANGEDSINCE guard skipped', async () => {
		const convex = mockConvex();
		convex.query
			.mockResolvedValueOnce([1, 2]) // listFolderUids
			.mockResolvedValueOnce([
				{ _id: 'm1', uid: 1 },
				{ _id: 'm2', uid: 2 },
			]); // resolveMessageIdsByUid
		convex.mutation.mockResolvedValue({
			updated: [{ uid: 1, modseq: 9, flags: ['\\Flagged'] }],
			unchanged: [{ uid: 2 }],
		});
		const { deps } = makeDeps(convex);
		const parsed = storeModule.parseArgs(['1:2', '(UNCHANGEDSINCE 8)', '+FLAGS', '(\\Flagged)']);
		const { start, lines } = startArgs(deps, selectedState(), (parsed as { args: never }).args, 'STORE');
		await storeModule.start(start).completion;

		// The updated row reports its NEW (higher) modseq, the skipped uid 2 is
		// listed in the [MODIFIED] response code.
		expect(lines.some((l) => l.includes('FETCH (UID 1 MODSEQ (9) FLAGS (\\Flagged))'))).toBe(true);
		expect(lines.pop()).toBe('a1 OK [MODIFIED 2] STORE completed');
	});

	it('the MODSEQ a client sees is monotonic across two stores', async () => {
		const convex = mockConvex();
		const { deps } = makeDeps(convex);

		// First store → modseq 8.
		convex.query
			.mockResolvedValueOnce([1]) // listFolderUids
			.mockResolvedValueOnce([{ _id: 'm1', uid: 1 }]); // resolveMessageIdsByUid
		convex.mutation.mockResolvedValueOnce({
			updated: [{ uid: 1, modseq: 8, flags: ['\\Seen'] }],
			unchanged: [],
		});
		const p1 = storeModule.parseArgs(['1', '+FLAGS', '(\\Seen)']);
		const a1 = startArgs(deps, selectedState(), (p1 as { args: never }).args, 'STORE');
		await storeModule.start(a1.start).completion;
		const m1 = Number(a1.lines.find((l) => l.includes('MODSEQ'))!.match(/MODSEQ \((\d+)\)/)![1]);

		// Second store → modseq 9 (strictly greater).
		convex.query
			.mockResolvedValueOnce([1]) // listFolderUids
			.mockResolvedValueOnce([{ _id: 'm1', uid: 1 }]); // resolveMessageIdsByUid
		convex.mutation.mockResolvedValueOnce({
			updated: [{ uid: 1, modseq: 9, flags: ['\\Seen', '\\Flagged'] }],
			unchanged: [],
		});
		const p2 = storeModule.parseArgs(['1', '+FLAGS', '(\\Flagged)']);
		const a2 = startArgs(deps, selectedState(), (p2 as { args: never }).args, 'STORE');
		await storeModule.start(a2.start).completion;
		const m2 = Number(a2.lines.find((l) => l.includes('MODSEQ'))!.match(/MODSEQ \((\d+)\)/)![1]);

		expect(m2).toBeGreaterThan(m1);
	});

	it('omits the per-row FETCH on .SILENT but still answers OK', async () => {
		const convex = mockConvex();
		convex.query
			.mockResolvedValueOnce([1]) // listFolderUids
			.mockResolvedValueOnce([{ _id: 'm1', uid: 1 }]); // resolveMessageIdsByUid
		convex.mutation.mockResolvedValue({
			updated: [{ uid: 1, modseq: 8, flags: ['\\Seen'] }],
			unchanged: [],
		});
		const { deps } = makeDeps(convex);
		const parsed = storeModule.parseArgs(['1', '+FLAGS.SILENT', '(\\Seen)']);
		expect((parsed as { args: { silent: boolean } }).args.silent).toBe(true);
		const { start, lines } = startArgs(deps, selectedState(), (parsed as { args: never }).args, 'STORE');
		await storeModule.start(start).completion;

		expect(lines.some((l) => l.includes('FETCH'))).toBe(false);
		expect(lines.pop()).toBe('a1 OK STORE completed');
	});
});
