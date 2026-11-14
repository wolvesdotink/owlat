/**
 * The hosts this MTA answers `bounce+…@` and `fbl+…@` for.
 *
 * Those local parts carry a signed token that is verified after DATA, so a
 * forged one is discarded either way. Accepting them at RCPT for any host,
 * though, makes the port-25 listener look like an open relay to anyone who
 * probes it with a foreign domain. The hosts are the return-path domain, every
 * EHLO name (the system-mailbox hosts) and every per-domain return-path host a
 * sending domain registered through `/dkim` (smtp/dkimStore.ts).
 *
 * Registered hosts live in Redis and can be added by another MTA instance, so
 * the set is cached briefly and re-read on a miss, at most once per
 * `MISS_REFRESH_MS`: a host registered a moment ago is accepted, and a flood of
 * foreign RCPTs costs one SCAN per interval, not one per command.
 */

import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { systemMailboxHosts } from '../inbound/systemMailboxes.js';
import { listReturnPathHosts } from '../smtp/dkimStore.js';

const CACHE_TTL_MS = 60_000;
const MISS_REFRESH_MS = 5_000;

interface HostCache {
	hosts: ReadonlySet<string>;
	loadedAt: number;
	loading?: Promise<ReadonlySet<string>>;
}

const caches = new WeakMap<Redis, HostCache>();

async function registeredHosts(
	redis: Redis,
	refreshIfOlderThan: number
): Promise<ReadonlySet<string>> {
	const cache = caches.get(redis);
	const now = Date.now();
	if (cache && now - cache.loadedAt < refreshIfOlderThan) return cache.hosts;
	if (cache?.loading) return cache.loading;
	const loading = listReturnPathHosts(redis).then((hosts) => new Set(hosts));
	caches.set(redis, { hosts: cache?.hosts ?? new Set(), loadedAt: cache?.loadedAt ?? 0, loading });
	try {
		const hosts = await loading;
		caches.set(redis, { hosts, loadedAt: Date.now() });
		return hosts;
	} catch (err) {
		if (cache) caches.set(redis, cache);
		else caches.delete(redis);
		throw err;
	}
}

/** Whether `host` is one this MTA receives bounces and complaint reports for. */
export async function isFeedbackHost(
	redis: Redis,
	config: Pick<MtaConfig, 'returnPathDomain' | 'ehloHostname' | 'ehloHostnames'>,
	host: string
): Promise<boolean> {
	const normalized = host.toLowerCase().replace(/\.$/, '');
	if (normalized === '') return false;
	if (systemMailboxHosts(config).includes(normalized)) return true;
	if ((await registeredHosts(redis, CACHE_TTL_MS)).has(normalized)) return true;
	return (await registeredHosts(redis, MISS_REFRESH_MS)).has(normalized);
}
