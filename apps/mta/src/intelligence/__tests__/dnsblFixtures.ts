import type Redis from 'ioredis';
import type { MtaConfig } from '../../config.js';
import { initializePools } from '../../scaling/ipPool.js';

/** Deterministic lookup deps: no wall clock, no real timers, recorded delays. */
export function createRecordingLookupDeps(nowValues?: number[]) {
	const delays: number[] = [];
	let index = 0;
	return {
		delays,
		deps: {
			sleep: async (ms: number) => {
				delays.push(ms);
			},
			now: () => {
				if (!nowValues || nowValues.length === 0) return 0;
				const value = nowValues[Math.min(index, nowValues.length - 1)] ?? 0;
				index += 1;
				return value;
			},
		},
	};
}

export function dnsError(code: string): Error {
	return Object.assign(new Error(code), { code });
}

/** Mark every pooled address FCrDNS-clean and load the pools, so a sweep starts from a fully active rotation. */
export async function seedActivePools(redis: Redis, ipPools: MtaConfig['ipPools']): Promise<void> {
	for (const ip of [...ipPools.transactional, ...ipPools.campaign]) {
		await redis.hset(`mta:fcrdns:${ip}`, 'verdict', 'pass', 'checkedAt', '1');
	}
	await initializePools(redis, ipPools);
}
