import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
	const client = new Redis(port, '127.0.0.1', { lazyConnect: true, maxRetriesPerRequest: 3 });
	for (let attempt = 0; ; attempt += 1) {
		try {
			await client.connect();
			break;
		} catch (error) {
			if (attempt >= 50) throw error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
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
