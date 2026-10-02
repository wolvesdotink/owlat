import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import Redis from 'ioredis';

export interface RedisStandaloneFixture {
	client: Redis;
	container: string;
}

/**
 * A throwaway single-node redis:7-alpine container on a loopback port, for the
 * suites that need real Redis semantics (Lua scripts, TTLs) without a cluster.
 * Gate the suite with `describe.runIf(dockerRedisAvailable())`.
 */
export async function startRedisStandaloneFixture(prefix: string): Promise<RedisStandaloneFixture> {
	const container = `owlat-${prefix}-standalone-${randomUUID().slice(0, 8)}`;
	const port = 18_000 + Math.floor(Math.random() * 2_000);
	execFileSync(
		'docker',
		['run', '-d', '--rm', '--name', container, '-p', `127.0.0.1:${port}:6379`, 'redis:7-alpine'],
		{ stdio: 'ignore' }
	);
	await waitForRedis(port);
	const client = new Redis(port, '127.0.0.1', { lazyConnect: true, maxRetriesPerRequest: 3 });
	await client.connect();
	await client.ping();
	await client.flushall();
	return { client, container };
}

export async function stopRedisStandaloneFixture(
	fixture: RedisStandaloneFixture | undefined
): Promise<void> {
	if (!fixture) return;
	await fixture.client.quit();
	try {
		execFileSync('docker', ['rm', '-f', fixture.container], { stdio: 'ignore' });
	} catch {
		// Container may already have exited; --rm handled it.
	}
}

/**
 * Wait until the container answers PING over a bare TCP socket.
 *
 * Not by retrying `connect()` on an ioredis client. Before Redis listens,
 * Docker's port proxy accepts a connection and then drops it. After that,
 * ioredis keeps reconnecting in the background, a second `connect()` throws
 * "Redis is already connecting/connected", and the first never settles. A
 * fresh client per attempt hangs the same way. That was a timing-dependent
 * CI failure, which started the moment these suites ran on real Redis. A raw
 * socket with its own timeout has no reconnect state to trip over.
 */
async function waitForRedis(port: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await answersPing(port)) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Redis on 127.0.0.1:${port} never answered PING`);
}

function answersPing(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1');
		let reply = '';
		const finish = (ok: boolean) => {
			clearTimeout(timer);
			socket.destroy();
			resolve(ok);
		};
		const timer = setTimeout(() => finish(false), 500);
		socket.on('connect', () => socket.write('PING\r\n'));
		socket.on('data', (chunk) => {
			reply += chunk.toString();
			if (reply.includes('\r\n')) finish(reply.startsWith('+PONG'));
		});
		socket.on('error', () => finish(false));
		socket.on('close', () => finish(false));
	});
}
