/**
 * X1 named-gate integration suite: TRUE socket reuse in the MTA pool.
 *
 * Drives the REAL {@link SmtpConnectionPool} + real @owlat/smtp-client against a
 * real in-process fake MX (`smtp-server`, a dev dependency), mirroring the
 * sender's per-delivery reuse lifecycle (acquire → takeConnection → connect? →
 * sendEnvelope → storeConnection/evictConnection → release). It locks the four
 * named gate cases:
 *   (a) N sequential sends to one MX use ONE connection with RSET boundaries;
 *       the (cap)-th delivery cleanly QUITs and the next reconnects;
 *   (b) a socket death mid-stream evicts the entry, releases the Redis slot, and
 *       the in-flight job retries on a fresh connection exactly once;
 *   (c) secured + TLS-RPT are per-CONNECTION — every message on a reused socket
 *       is attributed to the same TLS state;
 *   (d) the reused_total counter rises once per RSET reuse.
 *
 * The reviewer's focus — state leakage between transactions on a reused socket —
 * is covered here (each of N messages is delivered with its own envelope over one
 * socket) and, at the primitive level, in
 * packages/smtp-client/__tests__/transactionReset.integration.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { SMTPServer } from 'smtp-server';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis-mock';
import type IORedis from 'ioredis';
import { SmtpConnection, sendEnvelope, isSmtpError } from '@owlat/smtp-client';
import {
	SmtpConnectionPool,
	smtpPoolReused,
	type AcquireOptions,
	type PoolConfig,
} from '../connectionPool.js';
import { MX_CERT, MX_KEY } from './certFixture.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	// LIFO: close the pool (which may park a live idle socket) BEFORE the fake MX
	// it connected to. `server.close()` waits for every open connection to end, so
	// tearing the MX down while the pool still holds a socket hangs the hook — run
	// cleanups in reverse insertion order (the pool is pushed after its MX).
	for (const fn of cleanups.splice(0).reverse()) {
		await fn();
	}
});

/** Poll `pred` until it holds or the deadline elapses (for fire-and-forget QUITs). */
async function waitUntil(pred: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!pred() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

interface FakeMx {
	port: number;
	connections(): number;
	/** Cleartext QUIT commands observed across all sessions (proves a clean QUIT teardown). */
	quits(): number;
	messages(): Array<{ to: string[]; body: string; secure: boolean }>;
}

/** A loopback fake MX. `starttls: true` advertises + accepts STARTTLS (self-signed). */
async function startFakeMx(opts: { starttls?: boolean } = {}): Promise<FakeMx> {
	let connections = 0;
	let quits = 0;
	const messages: Array<{ to: string[]; body: string; secure: boolean }> = [];
	const server = new SMTPServer({
		secure: false,
		authOptional: true,
		disabledCommands: opts.starttls ? ['AUTH'] : ['AUTH', 'STARTTLS'],
		hideSTARTTLS: !opts.starttls,
		cert: MX_CERT,
		key: MX_KEY,
		minVersion: 'TLSv1.2',
		onConnect: (_session, cb) => {
			connections += 1;
			cb();
		},
		onData(stream, session, cb) {
			let body = '';
			const secure = session.secure === true;
			stream.on('data', (chunk) => {
				body += chunk.toString('utf8');
			});
			stream.on('end', () => {
				messages.push({ to: session.envelope.rcptTo.map((r) => r.address), body, secure });
				cb();
			});
		},
	});
	server.on('error', () => {});
	// Sniff cleartext client→server bytes in parallel with smtp-server's own parser
	// (a `.pipe()` is non-exclusive, so an extra 'data' listener sees the same
	// chunks) to observe a graceful QUIT. This distinguishes a clean QUIT teardown
	// from a destroyed socket, which `connections()` alone cannot. Post-STARTTLS
	// traffic is encrypted on a different socket, so QUIT sniffing covers the
	// cleartext sessions the QUIT assertions use.
	server.server.on('connection', (socket) => {
		socket.on('data', (chunk: Buffer) => {
			if (/^QUIT\b/im.test(chunk.toString('utf8'))) quits += 1;
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
	const port = (server.server.address() as AddressInfo).port;
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return {
		port,
		connections: () => connections,
		quits: () => quits,
		messages: () => messages,
	};
}

/** Per-connection misbehaviour a {@link startRawMx} peer injects, keyed by connection index. */
interface RawConnBehavior {
	/** Override the MAIL FROM reply (e.g. a `421` channel close) instead of the default 250. */
	mailReply?: string;
	/** Destroy the socket immediately after answering MAIL FROM (a poisoned pre-DATA session). */
	destroyOnMail?: boolean;
	/** Destroy the socket after the body but BEFORE the final reply (socket death mid-stream). */
	destroyMidData?: boolean;
	/** After the final 250, destroy the (now idle, parked) socket this many ms later. */
	destroyWhenIdleMs?: number;
}

/**
 * A raw loopback SMTP peer whose behaviour per connection is scripted by
 * `behavior(connIndex)`. Speaks enough SMTP (EHLO/MAIL/RCPT/DATA/QUIT) to drive
 * the pool's reuse lifecycle without smtp-server's graceful handling, so the
 * guardrail tests can inject a mid-stream death, a 421 channel close, or an
 * idle-socket close. One faithful read loop shared by every guardrail case.
 */
async function startRawMx(
	behavior: (connIndex: number) => RawConnBehavior = () => ({})
): Promise<{ port: number; connections(): number }> {
	let connIndex = 0;
	const server = net.createServer((socket) => {
		connIndex += 1;
		const b = behavior(connIndex);
		socket.on('error', () => {});
		socket.write('220 raw.test ESMTP\r\n');
		let buffer = '';
		let inData = false;
		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8');
			if (inData) {
				const dotIdx = buffer.indexOf('\r\n.\r\n');
				if (dotIdx !== -1) {
					inData = false;
					buffer = buffer.slice(dotIdx + 5);
					if (b.destroyMidData) {
						socket.destroy(); // die AFTER the body, before the final reply
						return;
					}
					socket.write('250 2.0.0 queued\r\n');
					if (b.destroyWhenIdleMs !== undefined) {
						setTimeout(() => socket.destroy(), b.destroyWhenIdleMs);
					}
				}
				return;
			}
			let nl = buffer.indexOf('\n');
			while (nl !== -1) {
				const line = buffer.slice(0, nl).replace(/\r$/, '');
				buffer = buffer.slice(nl + 1);
				if (/^EHLO/i.test(line)) socket.write('250 raw.test\r\n');
				else if (/^MAIL FROM/i.test(line) && b.mailReply !== undefined) {
					socket.write(b.mailReply);
					if (b.destroyOnMail) {
						// Defer the destroy one tick so the reply flushes to the client first
						// (a 421 the client must classify before the channel drops).
						setImmediate(() => socket.destroy());
						return;
					}
				} else if (/^DATA$/i.test(line)) {
					inData = true;
					socket.write('354 go ahead\r\n');
				} else if (/^QUIT$/i.test(line)) socket.write('221 bye\r\n');
				else socket.write('250 ok\r\n');
				nl = buffer.indexOf('\n');
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const port = (server.address() as AddressInfo).port;
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return { port, connections: () => connIndex };
}

function makePool(port: number, overrides: Partial<PoolConfig> = {}): SmtpConnectionPool {
	const pool = new SmtpConnectionPool({
		maxPerHost: 5,
		idleTimeoutMs: 30_000,
		maxAgeMs: 300_000,
		maxMessagesPerConnection: 100,
		...overrides,
	});
	cleanups.push(() => pool.closeAll(500));
	return pool;
}

function acquireOptions(port: number): AcquireOptions {
	return { port, name: 'client.test', connectionTimeout: 5_000, greetingTimeout: 5_000 };
}

/** Mirror the sender's reuse lifecycle for one delivery, returning what happened. */
async function deliverOnce(
	pool: SmtpConnectionPool,
	port: number,
	envelope: { to: string[]; body: string }
): Promise<{ reused: boolean; secured: boolean }> {
	const { key, config } = await pool.acquire('127.0.0.1', '127.0.0.1', acquireOptions(port));
	let conn = await pool.takeConnection(key);
	const reused = conn !== undefined;
	if (conn === undefined) {
		conn = await SmtpConnection.connect(config);
	}
	try {
		const secured = conn.secured;
		await sendEnvelope(conn, { from: 'sender@owlat.test', to: envelope.to, data: envelope.body });
		pool.storeConnection(key, conn);
		pool.release(key);
		return { reused, secured };
	} catch (err) {
		// Mirror the real sender: a clean pre-DATA reply rejection leaves the socket
		// healthy → park it (the next job's RSET clears the aborted transaction); any
		// other fault (transport death, 421 channel close, DATA-phase ambiguity)
		// poisons the socket → evict the entry and release its slot.
		if (isHealthyPreDataRejection(err)) {
			pool.storeConnection(key, conn);
			pool.release(key);
		} else {
			pool.evictConnection(key, conn);
		}
		throw err;
	}
}

/** The sender's park-vs-evict predicate (mirrored so this suite exercises the real policy). */
function isHealthyPreDataRejection(err: unknown): boolean {
	return (
		isSmtpError(err) &&
		err.tlsCause === undefined &&
		err.replyCode !== undefined &&
		err.replyCode !== 421 &&
		(err.phase === 'mail' || err.phase === 'rcpt')
	);
}

async function reusedTotal(): Promise<number> {
	const metric = await smtpPoolReused.get();
	return metric.values[0]?.value ?? 0;
}

const body = (n: number): string => `Subject: msg ${n}\r\n\r\nbody ${n}\r\n`;

describe('SmtpConnectionPool — true socket reuse (X1)', () => {
	it('(a) N sequential sends reuse ONE connection across RSET; the cap-th QUITs and the next reconnects', async () => {
		const mx = await startFakeMx();
		const cap = 3;
		const pool = makePool(mx.port, { maxMessagesPerConnection: cap });

		const outcomes: boolean[] = [];
		for (let i = 1; i <= cap; i++) {
			outcomes.push(
				(await deliverOnce(pool, mx.port, { to: [`r${i}@rcpt.test`], body: body(i) })).reused
			);
		}

		// The first opened the socket; each subsequent send reused it via RSET.
		expect(outcomes).toEqual([false, true, true]);
		expect(mx.connections()).toBe(1); // ONE socket carried all `cap` messages
		expect(mx.messages()).toHaveLength(cap);

		// The (cap+1)-th message: the pool cleanly QUIT the capped socket, so this one
		// opens a FRESH connection rather than reusing.
		const next = await deliverOnce(pool, mx.port, { to: ['r4@rcpt.test'], body: body(4) });
		expect(next.reused).toBe(false);
		expect(mx.connections()).toBe(2); // exactly one reconnect
		expect(mx.messages()).toHaveLength(cap + 1);
		// The capped socket was retired with a graceful QUIT (observed on the wire), not
		// destroyed — connections()===2 alone would also hold for a destroyed socket.
		await waitUntil(() => mx.quits() >= 1);
		expect(mx.quits()).toBe(1);
		// No state leaked between transactions: every message carried its OWN recipient.
		expect(mx.messages().map((m) => m.to[0])).toEqual([
			'r1@rcpt.test',
			'r2@rcpt.test',
			'r3@rcpt.test',
			'r4@rcpt.test',
		]);
	});

	it('(b) a socket death mid-stream evicts the entry, releases the Redis slot, and the retry uses a fresh connection exactly once', async () => {
		const mx = await startRawMx((i) => (i === 1 ? { destroyMidData: true } : {}));
		const pool = makePool(mx.port);
		const redis = new Redis();
		pool.enableDistributedCoordination(redis as unknown as IORedis, 10, 'srv-reuse');

		// First delivery: the raw MX destroys the socket mid-DATA → sendEnvelope throws
		// → the pool evicts the entry and releases the slot.
		await expect(
			deliverOnce(pool, mx.port, { to: ['r1@rcpt.test'], body: body(1) })
		).rejects.toThrow();

		expect(pool.size).toBe(0); // entry evicted
		expect(await pool.getGlobalConnectionCount('127.0.0.1')).toBe(0); // slot released

		// Retry: a fresh acquire re-reserves the slot and opens a NEW connection, which
		// the raw MX now serves normally.
		const retry = await deliverOnce(pool, mx.port, { to: ['r1@rcpt.test'], body: body(1) });
		expect(retry.reused).toBe(false);
		expect(mx.connections()).toBe(2); // exactly one poisoned + one fresh
		expect(await pool.getGlobalConnectionCount('127.0.0.1')).toBe(1);
	});

	it('(c) secured is per-CONNECTION: every message on a reused TLS socket is attributed to the same TLS state', async () => {
		const mx = await startFakeMx({ starttls: true });
		const pool = makePool(mx.port);

		const results: Array<{ reused: boolean; secured: boolean }> = [];
		for (let i = 1; i <= 3; i++) {
			results.push(await deliverOnce(pool, mx.port, { to: [`r${i}@rcpt.test`], body: body(i) }));
		}

		// One STARTTLS-upgraded socket carried all three; each message reports the
		// connection's secured=true — the value the sender records into TLS-RPT.
		expect(mx.connections()).toBe(1);
		expect(results.map((r) => r.secured)).toEqual([true, true, true]);
		expect(results.map((r) => r.reused)).toEqual([false, true, true]);
		// The server observed every DATA over the SAME TLS session.
		expect(mx.messages().map((m) => m.secure)).toEqual([true, true, true]);
	});

	it('(d) reused_total rises exactly once per RSET reuse', async () => {
		const mx = await startFakeMx();
		const pool = makePool(mx.port);

		const before = await reusedTotal();
		// 3 sends to one key: send 1 opens, sends 2 and 3 reuse → +2.
		for (let i = 1; i <= 3; i++) {
			await deliverOnce(pool, mx.port, { to: [`r${i}@rcpt.test`], body: body(i) });
		}
		const after = await reusedTotal();

		expect(after - before).toBe(2);
	});

	it('(guardrail) an idle socket past maxAgeMs is retired with a clean QUIT and the next job reconnects', async () => {
		const mx = await startFakeMx();
		// A lifetime long enough to park the first socket, short enough to age it out
		// before the second delivery (which waits well past it).
		const pool = makePool(mx.port, { maxAgeMs: 120, maxMessagesPerConnection: 100 });

		const first = await deliverOnce(pool, mx.port, { to: ['r1@rcpt.test'], body: body(1) });
		expect(first.reused).toBe(false); // opened + parked

		// Let the parked socket age past maxAgeMs while idle.
		await new Promise((resolve) => setTimeout(resolve, 220));

		const second = await deliverOnce(pool, mx.port, { to: ['r2@rcpt.test'], body: body(2) });
		// takeConnection saw the aged socket, QUIT it cleanly, and the caller reconnected.
		expect(second.reused).toBe(false);
		expect(mx.connections()).toBe(2);
		await waitUntil(() => mx.quits() >= 1);
		expect(mx.quits()).toBe(1);
	});

	it('(guardrail) a parked socket the MX closed while idle fails its RSET probe → the caller connects fresh', async () => {
		// Connection 1 serves one delivery, then (40 ms after the final 250) the MX
		// destroys the now-idle parked socket. The next takeConnection finds a dead
		// socket, its RSET probe throws, and the pool discards it and returns undefined.
		const mx = await startRawMx((i) => (i === 1 ? { destroyWhenIdleMs: 40 } : {}));
		const pool = makePool(mx.port);

		const first = await deliverOnce(pool, mx.port, { to: ['r1@rcpt.test'], body: body(1) });
		expect(first.reused).toBe(false); // opened + parked

		// Wait for the MX to kill the parked socket (the client observes the close,
		// flipping the reader to failed) before the next delivery probes it.
		await new Promise((resolve) => setTimeout(resolve, 120));

		const second = await deliverOnce(pool, mx.port, { to: ['r2@rcpt.test'], body: body(2) });
		expect(second.reused).toBe(false); // RSET probe failed → fresh connect
		expect(mx.connections()).toBe(2);
	});

	it('(guardrail, b/421) a 421 mid-session evicts the entry, releases the slot, and the retry uses a fresh connection', async () => {
		// Connection 1 answers MAIL FROM with 421 (service closing) then drops the
		// socket — a channel close, NOT a reusable bounce. The pool must evict and
		// release the slot; connection 2 (the retry) is served normally.
		const mx = await startRawMx((i) =>
			i === 1 ? { mailReply: '421 4.7.0 service closing\r\n', destroyOnMail: true } : {}
		);
		const pool = makePool(mx.port);
		const redis = new Redis();
		pool.enableDistributedCoordination(redis as unknown as IORedis, 10, 'srv-421');

		await expect(
			deliverOnce(pool, mx.port, { to: ['r1@rcpt.test'], body: body(1) })
		).rejects.toThrow();

		expect(pool.size).toBe(0); // 421 is not a healthy pre-DATA bounce → entry evicted
		expect(await pool.getGlobalConnectionCount('127.0.0.1')).toBe(0); // slot released

		const retry = await deliverOnce(pool, mx.port, { to: ['r1@rcpt.test'], body: body(1) });
		expect(retry.reused).toBe(false);
		expect(mx.connections()).toBe(2); // one 421'd + one fresh
		expect(await pool.getGlobalConnectionCount('127.0.0.1')).toBe(1);
	});
});
