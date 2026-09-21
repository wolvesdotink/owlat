/**
 * Redis memory-bound guard.
 *
 * Redis shipped unbounded — no `--maxmemory`, no eviction policy, no container
 * limit — so a leak in the keyspace was a whole-HOST outage rather than a Redis
 * one. A defer-handoff leak grew it to 3.9 GB on a 7.5 GB box and the kernel
 * oom-killer took redis-server down twice in eight minutes, stopping the MTA
 * rate limiter and the IMAP auth limiter with it.
 *
 * Both ceilings are pinned here, off the real compose files, for every template
 * an install can be deployed from. The eviction policy is pinned too and must
 * stay `noeviction`: this instance mixes disposable rate-limiter counters with
 * durability records the MTA cannot lose, and every one of those records
 * carries a TTL, so no `volatile-*` policy can distinguish them and
 * `allkeys-lru` cannot either. Evicting one silently sends an email twice.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const COMPOSE_FILES = ['docker-compose.yml', 'infra/templates/docker-compose.vps.yml'];

/** The `redis:` service block, up to the next service at the same indent. */
function redisService(compose: string): string {
	const lines = compose.split('\n');
	const start = lines.findIndex((line) => /^ {2}redis:\s*$/.test(line));
	expect(start, 'no `redis:` service found').toBeGreaterThan(-1);
	const end = lines.findIndex((line, i) => i > start && /^ {2}\S/.test(line));
	return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

describe.each(COMPOSE_FILES)('%s bounds Redis memory', (file) => {
	const service = redisService(readFileSync(join(REPOSITORY_ROOT, file), 'utf8'));

	it('caps the dataset with a configurable --maxmemory', () => {
		expect(service).toMatch(/--maxmemory \$\{REDIS_MAXMEMORY:-\S+\}/);
	});

	it('refuses writes rather than evicting a durability record', () => {
		expect(service).toContain('--maxmemory-policy noeviction');
	});

	it('caps the container so an overshoot cannot reach the host', () => {
		expect(service).toMatch(/^ {4}mem_limit: \$\{REDIS_MEM_LIMIT:-\S+\}$/m);
	});
});
