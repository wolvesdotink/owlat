/**
 * Message-set resolution for UID EXPUNGE, COPY and MOVE (GHSA-25hg-xh4w-whxq).
 *
 * Every command that takes a message set resolves it through the selected
 * folder's sequence ↔ UID map, so the set is bounded by the folder's size and
 * a non-UID set addresses positions, not UIDs (RFC 3501 §2.3.1). The Convex
 * client is a small in-memory folder keyed by function name, so the tests
 * observe exactly which message ids / UIDs reach each mutation.
 */

import { describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { copyModule } from '../copy/index.js';
import { expungeModule } from '../expunge/index.js';
import { moveModule } from '../move/index.js';
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

interface FakeMessage {
	readonly uid: number;
	readonly deleted?: boolean;
}

interface Harness {
	readonly deps: CommandDeps;
	readonly mutation: ReturnType<typeof vi.fn>;
	readonly calls: (name: string) => Array<Record<string, unknown>>;
}

/** An in-memory source folder `f1` plus a `Target` folder. */
function harness(messages: FakeMessage[]): Harness {
	const sorted = [...messages].sort((a, b) => a.uid - b.uid);
	const query = vi.fn(async (ref: AnyFunctionReference, args: Record<string, number>) => {
		const name = getFunctionName(ref);
		if (name.endsWith(':listFolders')) {
			return [
				{ _id: 'f1', name: 'INBOX', role: 'inbox' },
				{ _id: 'tf', name: 'Target' },
			];
		}
		if (name.endsWith(':folderMembershipPage')) return null;
		if (name.endsWith(':listFolderUidsPage')) {
			return { uids: sorted.map((m) => m.uid), nextUid: null };
		}
		if (name.endsWith(':resolveMessageIdsByUid')) {
			const low = args['uidLow'] ?? 0;
			const high = args['uidHigh'] ?? 0;
			return {
				rows: sorted
					.filter((m) => m.uid >= low && m.uid <= high)
					.map((m) => ({ _id: `m${m.uid}`, uid: m.uid, modseq: 1 })),
				nextUid: null,
			};
		}
		throw new Error(`unexpected query ${name}`);
	});
	const mutation = vi.fn(async (ref: AnyFunctionReference, args: Record<string, unknown>) => {
		const name = getFunctionName(ref);
		if (name.endsWith(':expungeFolder')) {
			const filter = args['uidSet'] ? new Set(args['uidSet'] as number[]) : null;
			const sequenceNumbers: number[] = [];
			const uids: number[] = [];
			for (let i = sorted.length - 1; i >= 0; i -= 1) {
				const m = sorted[i]!;
				if (m.deleted && (!filter || filter.has(m.uid))) {
					sequenceNumbers.push(i + 1);
					uids.push(m.uid);
				}
			}
			return { sequenceNumbers, uids, modseq: 9, done: true };
		}
		if (name.endsWith(':copyMessages') || name.endsWith(':moveMessages')) {
			const ids = args['messageIds'] as string[];
			return {
				uidValidity: 1,
				pairs: ids.map((id, i) => ({ sourceUid: Number(id.slice(1)), targetUid: 100 + i })),
			};
		}
		throw new Error(`unexpected mutation ${name}`);
	});
	const deps = {
		convex: { query, mutation, action: vi.fn() },
		commit: vi.fn(),
	} as unknown as CommandDeps;
	return {
		deps,
		mutation,
		calls: (fnName) =>
			mutation.mock.calls
				.filter(([ref]) => getFunctionName(ref as AnyFunctionReference).endsWith(`:${fnName}`))
				.map(([, args]) => args as Record<string, unknown>),
	};
}

function selected(totalCount: number): ConnectionState {
	const sel: SelectedState = {
		folderId: 'f1',
		folderName: 'INBOX',
		role: 'inbox',
		uidValidity: 1,
		uidNext: 4_000_000_001,
		highestModseq: 1,
		totalCount,
		readOnly: false,
	};
	return {
		auth: { mailboxId: 'mb1', appPasswordId: 'ap1', address: 'a@t', userId: 'u1' },
		selected: sel,
		clientId: null,
	};
}

async function run(
	h: Harness,
	state: ConnectionState,
	module: ImapCommandModule<unknown>,
	verb: ImapVerb,
	rawArgs: string[]
): Promise<string[]> {
	const parsed = module.parseArgs(rawArgs);
	if (!parsed.ok) throw new Error(parsed.error);
	const lines: string[] = [];
	await module.start({
		deps: h.deps,
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
const expunge = asModule(expungeModule);

describe('UID EXPUNGE resolves its set against the folder', () => {
	const tenMessages = Array.from({ length: 10 }, (_, i) => ({
		uid: i + 1,
		deleted: i + 1 === 3 || i + 1 === 7,
	}));

	it('bounds a huge range to the folder and expunges only \\Deleted messages', async () => {
		const h = harness(tenMessages);
		const startedAt = performance.now();
		const lines = await run(h, selected(10), uid, 'UID', ['EXPUNGE', '1:4000000000']);
		expect(performance.now() - startedAt).toBeLessThan(1000);

		const [call] = h.calls('expungeFolder');
		expect(call?.['uidSet']).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(lines).toEqual(['* 7 EXPUNGE', '* 3 EXPUNGE', 'a1 OK UID EXPUNGE completed']);
	});

	it('sends only UIDs that exist in the folder', async () => {
		const h = harness([{ uid: 5 }, { uid: 7, deleted: true }, { uid: 9 }]);
		await run(h, selected(3), uid, 'UID', ['EXPUNGE', '1:8']);
		expect(h.calls('expungeFolder')[0]?.['uidSet']).toEqual([5, 7]);
	});

	it('answers BAD for plain EXPUNGE with a set instead of treating it as UID EXPUNGE', async () => {
		const h = harness(tenMessages);
		const lines = await run(h, selected(10), expunge, 'EXPUNGE', ['1:3']);
		expect(h.mutation).not.toHaveBeenCalled();
		expect(lines).toEqual(['a1 BAD EXPUNGE takes no arguments']);
	});

	it('skips the mutation when no UID in the set exists', async () => {
		const h = harness([{ uid: 5, deleted: true }]);
		const lines = await run(h, selected(1), uid, 'UID', ['EXPUNGE', '50:60']);
		expect(h.mutation).not.toHaveBeenCalled();
		expect(lines).toEqual(['a1 OK UID EXPUNGE completed']);
	});
});

describe('COPY and MOVE address sequence numbers unless prefixed with UID', () => {
	// Sparse UIDs: sequence numbers 1, 2, 3 carry UIDs 5, 7, 9.
	const sparse = [{ uid: 5 }, { uid: 7 }, { uid: 9 }];

	it('COPY 1 copies the first message, not UID 1', async () => {
		const h = harness(sparse);
		const lines = await run(h, selected(3), copy, 'COPY', ['1', 'Target']);
		expect(h.calls('copyMessages')[0]?.['messageIds']).toEqual(['m5']);
		expect(lines).toEqual(['a1 OK [COPYUID 1 5 100] COPY completed']);
	});

	it('UID COPY 5 copies UID 5', async () => {
		const h = harness(sparse);
		const lines = await run(h, selected(3), uid, 'UID', ['COPY', '5', 'Target']);
		expect(h.calls('copyMessages')[0]?.['messageIds']).toEqual(['m5']);
		expect(lines).toEqual(['a1 OK [COPYUID 1 5 100] UID COPY completed']);
	});

	it('COPY with positions past the message count copies nothing', async () => {
		const h = harness(sparse);
		const lines = await run(h, selected(3), copy, 'COPY', ['4:9', 'Target']);
		expect(h.mutation).not.toHaveBeenCalled();
		expect(lines).toEqual(['a1 OK COPY completed']);
	});

	it('MOVE 2:* moves the second and third messages and expunges them in descending order', async () => {
		const h = harness(sparse);
		const lines = await run(h, selected(3), move, 'MOVE', ['2:*', 'Target']);
		expect(h.calls('moveMessages')[0]?.['messageIds']).toEqual(['m7', 'm9']);
		expect(lines).toEqual([
			'* OK [COPYUID 1 7,9 100,101] Move',
			'* 3 EXPUNGE',
			'* 2 EXPUNGE',
			'a1 OK MOVE completed',
		]);
	});

	it('UID MOVE reports the moved message by its sequence number', async () => {
		const h = harness(sparse);
		const lines = await run(h, selected(3), uid, 'UID', ['MOVE', '5,9', 'Target']);
		expect(h.calls('moveMessages')[0]?.['messageIds']).toEqual(['m5', 'm9']);
		expect(lines).toEqual([
			'* OK [COPYUID 1 5,9 100,101] Move',
			'* 3 EXPUNGE',
			'* 1 EXPUNGE',
			'a1 OK UID MOVE completed',
		]);
	});

	it('MOVE lowers the selected message count by the messages it expunged', async () => {
		const h = harness(sparse);
		await run(h, selected(3), move, 'MOVE', ['1,3', 'Target']);
		expect(h.deps.commit).toHaveBeenCalledTimes(1);
		const [committed] = vi.mocked(h.deps.commit).mock.calls[0]!;
		expect(committed.selected?.totalCount).toBe(1);
	});
});
