/**
 * Message sets that span more messages than one Convex call accepts.
 *
 * Convex rejects an array argument longer than 8,192 elements, so UID EXPUNGE,
 * STORE, COPY and MOVE over a large folder must reach their mutations in
 * batches. The fake backend below enforces that cap and keeps a real in-memory
 * folder, so the tests check both the batching and that the untagged responses
 * still describe the folder correctly (sequence numbers, COPYUID, MODIFIED).
 *
 * The EXPUNGE and MOVE cases run twice: once with the session's sequence view
 * (`SelectedState.view`, set by SELECT), which numbers each expunge against what
 * the client was told, and once without it (a state built by hand), which
 * numbers against the folder as the command read it.
 */

import { describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { copyModule } from '../copy/index.js';
import { moveModule } from '../move/index.js';
import { storeModule } from '../store/index.js';
import { uidModule } from '../uid/index.js';
import type {
	CommandDeps,
	ConnectionState,
	ImapCommandModule,
	ImapVerb,
	SelectedState,
} from '../types.js';

// convex/server declares AnyFunctionReference without exporting it.
type AnyFunctionReference = Parameters<typeof getFunctionName>[0];

vi.mock('../../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Convex's limit on the length of an array argument. */
const CONVEX_ARRAY_LIMIT = 8192;
const LARGE = 20_000;

interface Row {
	uid: number;
	deleted: boolean;
}

interface FakeOptions {
	/** Fail the n-th (1-based) call to this mutation. */
	readonly failCall?: { readonly name: string; readonly call: number };
}

function fakeBackend(rows: Row[], options: FakeOptions = {}) {
	// The selected folder `f1`, ascending by UID; `tf` is the COPY/MOVE target.
	const folder = [...rows].sort((a, b) => a.uid - b.uid);
	const target: Array<{ uid: number; from: number }> = [];
	let targetUidNext = 1_000_000;
	const counts = new Map<string, number>();
	const argLog: Array<{ name: string; args: Record<string, unknown> }> = [];

	const checkCap = (name: string, args: Record<string, unknown>) => {
		for (const value of Object.values(args)) {
			if (Array.isArray(value) && value.length > CONVEX_ARRAY_LIMIT) {
				throw new Error(`${name}: array argument longer than ${CONVEX_ARRAY_LIMIT}`);
			}
		}
	};

	const query = vi.fn(async (ref: AnyFunctionReference, args: Record<string, number>) => {
		const name = getFunctionName(ref);
		if (name.endsWith(':listFolders')) {
			return [
				{ _id: 'f1', name: 'INBOX', role: 'inbox' },
				{ _id: 'tf', name: 'Target' },
			];
		}
		// A folder without the membership index: UIDs come from the listing.
		if (name.endsWith(':folderMembershipPage')) return null;
		if (name.endsWith(':listFolderUidsPage')) {
			return { uids: folder.map((r) => r.uid), nextUid: null };
		}
		if (name.endsWith(':resolveMessageIdsByUid')) {
			return {
				rows: folder
					.filter((r) => r.uid >= args['uidLow']! && r.uid <= args['uidHigh']!)
					.map((r) => ({ _id: `m${r.uid}`, uid: r.uid, modseq: 1 })),
				nextUid: null,
			};
		}
		throw new Error(`unexpected query ${name}`);
	});

	const mutation = vi.fn(async (ref: AnyFunctionReference, args: Record<string, unknown>) => {
		const name = getFunctionName(ref).split(':')[1]!;
		const call = (counts.get(name) ?? 0) + 1;
		counts.set(name, call);
		argLog.push({ name, args });
		checkCap(name, args);
		if (options.failCall?.name === name && options.failCall.call === call) {
			throw new Error(`${name} failed`);
		}
		const uidOf = (id: string) => Number(id.slice(1));

		if (name === 'expungeFolder') {
			// The backend's keyset walk: descending from `beforeUid`, 100 rows a
			// page, stopping at the UID set's lowest member.
			const filter = args['uidSet'] ? new Set(args['uidSet'] as number[]) : null;
			const floor = filter ? Math.min(...filter) : -Infinity;
			const before = (args['beforeUid'] as number | undefined) ?? Infinity;
			const page = folder
				.filter((r) => r.uid < before && r.uid >= floor)
				.reverse()
				.slice(0, 100);
			const uids: number[] = [];
			for (const r of page) {
				if (!r.deleted || (filter && !filter.has(r.uid))) continue;
				uids.push(r.uid);
				folder.splice(folder.indexOf(r), 1);
			}
			return {
				uids,
				modseq: 9,
				done: page.length < 100,
				beforeUid: page.length > 0 ? page[page.length - 1]!.uid : args['beforeUid'],
			};
		}
		if (name === 'storeFlags') {
			const ids = args['messageIds'] as string[];
			const updated = ids
				.filter((id) => uidOf(id) % 2 === 0)
				.map((id) => ({ messageId: id, uid: uidOf(id), modseq: 5, flags: ['\\Seen'] }));
			const unchanged = ids
				.filter((id) => uidOf(id) % 2 === 1)
				.map((id) => ({ messageId: id, uid: uidOf(id) }));
			return { updated, unchanged };
		}
		if (name === 'copyMessages' || name === 'moveMessages') {
			const pairs = (args['messageIds'] as string[]).map((id) => {
				const sourceUid = uidOf(id);
				const targetUid = targetUidNext++;
				target.push({ uid: targetUid, from: sourceUid });
				return { sourceUid, targetUid };
			});
			if (name === 'moveMessages') {
				// One pass over the folder per batch, not one per message: a
				// per-message search made the 20,000-message cases time out under
				// coverage.
				const moved = new Set(pairs.map((p) => p.sourceUid));
				const kept = folder.filter((r) => !moved.has(r.uid));
				folder.splice(0, folder.length, ...kept);
			}
			return { uidValidity: 7, pairs };
		}
		if (name === 'discardCopies') {
			const uids = new Set(args['uids'] as number[]);
			const before = target.length;
			for (let i = target.length - 1; i >= 0; i -= 1) {
				if (uids.has(target[i]!.uid)) target.splice(i, 1);
			}
			return { removed: before - target.length };
		}
		throw new Error(`unexpected mutation ${name}`);
	});

	const deps = {
		convex: { query, mutation, action: vi.fn() },
		commit: vi.fn(),
	} as unknown as CommandDeps;

	return {
		deps,
		folder,
		target,
		calls: (fnName: string) => argLog.filter((c) => c.name === fnName).map((c) => c.args),
	};
}

/** A SELECTed `f1`; `viewUids` gives the session the sequence view SELECT sets. */
function selected(totalCount: number, viewUids?: readonly number[]): ConnectionState {
	const sel: SelectedState = {
		folderId: 'f1',
		folderName: 'INBOX',
		role: 'inbox',
		uidValidity: 1,
		uidNext: 100_000,
		highestModseq: 1,
		totalCount,
		readOnly: false,
		...(viewUids ? { view: { uids: viewUids } } : {}),
	};
	return {
		auth: { mailboxId: 'mb1', appPasswordId: 'ap1', address: 'a@t', userId: 'u1' },
		selected: sel,
		clientId: null,
	};
}

async function run(
	deps: CommandDeps,
	state: ConnectionState,
	module: ImapCommandModule<unknown>,
	verb: ImapVerb,
	rawArgs: string[]
): Promise<string[]> {
	const parsed = module.parseArgs(rawArgs);
	if (!parsed.ok) throw new Error(parsed.error);
	const lines: string[] = [];
	await module.start({
		deps,
		state,
		args: parsed.args,
		tag: 'a1',
		verb,
		send: (l) => lines.push(String(l)),
	}).completion;
	return lines;
}

const asModule = <T>(m: ImapCommandModule<T>) => m as unknown as ImapCommandModule<unknown>;
const uid = asModule(uidModule);
const copy = asModule(copyModule);
const move = asModule(moveModule);
const store = asModule(storeModule);

/**
 * Apply the `* n EXPUNGE` lines to the client's view of the folder, the way a
 * client does (RFC 9051 §7.5.1), and return the UIDs it is left with.
 */
function applyExpunges(view: number[], lines: string[]): number[] {
	const out = [...view];
	for (const line of lines) {
		const m = /^\* (\d+) EXPUNGE$/.exec(line);
		if (!m) continue;
		const seq = Number(m[1]);
		expect(seq).toBeGreaterThanOrEqual(1);
		expect(seq).toBeLessThanOrEqual(out.length);
		out.splice(seq - 1, 1);
	}
	return out;
}

const range = (n: number, map: (i: number) => Row) => Array.from({ length: n }, (_, i) => map(i));

/** The two ways a session numbers its expunges: through its view, or without one. */
const VIEW_MODES = [
	{ mode: 'with a sequence view', withView: true },
	{ mode: 'without a sequence view', withView: false },
] as const;

/** `selected(LARGE)`, with the view SELECT would have set when `withView`. */
function selectedFor(rows: readonly Row[], withView: boolean): ConnectionState {
	return selected(rows.length, withView ? rows.map((r) => r.uid).sort((a, b) => a - b) : undefined);
}

/** After the command, a session's view must be the folder as it now is. */
function expectViewInStep(state: ConnectionState, folder: readonly Row[]): void {
	const view = state.selected!.view;
	if (view) expect(view.uids).toEqual(folder.map((r) => r.uid));
}

describe.each(VIEW_MODES)('UID EXPUNGE over a large folder, $mode', ({ withView }) => {
	it('expunges every message of a set larger than one Convex call accepts', async () => {
		const rows = range(LARGE, (i) => ({ uid: i + 1, deleted: true }));
		const b = fakeBackend(rows);
		const state = selectedFor(rows, withView);
		const lines = await run(b.deps, state, uid, 'UID', ['EXPUNGE', '1:*']);

		expect(lines.at(-1)).toBe('a1 OK UID EXPUNGE completed');
		expect(b.folder).toEqual([]);
		const expunges = lines.filter((l) => l.endsWith(' EXPUNGE'));
		expect(expunges).toHaveLength(LARGE);
		// Highest first, so every number is valid when the client reads it.
		expect(expunges[0]).toBe(`* ${LARGE} EXPUNGE`);
		expect(expunges.at(-1)).toBe('* 1 EXPUNGE');
		for (const call of b.calls('expungeFolder')) {
			expect((call['uidSet'] as number[]).length).toBeLessThanOrEqual(CONVEX_ARRAY_LIMIT);
		}
		expectViewInStep(state, b.folder);
	});

	it('keeps sequence numbers right when only part of the set is \\Deleted', async () => {
		const rows = range(LARGE, (i) => ({ uid: 2 * i + 1, deleted: i % 3 === 0 }));
		const b = fakeBackend(rows);
		const view = rows.map((r) => r.uid);
		const state = selectedFor(rows, withView);
		const lines = await run(b.deps, state, uid, 'UID', ['EXPUNGE', '1:*']);

		expect(lines.at(-1)).toBe('a1 OK UID EXPUNGE completed');
		expect(applyExpunges(view, lines)).toEqual(b.folder.map((r) => r.uid));
		expect(b.folder.every((r) => !r.deleted)).toBe(true);
		expectViewInStep(state, b.folder);
	});
});

describe('STORE over a large folder', () => {
	it('updates every message and reports the true sequence numbers and MODIFIED set', async () => {
		const rows = range(LARGE, (i) => ({ uid: i + 1, deleted: false }));
		const b = fakeBackend(rows);
		const lines = await run(b.deps, selected(LARGE), store, 'STORE', ['1:*', '+FLAGS', '(\\Seen)']);

		for (const call of b.calls('storeFlags')) {
			expect((call['messageIds'] as string[]).length).toBeLessThanOrEqual(CONVEX_ARRAY_LIMIT);
		}
		const fetches = lines.filter((l) => l.includes(' FETCH '));
		expect(fetches).toHaveLength(LARGE / 2);
		expect(fetches[0]).toBe('* 2 FETCH (UID 2 MODSEQ (5) FLAGS (\\Seen))');
		const tagged = lines.at(-1)!;
		expect(tagged.startsWith('a1 OK [MODIFIED 1,3,5,')).toBe(true);
		expect(tagged.endsWith(`,${LARGE - 1}] STORE completed`)).toBe(true);
	});
});

describe('COPY over a large folder', () => {
	it('copies every message and reports one COPYUID for the whole set', async () => {
		const rows = range(LARGE, (i) => ({ uid: i + 1, deleted: false }));
		const b = fakeBackend(rows);
		const lines = await run(b.deps, selected(LARGE), copy, 'COPY', ['1:*', 'Target']);

		expect(lines).toHaveLength(1);
		const m = /^a1 OK \[COPYUID 7 ([\d,]+) ([\d,]+)\] COPY completed$/.exec(lines[0]!);
		expect(m).not.toBeNull();
		expect(m![1]!.split(',')).toHaveLength(LARGE);
		expect(m![2]!.split(',')).toHaveLength(LARGE);
		expect(b.target).toHaveLength(LARGE);
		for (const call of b.calls('copyMessages')) {
			expect((call['messageIds'] as string[]).length).toBeLessThanOrEqual(CONVEX_ARRAY_LIMIT);
		}
	});

	it('removes the copies already made when a later batch fails', async () => {
		const rows = range(LARGE, (i) => ({ uid: i + 1, deleted: false }));
		const b = fakeBackend(rows, { failCall: { name: 'copyMessages', call: 3 } });
		const lines = await run(b.deps, selected(LARGE), copy, 'COPY', ['1:*', 'Target']);

		expect(lines).toEqual(['a1 NO [UNAVAILABLE] COPY failed']);
		expect(b.calls('copyMessages').length).toBe(3);
		expect(b.calls('discardCopies').length).toBeGreaterThan(0);
		expect(b.target).toEqual([]);
	});
});

describe.each(VIEW_MODES)('MOVE over a large folder, $mode', ({ withView }) => {
	it('moves every message and keeps each EXPUNGE valid for the client', async () => {
		// Sparse UIDs, and every other message moved, so batches interleave with
		// messages that stay.
		const rows = range(LARGE, (i) => ({ uid: 3 * i + 2, deleted: false }));
		const b = fakeBackend(rows);
		const view = rows.map((r) => r.uid);
		const set = rows
			.filter((_, i) => i % 2 === 1)
			.map((r) => r.uid)
			.join(',');
		const state = selectedFor(rows, withView);
		const lines = await run(b.deps, state, uid, 'UID', ['MOVE', set, 'Target']);

		expect(lines.at(-1)).toBe('a1 OK UID MOVE completed');
		for (const call of b.calls('moveMessages')) {
			expect((call['messageIds'] as string[]).length).toBeLessThanOrEqual(CONVEX_ARRAY_LIMIT);
		}
		expect(b.target).toHaveLength(LARGE / 2);
		expect(applyExpunges(view, lines)).toEqual(b.folder.map((r) => r.uid));
		const commits = vi.mocked(b.deps.commit).mock.calls;
		expect(commits.at(-1)![0].selected?.totalCount).toBe(LARGE / 2);
		expectViewInStep(state, b.folder);
	});

	it('reports the batches that moved before a failure, then answers NO', async () => {
		const rows = range(LARGE, (i) => ({ uid: i + 1, deleted: false }));
		const b = fakeBackend(rows, { failCall: { name: 'moveMessages', call: 2 } });
		const view = rows.map((r) => r.uid);
		const state = selectedFor(rows, withView);
		const lines = await run(b.deps, state, move, 'MOVE', ['1:*', 'Target']);

		expect(lines.at(-1)).toBe('a1 NO [UNAVAILABLE] MOVE failed');
		const moved = b.target.length;
		expect(moved).toBeGreaterThan(0);
		expect(moved).toBeLessThan(LARGE);
		// Each message is either moved or still in the source, and the client's
		// view after the EXPUNGE lines matches the source folder.
		expect(moved + b.folder.length).toBe(LARGE);
		expect(applyExpunges(view, lines)).toEqual(b.folder.map((r) => r.uid));
		expectViewInStep(state, b.folder);
	});
});
