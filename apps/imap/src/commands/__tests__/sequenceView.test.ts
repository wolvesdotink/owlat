/**
 * #927: another session's EXPUNGE cannot make a sequence-number command target
 * the wrong message, and repeated commands on an unchanged folder do not
 * re-read it.
 *
 * Two sessions share one in-memory backend that behaves like apps/api: a
 * membership version bumped by every insert and removal, UID blocks once the
 * folder is ready, and the paged reads the commands use. Session A SELECTs;
 * session B's changes are applied to the backend directly. Each test drives A
 * through the real command walker and checks the exact lines A's client sees.
 *
 * Before this change a sequence number was resolved against the folder as it
 * was at that moment. After B expunged message 2, A's `FETCH 2` answered with
 * message 3 and A's `STORE 2 +FLAGS (\Deleted)` flagged message 3: the client
 * still numbered the folder 1,2,3, because nobody had told it otherwise.
 */

import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { dispatch } from '../walker.js';
import { parseLine } from '../../parser.js';
import { forgetCachedMemberships } from '../helpers/membership.js';
import type { CommandDeps, ConnectionState } from '../types.js';
import { ImapConnection } from '../../connection.js';
import type { ImapConfig } from '../../config.js';
import type { ConvexClient } from '../../convex.js';
import { AuthRateLimiter } from '../../rateLimit.js';

// convex/server declares AnyFunctionReference without exporting it.
type AnyFunctionReference = Parameters<typeof getFunctionName>[0];

vi.mock('../../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

interface Message {
	uid: number;
	deleted: boolean;
	flagged: boolean;
}

type Mode = 'none' | 'ready';

const BLOCK = 256;
const PAGE = 200;

function backend(initialUids: number[], mode: Mode = 'ready') {
	const folders = new Map<string, Message[]>([
		['f1', initialUids.map((uid) => ({ uid, deleted: false, flagged: false }))],
		['f2', []],
	]);
	const uidNext = new Map([
		['f1', Math.max(0, ...initialUids) + 1],
		['f2', 1],
	]);
	let revision = 0;
	const counts = { membership: 0, blockDocs: 0, listing: 0, listedDocs: 0, envelopeDocs: 0 };
	const sorted = (id: string) => folders.get(id)!.sort((a, b) => a.uid - b.uid);
	const window = (id: string, args: Record<string, unknown>) => {
		const low = args['uidLow'] as number;
		const high = args['uidHigh'] as number;
		const ranges = (args['ranges'] as Array<{ low: number; high: number }> | undefined) ?? [
			{ low, high },
		];
		const rows: Message[] = [];
		for (const r of ranges) {
			for (const m of sorted(id)) {
				if (rows.length >= PAGE) break;
				if (m.uid >= Math.max(r.low, low) && m.uid <= Math.min(r.high, high)) rows.push(m);
			}
		}
		return { rows, nextUid: rows.length < PAGE ? null : rows[rows.length - 1]!.uid + 1 };
	};
	const envelope = (m: Message) => ({
		_id: `m-${m.uid}`,
		uid: m.uid,
		modseq: 1,
		rawSize: 10,
		rfc822MessageId: `<${m.uid}@owlat.test>`,
		fromAddress: 'a@owlat.test',
		toAddresses: [],
		ccAddresses: [],
		bccAddresses: [],
		subject: `s${m.uid}`,
		internalDate: 0,
		flagSeen: true,
		flagFlagged: m.flagged,
		flagAnswered: false,
		flagDraft: false,
		flagDeleted: m.deleted,
		customFlags: [],
	});
	const byId = (id: string) => {
		const uid = Number(id.slice(2));
		for (const [folderId, messages] of folders) {
			const m = messages.find((x) => x.uid === uid);
			if (m) return { folderId, m };
		}
		return null;
	};

	const query = vi.fn(
		async (ref: AnyFunctionReference, args: Record<string, unknown>): Promise<unknown> => {
			const name = getFunctionName(ref);
			const id = args['folderId'] as string;
			if (name.endsWith(':listFolders')) {
				return [
					{ _id: 'f1', name: 'INBOX', role: 'inbox' },
					{ _id: 'f2', name: 'Archive', role: 'archive' },
				];
			}
			if (name.endsWith(':selectFolder')) {
				return {
					folder: {
						_id: id,
						name: id === 'f1' ? 'INBOX' : 'Archive',
						uidValidity: 1,
						uidNext: uidNext.get(id),
						highestModseq: 1,
						totalCount: folders.get(id)!.length,
						unseenCount: 0,
					},
				};
			}
			if (name.endsWith(':folderMembershipPage')) {
				counts.membership += 1;
				if (mode === 'none') return null;
				const version = `s:${revision}`;
				if (args['knownVersion'] === version) return { version, isReady: true, unchanged: true };
				const uids = sorted(id).map((m) => m.uid);
				const blocks: number[][] = [];
				for (let i = 0; i < uids.length; i += BLOCK) blocks.push(uids.slice(i, i + BLOCK));
				counts.blockDocs += blocks.length;
				return { version, isReady: true, blocks, nextFirstUid: null };
			}
			if (name.endsWith(':listFolderUidsPage')) {
				counts.listing += 1;
				const after = (args['afterUid'] as number | undefined) ?? 0;
				const page = sorted(id)
					.filter((m) => m.uid >= after)
					.slice(0, 1000)
					.map((m) => m.uid);
				counts.listedDocs += page.length;
				return { uids: page, nextUid: page.length < 1000 ? null : page[page.length - 1]! + 1 };
			}
			if (name.endsWith(':fetchEnvelopes')) {
				const { rows, nextUid } = window(id, args);
				counts.envelopeDocs += rows.length;
				return { rows: rows.map(envelope), nextUid };
			}
			if (name.endsWith(':peekFolderModseq')) {
				return {
					highestModseq: 1,
					uidNext: uidNext.get(id),
					totalCount: folders.get(id)!.length,
					unseenCount: 0,
				};
			}
			if (name.endsWith(':resolveMessageIdsByUid')) {
				const { rows, nextUid } = window(id, args);
				return { rows: rows.map((m) => ({ _id: `m-${m.uid}`, uid: m.uid, modseq: 1 })), nextUid };
			}
			throw new Error(`unexpected query ${name}`);
		}
	);

	const mutation = vi.fn(
		async (ref: AnyFunctionReference, args: Record<string, unknown>): Promise<unknown> => {
			const name = getFunctionName(ref);
			if (name.endsWith(':storeFlags')) {
				const updated = [];
				for (const messageId of args['messageIds'] as string[]) {
					const found = byId(messageId);
					if (!found) continue;
					for (const flag of args['flags'] as string[]) {
						if (flag === '\\Deleted') found.m.deleted = true;
						if (flag === '\\Flagged') found.m.flagged = true;
					}
					const flags = [
						...(found.m.flagged ? ['\\Flagged'] : []),
						...(found.m.deleted ? ['\\Deleted'] : []),
					];
					updated.push({ messageId, uid: found.m.uid, modseq: 2, flags });
				}
				return { updated, unchanged: [] };
			}
			if (name.endsWith(':expungeFolder')) {
				const id = args['folderId'] as string;
				const uidSet = args['uidSet'] as number[] | undefined;
				const before = sorted(id).map((m) => m.uid);
				const gone = sorted(id)
					.filter((m) => m.deleted && (!uidSet || uidSet.includes(m.uid)))
					.map((m) => m.uid)
					.reverse();
				folders.set(
					id,
					folders.get(id)!.filter((m) => !gone.includes(m.uid))
				);
				if (gone.length > 0) revision += 1;
				return {
					// The folder's own numbering, which the server must not trust blindly.
					sequenceNumbers: gone.map((uid) => before.indexOf(uid) + 1),
					uids: gone,
					modseq: 3,
					done: true,
				};
			}
			if (name.endsWith(':moveMessages')) {
				const pairs = [];
				for (const messageId of args['messageIds'] as string[]) {
					const found = byId(messageId);
					if (!found || found.folderId !== args['sourceFolderId']) continue;
					const target = args['targetFolderId'] as string;
					const targetUid = uidNext.get(target)!;
					uidNext.set(target, targetUid + 1);
					folders.set(
						found.folderId,
						folders.get(found.folderId)!.filter((m) => m !== found.m)
					);
					folders.get(target)!.push({ ...found.m, uid: targetUid });
					pairs.push({ sourceUid: found.m.uid, targetUid });
				}
				if (pairs.length > 0) revision += 1;
				return { uidValidity: 1, pairs };
			}
			throw new Error(`unexpected mutation ${name}`);
		}
	);

	return {
		convex: { query, mutation, action: vi.fn() },
		counts,
		mutation,
		uidsOf: (id: string) => sorted(id).map((m) => m.uid),
		flagged: () =>
			sorted('f1')
				.filter((m) => m.flagged || m.deleted)
				.map((m) => m.uid),
		/** Another session's EXPUNGE of `uid`. */
		expunge(uid: number) {
			folders.set(
				'f1',
				folders.get('f1')!.filter((m) => m.uid !== uid)
			);
			revision += 1;
		},
		/** A delivery into the INBOX. */
		deliver() {
			const uid = uidNext.get('f1')!;
			uidNext.set('f1', uid + 1);
			folders.get('f1')!.push({ uid, deleted: false, flagged: false });
			revision += 1;
			return uid;
		},
		markDeleted(uid: number) {
			folders.get('f1')!.find((m) => m.uid === uid)!.deleted = true;
		},
	};
}

/** One client connection: state threaded through `commit`, lines per command. */
function session(convex: unknown) {
	let state: ConnectionState = {
		auth: { mailboxId: 'mb1', appPasswordId: 'ap1', address: 'a@owlat.test', userId: 'u1' },
		selected: null,
		clientId: null,
	};
	const deps = {
		convex,
		config: { idleTimeoutMs: 60_000 },
		commit: (next: ConnectionState) => {
			state = next;
		},
	} as unknown as CommandDeps;
	return {
		async run(line: string): Promise<string[]> {
			const lines: string[] = [];
			const parsed = parseLine(line)!;
			await dispatch(deps, state, parsed, (l) => lines.push(String(l))).completion;
			return lines;
		},
		get state() {
			return state;
		},
	};
}

beforeEach(() => forgetCachedMemberships());

describe('cross-session EXPUNGE cannot retarget a sequence number (#927)', () => {
	it('FETCH 2 after another session expunged message 2 returns nothing, not message 3', async () => {
		const b = backend([10, 20, 30]);
		const a = session(b.convex);
		expect(await a.run('a1 SELECT INBOX')).toContain('* 3 EXISTS');
		b.expunge(20);

		expect(await a.run('a2 FETCH 2 (UID)')).toEqual(['a2 OK FETCH completed']);
		expect(await a.run('a3 FETCH 3 (UID)')).toEqual([
			'* 3 FETCH (UID 30)',
			'a3 OK FETCH completed',
		]);
	});

	it('STORE 2 +FLAGS (\\Deleted) does not flag the message after it', async () => {
		const b = backend([10, 20, 30]);
		const a = session(b.convex);
		await a.run('a1 SELECT INBOX');
		b.expunge(20);

		expect(await a.run('a2 STORE 2 +FLAGS (\\Deleted)')).toEqual(['a2 OK STORE completed']);
		expect(b.flagged()).toEqual([]);
		// Its EXPUNGE would have deleted UID 30 for good.
		expect(b.uidsOf('f1')).toEqual([10, 30]);
	});

	it('NOOP announces the expunge; from then on 2 is the next message', async () => {
		const b = backend([10, 20, 30]);
		const a = session(b.convex);
		await a.run('a1 SELECT INBOX');
		b.expunge(20);

		expect(await a.run('a2 NOOP')).toEqual(['* 2 EXPUNGE', 'a2 OK NOOP completed']);
		expect(await a.run('a3 FETCH 2 (UID)')).toEqual([
			'* 2 FETCH (UID 30)',
			'a3 OK FETCH completed',
		]);
		// Nothing new: a second NOOP is silent.
		expect(await a.run('a4 CHECK')).toEqual(['a4 OK CHECK completed']);
	});

	it('a UID command announces what changed before answering with numbers the client knows', async () => {
		const b = backend([10, 20, 30]);
		const a = session(b.convex);
		await a.run('a1 SELECT INBOX');
		b.expunge(10);
		const fresh = b.deliver();

		expect(await a.run(`a2 UID FETCH 20:* (FLAGS)`)).toEqual([
			'* 1 EXPUNGE',
			'* 3 EXISTS',
			'* 1 FETCH (UID 20 FLAGS (\\Seen))',
			'* 2 FETCH (UID 30 FLAGS (\\Seen))',
			`* 3 FETCH (UID ${fresh} FLAGS (\\Seen))`,
			'a2 OK UID FETCH completed',
		]);
	});

	it('a new message stays out of a sequence FETCH until it is announced', async () => {
		const b = backend([10, 20, 30]);
		const a = session(b.convex);
		await a.run('a1 SELECT INBOX');
		const fresh = b.deliver();

		const before = await a.run('a2 FETCH 1:* (UID)');
		expect(before.filter((l) => l.startsWith('* '))).toHaveLength(3);
		expect(await a.run('a3 NOOP')).toEqual(['* 4 EXISTS', 'a3 OK NOOP completed']);
		expect(await a.run('a4 FETCH 4 (UID)')).toEqual([
			`* 4 FETCH (UID ${fresh})`,
			'a4 OK FETCH completed',
		]);
	});

	it("MOVE by sequence number moves the client's message and reports the client's number", async () => {
		const b = backend([10, 20, 30]);
		const a = session(b.convex);
		await a.run('a1 SELECT INBOX');
		b.expunge(10);

		const lines = await a.run('a2 MOVE 3 Archive');
		expect(lines).toEqual(['* OK [COPYUID 1 30 1] Move', '* 3 EXPUNGE', 'a2 OK MOVE completed']);
		expect(b.uidsOf('f2')).toEqual([1]);
		// The client was told about message 3 only; 10 is still owed to it.
		expect(a.state.selected!.view!.uids).toEqual([10, 20]);
		expect(await a.run('a3 NOOP')).toEqual(['* 1 EXPUNGE', 'a3 OK NOOP completed']);
	});

	it("EXPUNGE numbers its own removals against the client's view, not the folder's", async () => {
		const b = backend([10, 20, 30, 40]);
		const a = session(b.convex);
		await a.run('a1 SELECT INBOX');
		b.expunge(20);
		b.markDeleted(40);

		expect(await a.run('a2 EXPUNGE')).toEqual([
			// B's expunge first, then A's own: UID 40 is now message 3.
			'* 2 EXPUNGE',
			'* 3 EXPUNGE',
			'a2 OK EXPUNGE completed',
		]);
		expect(a.state.selected!.view!.uids).toEqual([10, 30]);
	});

	it('an older backend without expunged UIDs falls back to its numbers and re-reads the view', async () => {
		const b = backend([10, 20, 30]);
		const a = session(b.convex);
		await a.run('a1 SELECT INBOX');
		b.markDeleted(20);
		const real = b.mutation.getMockImplementation()!;
		b.mutation.mockImplementation(
			async (ref: AnyFunctionReference, args: Record<string, unknown>) => {
				const out = (await real(ref, args)) as Record<string, unknown>;
				delete out['uids'];
				return out;
			}
		);

		expect(await a.run('a2 EXPUNGE')).toEqual(['* 2 EXPUNGE', 'a2 OK EXPUNGE completed']);
		expect(a.state.selected!.view!.uids).toEqual([10, 30]);
		expect(await a.run('a3 NOOP')).toEqual(['a3 OK NOOP completed']);
	});
});

describe('repeated commands on an unchanged folder do not re-read it (#927)', () => {
	const folder = Array.from({ length: 3_000 }, (_, i) => i + 1);

	it('a sequence FETCH reads no membership at all, a UID FETCH one version check', async () => {
		const b = backend(folder);
		const a = session(b.convex);
		await a.run('a1 SELECT INBOX');
		expect(b.counts).toMatchObject({ membership: 1, blockDocs: 12, listing: 0 });

		for (let i = 0; i < 3; i++) await a.run(`s${i} FETCH 1500 (FLAGS)`);
		expect(b.counts).toMatchObject({ membership: 1, blockDocs: 12, listing: 0 });

		for (let i = 0; i < 3; i++) await a.run(`u${i} UID FETCH 1500 (FLAGS)`);
		expect(b.counts).toMatchObject({ membership: 4, blockDocs: 12, listing: 0 });
		expect(b.counts.envelopeDocs).toBe(6);
	});

	it('another session on the same folder shares the cached map', async () => {
		const b = backend(folder);
		await session(b.convex).run('a1 SELECT INBOX');
		await session(b.convex).run('c1 SELECT INBOX');
		expect(b.counts).toMatchObject({ membership: 2, blockDocs: 12 });
	});

	it('a change reloads the blocks once, then the map is reused again', async () => {
		const b = backend(folder);
		const a = session(b.convex);
		await a.run('a1 SELECT INBOX');
		b.deliver();
		expect(await a.run('a2 UID FETCH 1 (FLAGS)')).toContain('* 3001 EXISTS');
		await a.run('a3 UID FETCH 1 (FLAGS)');
		expect(b.counts).toMatchObject({ membership: 3, blockDocs: 24, listing: 0 });
	});

	it('a folder whose membership is not maintained yet is listed per command, as before', async () => {
		const b = backend(folder, 'none');
		const a = session(b.convex);
		await a.run('a1 SELECT INBOX');
		await a.run('a2 UID FETCH 1 (FLAGS)');
		await a.run('a3 UID FETCH 1 (FLAGS)');
		// Three full pages and the empty one that ends each walk, three times.
		expect(b.counts).toMatchObject({ membership: 3, listing: 12, listedDocs: 9_000 });
	});
});

/**
 * The same backend behind the real `ImapConnection` pump, which starts
 * pipelined commands without waiting for the ones before them. `hold` pauses
 * the first call of one backend function until released, so a command can be
 * caught half-way, the way a slow read or a slow client would leave it.
 */
function connection(b: ReturnType<typeof backend>) {
	const config: ImapConfig = {
		port: 0,
		listenAddress: '127.0.0.1',
		tls: null,
		greetingHost: 'imap.test',
		convexUrl: 'https://example.convex.cloud',
		convexAdminKey: 'k',
		redisUrl: null,
		maxConnectionsPerIp: 20,
		maxClients: 500,
		idleTimeoutMs: 60_000,
		authRateLimit: { failuresPerWindow: 5, windowMs: 60_000, tarpitMs: 900_000 },
	};
	const written: string[] = [];
	const socket = Object.assign(new EventEmitter(), {
		write(data: string | Buffer) {
			written.push(String(data));
			return true;
		},
		end() {
			socket.emit('close');
		},
	});
	b.convex.action.mockResolvedValue({
		mailboxId: 'mb1',
		appPasswordId: 'ap1',
		userId: 'u1',
		organizationId: 'org1',
	});
	const imap = new ImapConnection(
		socket as unknown as Socket,
		config,
		b.convex as unknown as ConvexClient,
		new AuthRateLimiter(null, config.authRateLimit),
		'127.0.0.1',
		true
	);
	const lines = () => written.join('').split('\r\n').filter(Boolean);
	const settle = async () => {
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	};
	return {
		imap,
		send(line: string) {
			socket.emit('data', Buffer.from(`${line}\r\n`));
		},
		settle,
		/** Wait for the tagged completion of every tag given. */
		async until(...tags: string[]) {
			for (let i = 0; i < 200; i++) {
				const done = lines();
				if (tags.every((tag) => done.some((l) => l.startsWith(`${tag} `)))) return;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			throw new Error(`no completion for ${tags.join(', ')}: ${lines().join(' | ')}`);
		},
		/** Lines written since the last `clear`. */
		lines,
		clear() {
			written.length = 0;
		},
		async open() {
			this.send('a0 LOGIN "a@owlat.test" "pw"');
			await this.until('a0');
			this.send('a1 SELECT INBOX');
			await this.until('a1');
			expect(lines()).toContain('* 3 EXISTS');
			this.clear();
		},
		hold(suffix: string, kind: 'query' | 'mutation' = 'query') {
			const fnMock = kind === 'query' ? b.convex.query : b.mutation;
			const real = fnMock.getMockImplementation()!;
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let entered!: () => void;
			const reached = new Promise<void>((resolve) => {
				entered = resolve;
			});
			let armed = true;
			fnMock.mockImplementation(
				async (ref: AnyFunctionReference, args: Record<string, unknown>) => {
					if (armed && getFunctionName(ref).endsWith(suffix)) {
						armed = false;
						entered();
						await gate;
					}
					return real(ref, args);
				}
			);
			return { reached, release };
		},
	};
}

describe('pipelined commands: no announcement while a sequence-number command is in progress (#927)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	// RFC 3501 §5.5 and §7.4.1: the server must not send EXPUNGE while a FETCH,
	// STORE or SEARCH is in progress. Before the fix the pump ran NOOP beside
	// the paused FETCH, so `* 2 EXPUNGE` went out first and the FETCH then
	// answered `* 3 FETCH (UID 30)` to a client that now held two messages.
	it.each(['NOOP', 'CHECK'])(
		'FETCH, then a pipelined %s: the FETCH answers first',
		async (verb) => {
			const b = backend([10, 20, 30]);
			const c = connection(b);
			await c.open();
			const fetch = c.hold(':fetchEnvelopes');
			c.send('f FETCH 3 (UID)');
			await fetch.reached;
			b.expunge(20);
			c.send(`n ${verb}`);
			await c.settle();
			fetch.release();
			await c.until('f', 'n');

			expect(c.lines()).toEqual([
				'* 3 FETCH (UID 30)',
				'f OK FETCH completed',
				'* 2 EXPUNGE',
				`n OK ${verb} completed`,
			]);
		}
	);

	it('FETCH, then a pipelined UID FETCH: the UID command announces after the FETCH', async () => {
		const b = backend([10, 20, 30]);
		const c = connection(b);
		await c.open();
		const fetch = c.hold(':fetchEnvelopes');
		c.send('f FETCH 3 (UID)');
		await fetch.reached;
		b.expunge(20);
		c.send('u UID FETCH 30 (FLAGS)');
		await c.settle();
		fetch.release();
		await c.until('f', 'u');

		expect(c.lines()).toEqual([
			'* 3 FETCH (UID 30)',
			'f OK FETCH completed',
			'* 2 EXPUNGE',
			'* 2 FETCH (UID 30 FLAGS (\\Seen))',
			'u OK UID FETCH completed',
		]);
	});

	it('STORE, then a pipelined NOOP: the STORE answers with the numbers it was given', async () => {
		const b = backend([10, 20, 30]);
		const c = connection(b);
		await c.open();
		const store = c.hold(':storeFlags', 'mutation');
		c.send('s STORE 3 +FLAGS (\\Flagged)');
		await store.reached;
		b.expunge(20);
		c.send('n NOOP');
		await c.settle();
		store.release();
		await c.until('s', 'n');

		expect(c.lines()).toEqual([
			'* 3 FETCH (UID 30 MODSEQ (2) FLAGS (\\Flagged))',
			's OK STORE completed',
			'* 2 EXPUNGE',
			'n OK NOOP completed',
		]);
	});

	it("FETCH, then a pipelined MOVE: the MOVE's EXPUNGE waits for the FETCH", async () => {
		const b = backend([10, 20, 30]);
		const c = connection(b);
		await c.open();
		const fetch = c.hold(':fetchEnvelopes');
		c.send('f FETCH 3 (UID)');
		await fetch.reached;
		c.send('m MOVE 1 Archive');
		await c.settle();
		fetch.release();
		await c.until('f', 'm');

		expect(c.lines()).toEqual([
			'* 3 FETCH (UID 30)',
			'f OK FETCH completed',
			'* OK [COPYUID 1 10 1] Move',
			'* 1 EXPUNGE',
			'm OK MOVE completed',
		]);
	});

	it('NOOP, then a pipelined FETCH: the FETCH uses the numbering the NOOP announced', async () => {
		const b = backend([10, 20, 30]);
		const c = connection(b);
		await c.open();
		b.expunge(20);
		const look = c.hold(':folderMembershipPage');
		c.send('n NOOP');
		await look.reached;
		c.send('f FETCH 2 (UID)');
		await c.settle();
		look.release();
		await c.until('n', 'f');

		expect(c.lines()).toEqual([
			'* 2 EXPUNGE',
			'n OK NOOP completed',
			'* 2 FETCH (UID 30)',
			'f OK FETCH completed',
		]);
	});

	it('an IDLE poll holds its EXPUNGE until a pipelined FETCH before it is done', async () => {
		const b = backend([10, 20, 30]);
		const c = connection(b);
		await c.open();
		const fetch = c.hold(':fetchEnvelopes');
		c.send('f FETCH 3 (UID)');
		await fetch.reached;
		// IDLE schedules each poll with setTimeout, which settle() also uses: fake
		// it only while the first poll is started, then hand back real timers.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		c.send('i IDLE');
		await vi.advanceTimersByTimeAsync(0);
		b.expunge(20);
		await vi.advanceTimersByTimeAsync(5_000);
		vi.useRealTimers();
		await c.settle();
		fetch.release();
		await c.until('f');
		await c.settle();
		c.send('DONE');
		await c.until('i');

		expect(c.lines()).toEqual([
			'+ idling',
			'* 3 FETCH (UID 30)',
			'f OK FETCH completed',
			'* 2 EXPUNGE',
			'i OK IDLE terminated',
		]);
	});

	it('pipelined commands that announce nothing still run side by side', async () => {
		const b = backend([10, 20, 30]);
		const c = connection(b);
		await c.open();
		const fetch = c.hold(':fetchEnvelopes');
		c.send('f FETCH 3 (UID)');
		await fetch.reached;
		c.send('g FETCH 1 (UID)');
		c.send('u UID FETCH 20 (UID)');
		c.send('n NOOP');
		await c.until('g', 'u', 'n');

		// All three completed while the first FETCH is still paused.
		expect(c.lines()).toHaveLength(5);
		expect(c.lines()).toEqual(
			expect.arrayContaining([
				'* 1 FETCH (UID 10)',
				'g OK FETCH completed',
				'* 2 FETCH (UID 20)',
				'u OK UID FETCH completed',
				'n OK NOOP completed',
			])
		);
		fetch.release();
		await c.until('f');
		expect(c.lines().slice(-2)).toEqual(['* 3 FETCH (UID 30)', 'f OK FETCH completed']);
	});
});
