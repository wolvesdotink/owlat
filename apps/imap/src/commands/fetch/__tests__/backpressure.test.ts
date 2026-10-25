/**
 * FETCH output is paced by the socket and stops when the connection goes
 * (issue #926). Before, a client that stopped reading made the server download
 * and queue the whole requested mailbox (the socket's `writableLength` grew to
 * the full payload), and a client that disconnected mid-FETCH left the server
 * minting URLs, writing \Seen and downloading every remaining body.
 *
 * The first block drives `fetchModule` directly with a controllable
 * `waitForDrain` and `cancel()`; the last one runs the real `ImapConnection`
 * behind a real loopback TCP socket pair with a client that stops reading.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { getFunctionName } from 'convex/server';
import { fetchModule, type FetchArgs } from '../index.js';
import type { FetchEnvelope } from '../format.js';
import type { CommandDeps, ConnectionState, StartArgs } from '../../types.js';
import { forEachOrdered, RAW_DOWNLOAD_CONCURRENCY, RAW_URL_BATCH } from '../rawBodies.js';
import { ImapConnection } from '../../../connection.js';
import type { ImapConfig } from '../../../config.js';
import type { ConvexClient } from '../../../convex.js';
import { AuthRateLimiter } from '../../../rateLimit.js';
import { drainWaiter, OUTPUT_BUDGET_BYTES } from '../../../socketOutput.js';
import { EventEmitter } from 'node:events';

// convex/server declares AnyFunctionReference without exporting it.
type AnyFunctionReference = Parameters<typeof getFunctionName>[0];

vi.mock('../../../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function envelope(uid: number): FetchEnvelope {
	return {
		_id: `m-${uid}`,
		uid,
		modseq: 1,
		rawSize: 10,
		rfc822MessageId: `mid-${uid}@owlat.test`,
		fromAddress: 'jane@owlat.test',
		toAddresses: ['bob@owlat.test'],
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
	};
}

/** A body of `size` octets with a header block and one 8-bit octet at the end. */
function body(uid: number, size: number): Buffer {
	const b = Buffer.alloc(size, 0x78);
	Buffer.from(`Subject: ${uid}\r\n\r\n`, 'ascii').copy(b, 0);
	b[size - 1] = 0xff;
	return b;
}

/** Mock Convex backend for one folder of `count` messages plus a counting storage stub. */
function backend(count: number, bodySize: number) {
	const counts = { convex: 0, downloads: 0 };
	const downloadWaiters: Array<{ count: number; resolve: () => void }> = [];
	const convex = {
		query: vi.fn(async (fnRef: AnyFunctionReference, params: Record<string, unknown>) => {
			counts.convex++;
			const ref = getFunctionName(fnRef);
			if (ref.endsWith(':listFolders')) return [FOLDER(count)];
			if (ref.endsWith(':selectFolder')) return { folder: FOLDER(count) };
			if (ref.endsWith(':folderMembershipPage')) return null;
			if (ref.endsWith(':listFolderUidsPage')) {
				return { uids: Array.from({ length: count }, (_, i) => i + 1), nextUid: null };
			}
			if (ref.endsWith(':fetchEnvelopes')) {
				const low = params['uidLow'] as number;
				const high = Math.min(params['uidHigh'] as number, count);
				const rows = [];
				for (let uid = low; uid <= high; uid++) rows.push(envelope(uid));
				return { rows, nextUid: null };
			}
			return null;
		}),
		action: vi.fn(async (fnRef: AnyFunctionReference, params: Record<string, unknown>) => {
			counts.convex++;
			const ref = getFunctionName(fnRef);
			if (ref === 'mail/appPasswords:verify') {
				return { mailboxId: 'mb1', appPasswordId: 'ap1', userId: 'u1', organizationId: 'o1' };
			}
			return (params['messageIds'] as string[]).map((messageId) => ({
				messageId,
				url: `https://storage.test/raw?uid=${messageId.slice(2)}`,
			}));
		}),
		mutation: vi.fn(async (_fnRef: AnyFunctionReference, params: Record<string, unknown>) => {
			counts.convex++;
			return {
				updated: ((params['messageIds'] as string[] | undefined) ?? []).map((messageId) => ({
					messageId,
					uid: Number(messageId.slice(2)),
					modseq: 2,
					flags: ['\\Seen'],
				})),
				unchanged: [],
			};
		}),
	};
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
			counts.downloads++;
			for (const waiter of downloadWaiters.filter((w) => counts.downloads >= w.count)) {
				downloadWaiters.splice(downloadWaiters.indexOf(waiter), 1);
				waiter.resolve();
			}
			await new Promise<void>((resolve, reject) => {
				const t = setTimeout(resolve, 1);
				init?.signal?.addEventListener('abort', () => {
					clearTimeout(t);
					reject(init.signal!.reason);
				});
			});
			const bytes = body(Number(new URL(url).searchParams.get('uid')), bodySize);
			return {
				ok: true,
				arrayBuffer: async () =>
					bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
			};
		})
	);
	/** Resolves once `n` downloads have started. */
	const downloaded = (n: number) =>
		new Promise<void>((resolve) => downloadWaiters.push({ count: n, resolve }));
	return { convex, counts, downloaded };
}

const FOLDER = (count: number) => ({
	_id: 'f1',
	name: 'INBOX',
	role: 'inbox',
	uidValidity: 1,
	uidNext: count + 1,
	highestModseq: 1,
	totalCount: count,
	unseenCount: count,
});

function selectedState(count: number): ConnectionState {
	return {
		auth: { mailboxId: 'mb1', appPasswordId: 'ap1', address: 'a@test', userId: 'u1' },
		selected: {
			folderId: 'f1',
			folderName: 'INBOX',
			uidValidity: 1,
			uidNext: count + 1,
			highestModseq: 1,
			totalCount: count,
			readOnly: false,
		},
		clientId: null,
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('FETCH pacing and cancellation (module)', () => {
	const COUNT = RAW_URL_BATCH * 3;

	function start(waitForDrain?: () => Promise<void> | undefined) {
		const b = backend(COUNT, 64);
		const lines: string[] = [];
		const startArgs: StartArgs<FetchArgs> = {
			deps: { convex: b.convex, waitForDrain } as unknown as CommandDeps,
			state: selectedState(COUNT),
			args: { set: `1:${COUNT}`, itemsToken: '(UID BODY[])', byUid: false },
			tag: 'a001',
			verb: 'FETCH',
			send: (line) => lines.push(typeof line === 'string' ? line : line.toString('latin1')),
		};
		return { ...b, lines, session: fetchModule.start(startArgs) };
	}

	it('stops downloading while the socket is over budget, and resumes on drain', async () => {
		let release: () => void = () => {};
		let blocked = true;
		const h = start(() =>
			blocked ? new Promise<void>((resolve) => (release = resolve)) : undefined
		);
		await settle();
		// One response went out and is waiting for drain; only the downloads
		// already in the ordered window may have started.
		expect(h.lines).toHaveLength(1);
		expect(h.counts.downloads).toBeLessThanOrEqual(RAW_DOWNLOAD_CONCURRENCY + 1);

		blocked = false;
		release();
		await h.session.completion;
		expect(h.lines.filter((l) => l.startsWith('* '))).toHaveLength(COUNT);
		expect(h.lines.at(-1)).toBe('a001 OK FETCH completed');
	});

	it('issues no Convex call or download after cancel, sends nothing more, and completes', async () => {
		let release: () => void = () => {};
		const h = start(() => new Promise<void>((resolve) => (release = resolve)));
		await settle();
		const before = { ...h.counts, lines: h.lines.length };

		h.session.cancel();
		release();
		await h.session.completion;
		await settle();

		expect(h.counts.convex).toBe(before.convex);
		expect(h.counts.downloads).toBe(before.downloads);
		// No tagged reply (nobody is listening) and no further FETCH lines.
		expect(h.lines).toHaveLength(before.lines);
		// The \Seen write covered the first chunk only, not the remaining ones.
		expect(h.convex.mutation).toHaveBeenCalledTimes(1);
	});

	it('a cancel during the page walk stops it before the envelopes are read', async () => {
		const h = start();
		h.session.cancel();
		await h.session.completion;
		const refs = h.convex.query.mock.calls.map((c) => getFunctionName(c[0]));
		expect(refs.some((r) => r.endsWith(':fetchEnvelopes'))).toBe(false);
		expect(h.counts.downloads).toBe(0);
		expect(h.lines).toEqual([]);
	});
});

describe('forEachOrdered with an async emit', () => {
	it('starts no new work while an emit is pending', async () => {
		let started = 0;
		let release: () => void = () => {};
		const done = forEachOrdered(
			Array.from({ length: 20 }, (_, i) => i),
			3,
			async (n) => {
				started++;
				return n;
			},
			(n) => (n === 0 ? new Promise<void>((resolve) => (release = resolve)) : undefined)
		);
		await settle();
		expect(started).toBe(3);
		release();
		await done;
		expect(started).toBe(20);
	});

	it('settles in-flight work and rejects with the abort reason once aborted', async () => {
		const controller = new AbortController();
		let started = 0;
		let settled = 0;
		const done = forEachOrdered(
			Array.from({ length: 20 }, (_, i) => i),
			4,
			async (n) => {
				started++;
				await new Promise((resolve) => setTimeout(resolve, 5));
				settled++;
				return n;
			},
			(n) => {
				if (n === 1) controller.abort(new Error('gone'));
			},
			controller.signal
		);
		await expect(done).rejects.toThrow('gone');
		expect(started).toBe(settled);
		expect(started).toBeLessThanOrEqual(6);
	});
});

describe('drainWaiter', () => {
	function socket(queued: number) {
		return Object.assign(new EventEmitter(), {
			destroyed: false,
			writableNeedDrain: true,
			writableLength: queued,
		}) as unknown as net.Socket;
	}

	it('asks for no wait while the queue is within the budget', () => {
		expect(drainWaiter(socket(OUTPUT_BUDGET_BYTES), () => false)()).toBeUndefined();
	});

	it('shares one wait, released by drain, and leaves no listener behind', async () => {
		const sock = socket(OUTPUT_BUDGET_BYTES + 1);
		const wait = drainWaiter(sock, () => false);
		const first = wait();
		expect(first).toBeInstanceOf(Promise);
		expect(wait()).toBe(first);
		sock.emit('drain');
		await first;
		expect(sock.listenerCount('drain') + sock.listenerCount('close')).toBe(0);
	});

	it('is released by close, so a vanished peer never strands the writer', async () => {
		const sock = socket(OUTPUT_BUDGET_BYTES + 1);
		const first = drainWaiter(sock, () => false)();
		sock.emit('close');
		await expect(first).resolves.toBeUndefined();
	});
});

describe('FETCH over a real TCP socket to a client that stops reading', () => {
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
		production: false,
		owlatVersion: 'dev',
	};
	const COUNT = 300;
	const SIZE = 256 * 1024;

	/**
	 * Collects what the client receives and resolves `completed(tag)` once the
	 * tagged reply has arrived in full. Tagged lines are matched on a rolling
	 * tail of the stream, so a line split across chunks is still seen, and a
	 * reply that lands before the test asks for it is remembered.
	 */
	function replies(client: net.Socket) {
		const chunks: Buffer[] = [];
		const done = new Set<string>();
		const waiters: Array<{ tag: string; resolve: () => void; reject: (err: Error) => void }> = [];
		let tail = '';
		let gone: Error | null = null;
		const wake = () => {
			for (const waiter of waiters.filter((w) => done.has(w.tag) || gone)) {
				waiters.splice(waiters.indexOf(waiter), 1);
				if (done.has(waiter.tag)) waiter.resolve();
				else waiter.reject(gone!);
			}
		};
		client.on('data', (chunk: Buffer) => {
			chunks.push(chunk);
			tail = (tail + chunk.toString('latin1')).slice(-4096);
			for (const match of tail.matchAll(/\r\n([a-z0-9]+) (?:OK|NO|BAD)[^\r\n]*\r\n/g)) {
				done.add(match[1]!);
			}
			wake();
		});
		const end = () => {
			gone ??= new Error('connection closed before the tagged reply');
			wake();
		};
		client.on('close', end);
		client.on('error', end);
		return {
			chunks,
			completed(tag: string) {
				return new Promise<void>((resolve, reject) => {
					waiters.push({ tag, resolve, reject });
					wake();
				});
			},
			/** Forget what was received so far (the bytes and the tags). */
			clear() {
				chunks.length = 0;
				done.clear();
				tail = '';
			},
		};
	}

	it('keeps the server queue at the output budget, then delivers every octet', async () => {
		const b = backend(COUNT, SIZE);
		const connections: ImapConnection[] = [];
		// The server side, observed without changing it: the peak of its queue
		// sampled at every write, and the moment the FETCH first parks on
		// `drain` (the drain waiter is the only thing that listens for it).
		let peakQueued = 0;
		let markPaced!: () => void;
		const paced = new Promise<void>((resolve) => (markPaced = resolve));
		const server = net.createServer((sock) => {
			const write = sock.write.bind(sock) as (...args: unknown[]) => boolean;
			sock.write = ((...args: unknown[]) => {
				const ok = write(...args);
				peakQueued = Math.max(peakQueued, sock.writableLength);
				return ok;
			}) as typeof sock.write;
			sock.on('newListener', (event) => {
				if (event === 'drain') markPaced();
			});
			connections.push(
				new ImapConnection(
					sock,
					config,
					b.convex as unknown as ConvexClient,
					new AuthRateLimiter(null, config.authRateLimit),
					'127.0.0.1',
					true
				)
			);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as net.AddressInfo;
		const client = net.connect(port, '127.0.0.1');
		const received = replies(client);
		try {
			client.write('a1 LOGIN "a@owlat.test" "pw"\r\n');
			await received.completed('a1');
			client.write('a2 SELECT INBOX\r\n');
			await received.completed('a2');
			received.clear();

			client.pause();
			// Unpaced, the server would download every body and finish the
			// FETCH without ever waiting; that also ends this wait, so the
			// download bound below fails instead of the test hanging.
			const allDownloaded = b.downloaded(COUNT);
			client.write(`a3 FETCH 1:${COUNT} BODY.PEEK[]\r\n`);
			await Promise.race([paced, allDownloaded]);
			// Unpaced, the whole 75 MiB response sat in the queue and every
			// body was downloaded. Paced, the FETCH parks on drain once the
			// kernel buffers are full and the queue is past the 1 MiB budget,
			// with the queue never more than the budget plus one response.
			expect(b.counts.downloads).toBeLessThan(COUNT / 2);
			expect(peakQueued).toBeGreaterThan(OUTPUT_BUDGET_BYTES);
			expect(peakQueued).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES + SIZE + 1024);

			client.resume();
			await received.completed('a3');
			expect(peakQueued).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES + SIZE + 1024);
			const wire = Buffer.concat(received.chunks);
			// Literal framing and octets intact, in sequence order.
			let at = 0;
			for (let seq = 1; seq <= COUNT; seq++) {
				const head = `* ${seq} FETCH (BODY[] {${SIZE}}\r\n`;
				expect(wire.toString('latin1', at, at + head.length)).toBe(head);
				at += head.length;
				expect(wire.subarray(at, at + SIZE).equals(body(seq, SIZE))).toBe(true);
				at += SIZE;
				expect(wire.toString('latin1', at, at + 3)).toBe(')\r\n');
				at += 3;
			}
			expect(wire.toString('latin1', at)).toBe('a3 OK FETCH completed\r\n');
		} finally {
			client.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 30_000);
});
