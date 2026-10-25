import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { containerLogLine } from './containerLogs.js';

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
	let client: Redis | undefined;
	try {
		// Connect only once Redis says it is listening. Before that, Docker's port
		// proxy accepts a connection and then drops it, and ioredis keeps
		// reconnecting in the background: a second `connect()` throws "Redis is
		// already connecting/connected" and the first never settles.
		await containerLogLine(container, /Ready to accept connections/);
		client = new Redis(port, '127.0.0.1', { lazyConnect: true, maxRetriesPerRequest: 3 });
		await client.connect();
		await client.ping();
		await client.flushall();
		return { client, container };
	} catch (error) {
		client?.disconnect();
		removeContainer(container);
		throw error;
	}
}

function removeContainer(container: string): void {
	try {
		execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
	} catch {
		// Container may already have exited; --rm handled it.
	}
}

export async function stopRedisStandaloneFixture(
	fixture: RedisStandaloneFixture | undefined
): Promise<void> {
	if (!fixture) return;
	await fixture.client.quit();
	removeContainer(fixture.container);
}
