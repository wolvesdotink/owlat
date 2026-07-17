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
import { SmtpConnection, sendEnvelope } from '@owlat/smtp-client';
import {
	SmtpConnectionPool,
	smtpPoolReused,
	type AcquireOptions,
	type PoolConfig,
} from '../connectionPool.js';
import { MX_CERT, MX_KEY } from './certFixture.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const fn of cleanups.splice(0)) {
		await fn();
	}
});

interface FakeMx {
	port: number;
	connections(): number;
	messages(): Array<{ to: string[]; body: string; secure: boolean }>;
}

/** A loopback fake MX. `starttls: true` advertises + accepts STARTTLS (self-signed). */
async function startFakeMx(opts: { starttls?: boolean } = {}): Promise<FakeMx> {
	let connections = 0;
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
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
	const port = (server.server.address() as AddressInfo).port;
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return { port, connections: () => connections, messages: () => messages };
}

/**
 * A raw loopback SMTP peer that DESTROYS the socket mid-DATA on its first
 * connection and behaves normally on every later connection. Reproduces a socket
 * death mid-stream without smtp-server's graceful handling.
 */
async function startFlakyRawMx(): Promise<{ port: number; connections(): number }> {
	let connIndex = 0;
	const server = net.createServer((socket) => {
		connIndex += 1;
		const dropThisConnection = connIndex === 1;
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
					if (dropThisConnection) {
						socket.destroy(); // die AFTER the body, before the final reply
					} else {
						socket.write('250 2.0.0 queued\r\n');
					}
				}
				return;
			}
			let nl = buffer.indexOf('\n');
			while (nl !== -1) {
				const line = buffer.slice(0, nl).replace(/\r$/, '');
				buffer = buffer.slice(nl + 1);
				if (/^EHLO/i.test(line)) socket.write('250 raw.test\r\n');
				else if (/^DATA$/i.test(line)) {
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
		pool.evictConnection(key, conn);
		throw err;
	}
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
		// No state leaked between transactions: every message carried its OWN recipient.
		expect(mx.messages().map((m) => m.to[0])).toEqual([
			'r1@rcpt.test',
			'r2@rcpt.test',
			'r3@rcpt.test',
			'r4@rcpt.test',
		]);
	});

	it('(b) a socket death mid-stream evicts the entry, releases the Redis slot, and the retry uses a fresh connection exactly once', async () => {
		const mx = await startFlakyRawMx();
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
});
