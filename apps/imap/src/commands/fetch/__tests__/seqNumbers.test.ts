/**
 * Sequence-number ↔ UID correctness for FETCH / STORE / SELECT (PR-58).
 *
 * RFC 3501 §2.3.1 distinguishes message *sequence numbers* (1-based
 * position by UID ascending) from *UIDs*. A non-UID FETCH/STORE set holds
 * sequence numbers, and every per-row `* {n} FETCH` reply must carry the
 * *true* sequence number, not a fabricated 1..N counter. SELECT's
 * `[UNSEEN n]` is likewise a sequence number, not a UID (§7.1).
 *
 * Fixture mailbox: three messages with UIDs 5, 9, 14 — sequence numbers
 * 1, 2, 3. Each case below failed before the fix:
 *   - non-UID `FETCH 2 (UID)`      → `* 2 FETCH (UID 9 ...)`
 *   - non-UID `STORE 3 +FLAGS`     → flags UID 14, replies `* 3 FETCH ...`
 *   - `UID FETCH 9 (UID)`          → `* 2 FETCH (UID 9 ...)`
 *   - SELECT, first unseen UID 9   → `* OK [UNSEEN 2]`
 */

import { describe, expect, it, vi } from 'vitest';
import { fetchModule, type FetchArgs } from '../index.js';
import { storeModule, type StoreArgs } from '../../store/index.js';
import { selectModule } from '../../select/index.js';
import { uidModule } from '../../uid/index.js';
import type { FetchEnvelope } from '../format.js';
import type {
	CommandDeps,
	ConnectionState,
	ImapVerb,
	StartArgs,
} from '../../types.js';

/** UID → sequence number for the fixture mailbox (5,9,14 → 1,2,3). */
const FOLDER_UIDS = [5, 9, 14];

function envelope(uid: number, overrides: Partial<FetchEnvelope> = {}): FetchEnvelope {
	return {
		_id: `m-${uid}`,
		uid,
		modseq: 1,
		rawSize: 0,
		rfc822MessageId: `mid-${uid}@example.com`,
		fromAddress: 'jane@example.com',
		fromName: 'Jane',
		toAddresses: ['bob@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'Hi',
		internalDate: Date.UTC(2026, 5, 9, 10, 30, 5),
		flagSeen: false,
		flagFlagged: false,
		flagAnswered: false,
		flagDraft: false,
		flagDeleted: false,
		customFlags: [],
		...overrides,
	};
}

const ENVELOPES: FetchEnvelope[] = FOLDER_UIDS.map((u) => envelope(u));

interface ConvexCalls {
	storeFlags: Array<{ messageIds: string[]; flags: string[]; mode: string }>;
}

function makeConvex(calls: ConvexCalls) {
	return {
		query: vi.fn(async (ref: string, params: { uidLow?: number; uidHigh?: number }) => {
			if (ref.endsWith(':listFolderUids')) return [...FOLDER_UIDS];
			if (ref.endsWith(':fetchEnvelopes')) {
				return ENVELOPES.filter(
					(m) => m.uid >= (params.uidLow ?? 0) && m.uid <= (params.uidHigh ?? Infinity),
				);
			}
			if (ref.endsWith(':resolveMessageIdsByUid')) {
				return ENVELOPES.filter(
					(m) => m.uid >= (params.uidLow ?? 0) && m.uid <= (params.uidHigh ?? Infinity),
				).map((m) => ({ _id: m._id, uid: m.uid }));
			}
			return null;
		}),
		mutation: vi.fn(async (ref: string, params: { messageIds: string[]; flags: string[]; mode: string }) => {
			if (ref.endsWith(':storeFlags')) {
				calls.storeFlags.push({
					messageIds: params.messageIds,
					flags: params.flags,
					mode: params.mode,
				});
				const updated = ENVELOPES.filter((m) => params.messageIds.includes(m._id)).map((m) => ({
					uid: m.uid,
					modseq: m.modseq + 1,
					flags: ['\\Seen'],
				}));
				return { updated, unchanged: [] };
			}
			return { updated: [], unchanged: [] };
		}),
	};
}

function selectedState(): ConnectionState {
	return {
		auth: { mailboxId: 'mb1', appPasswordId: 'ap1', address: 'a@test', userId: 'u1' },
		selected: {
			folderId: 'f1',
			folderName: 'INBOX',
			uidValidity: 1,
			uidNext: 20,
			highestModseq: 1,
			totalCount: 3,
			readOnly: false,
		},
		clientId: null,
	};
}

async function runFetch(set: string, items: string, byUid: boolean): Promise<string[]> {
	const lines: string[] = [];
	const convex = makeConvex({ storeFlags: [] });
	const base = {
		deps: { convex } as unknown as CommandDeps,
		state: selectedState(),
		tag: 'a001',
		verb: 'FETCH' as ImapVerb,
		send: (line: string) => lines.push(line),
	};
	if (byUid) {
		const session = uidModule.start({
			...base,
			verb: 'UID' as ImapVerb,
			args: { sub: 'FETCH', rest: [set, items] },
		} as never);
		await session.completion;
	} else {
		const args: FetchArgs = { set, itemsToken: items, byUid: false };
		const session = fetchModule.start({ ...base, args } as StartArgs<FetchArgs>);
		await session.completion;
	}
	return lines;
}

async function runStore(
	set: string,
	op: string,
	flags: string,
): Promise<{ lines: string[]; calls: ConvexCalls; convex: ReturnType<typeof makeConvex> }> {
	const lines: string[] = [];
	const calls: ConvexCalls = { storeFlags: [] };
	const convex = makeConvex(calls);
	const parsed = storeModule.parseArgs([set, op, flags]);
	expect(parsed.ok).toBe(true);
	const args = (parsed as { ok: true; args: StoreArgs }).args;
	const session = storeModule.start({
		deps: { convex } as unknown as CommandDeps,
		state: selectedState(),
		args,
		tag: 'a001',
		verb: 'STORE' as ImapVerb,
		send: (line: string) => lines.push(line),
	});
	await session.completion;
	return { lines, calls, convex };
}

describe('PR-58 true sequence numbers', () => {
	it('non-UID FETCH 2 (UID) emits the true sequence number and UID 9', async () => {
		const lines = await runFetch('2', '(UID)', false);
		const fetchLine = lines.find((l) => l.includes('FETCH'));
		expect(fetchLine).toBe('* 2 FETCH (UID 9)');
	});

	it('non-UID STORE 3 +FLAGS (\\Seen) flags UID 14 and replies * 3 FETCH', async () => {
		const { lines, calls } = await runStore('3', '+FLAGS', '(\\Seen)');
		// The mutation targeted the message at sequence 3 (UID 14).
		expect(calls.storeFlags).toHaveLength(1);
		expect(calls.storeFlags[0]!.messageIds).toEqual(['m-14']);
		const fetchLine = lines.find((l) => l.includes('FETCH'));
		expect(fetchLine).toContain('* 3 FETCH (UID 14');
	});

	it('STORE 1:3 resolves all UIDs with a single resolveMessageIdsByUid range query', async () => {
		const { calls, convex } = await runStore('1:3', '+FLAGS', '(\\Seen)');
		// All three messages (UIDs 5,9,14) were flagged.
		expect(calls.storeFlags).toHaveLength(1);
		expect(calls.storeFlags[0]!.messageIds).toEqual(['m-5', 'm-9', 'm-14']);
		// The set was resolved with one range query, not one per message —
		// the FETCH-parity fix (PR-58 r1). The min..max span (5..14) is queried
		// once.
		const resolveCalls = convex.query.mock.calls.filter(([ref]) =>
			ref.endsWith(':resolveMessageIdsByUid'),
		);
		expect(resolveCalls).toHaveLength(1);
		expect(resolveCalls[0]![1]).toMatchObject({ uidLow: 5, uidHigh: 14 });
	});

	it('UID FETCH 9 (UID) maps UID 9 back to sequence 2', async () => {
		const lines = await runFetch('9', '(UID)', true);
		const fetchLine = lines.find((l) => l.includes('FETCH'));
		expect(fetchLine).toBe('* 2 FETCH (UID 9)');
	});

	it('SELECT emits [UNSEEN seq] for the first-unseen sequence number', async () => {
		const lines: string[] = [];
		const convex = {
			query: vi.fn(async (ref: string) => {
				if (ref.endsWith(':listFolders')) {
					return [{ _id: 'f1', name: 'INBOX', role: 'inbox' }];
				}
				if (ref.endsWith(':selectFolder')) {
					return {
						folder: {
							_id: 'f1',
							name: 'INBOX',
							role: 'inbox',
							uidValidity: 1,
							uidNext: 20,
							highestModseq: 1,
							totalCount: 3,
							unseenCount: 2,
						},
						// First unseen is UID 9, which sits at sequence number 2.
						firstUnseenUid: 9,
						firstUnseenSeq: 2,
					};
				}
				return null;
			}),
		};
		const session = selectModule.start({
			deps: { convex, commit: () => {} } as unknown as CommandDeps,
			state: {
				auth: { mailboxId: 'mb1', appPasswordId: 'ap1', address: 'a@test', userId: 'u1' },
				selected: null,
				clientId: null,
			},
			args: { mailboxName: 'INBOX' },
			tag: 'a001',
			verb: 'SELECT' as ImapVerb,
			send: (line: string) => lines.push(line),
		} as never);
		await session.completion;
		const unseen = lines.find((l) => l.includes('[UNSEEN'));
		expect(unseen).toBe('* OK [UNSEEN 2] First unseen');
	});
});
