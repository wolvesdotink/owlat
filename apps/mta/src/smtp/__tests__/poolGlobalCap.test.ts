import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { assertLeaseProtocolCutoverSafe, PoolGlobalCap } from '../poolGlobalCap.js';

type ScriptOperation = 'reserve' | 'renew' | 'release' | 'count';
type FailurePoint = 'before' | 'after';

function makeRedisCoordinationEmulator(initialServerTimeMs = 1_000_000) {
	const leasesByKey = new Map<string, Map<string, number>>();
	const scalars = new Map<string, number>();
	const failures = new Map<ScriptOperation, FailurePoint>();
	let serverTimeMs = initialServerTimeMs;

	const operationFor = (script: string): ScriptOperation => {
		if (script.includes('local existingExpiry')) return 'renew';
		if (script.includes('local removed') || script.includes('local instanceCount'))
			return 'release';
		if (script.includes('local maximum') || script.includes("redis.call('INCR', globalKey)")) {
			return 'reserve';
		}
		return 'count';
	};

	const evalScript = vi.fn(async (script: string, keyCount: number, ...keysAndArgs: string[]) => {
		const keys = keysAndArgs.slice(0, keyCount);
		const args = keysAndArgs.slice(keyCount);
		const operation = operationFor(script);
		const failure = failures.get(operation);
		failures.delete(operation);
		if (failure === 'before') throw new Error(`${operation} failed before commit`);

		let result: number;
		if (script.includes("redis.call('INCR', globalKey)")) {
			const [globalKey, instanceKey] = keys as [string, string];
			const maximum = Number(args[1]);
			const nextGlobal = (scalars.get(globalKey) ?? 0) + 1;
			if (nextGlobal > maximum) {
				result = 0;
			} else {
				scalars.set(globalKey, nextGlobal);
				scalars.set(instanceKey, (scalars.get(instanceKey) ?? 0) + 1);
				result = 1;
			}
		} else if (script.includes('local instanceCount')) {
			const [globalKey, instanceKey] = keys as [string, string];
			const instanceCount = scalars.get(instanceKey) ?? 0;
			if (instanceCount <= 0) {
				result = 0;
			} else {
				const nextInstance = instanceCount - 1;
				if (nextInstance === 0) scalars.delete(instanceKey);
				else scalars.set(instanceKey, nextInstance);
				const nextGlobal = Math.max(0, (scalars.get(globalKey) ?? 0) - 1);
				if (nextGlobal === 0) scalars.delete(globalKey);
				else scalars.set(globalKey, nextGlobal);
				result = 1;
			}
		} else {
			const key = keys[0]!;
			const leases = leasesByKey.get(key) ?? new Map<string, number>();
			leasesByKey.set(key, leases);
			if (operation === 'reserve') {
				for (const [id, expiresAt] of leases) {
					if (expiresAt <= serverTimeMs) leases.delete(id);
				}
				if (leases.size >= Number(args[1])) {
					result = 0;
				} else {
					leases.set(args[2]!, serverTimeMs + Number(args[0]));
					result = 1;
				}
			} else if (operation === 'renew') {
				const expiry = leases.get(args[1]!);
				if (expiry === undefined || expiry <= serverTimeMs) {
					leases.delete(args[1]!);
					result = 0;
				} else {
					leases.set(args[1]!, serverTimeMs + Number(args[0]));
					result = 1;
				}
			} else if (operation === 'release') {
				result = leases.delete(args[0]!) ? 1 : 0;
			} else {
				for (const [id, expiresAt] of leases) {
					if (expiresAt <= serverTimeMs) leases.delete(id);
				}
				result = leases.size;
			}
		}

		if (failure === 'after') throw new Error(`${operation} response was lost after commit`);
		return result;
	});

	return {
		redis: {
			eval: evalScript,
			get: vi.fn(async (key: string) => (scalars.has(key) ? String(scalars.get(key)) : null)),
		} as unknown as Redis,
		advanceServerTime(ms: number) {
			serverTimeMs += ms;
		},
		failNext(operation: ScriptOperation, point: FailurePoint) {
			failures.set(operation, point);
		},
		async oldReserve(scope: string, maximum: number): Promise<boolean> {
			const key = `mta:pool:global:${scope}`;
			const next = (scalars.get(key) ?? 0) + 1;
			if (next > maximum) return false;
			scalars.set(key, next);
			return true;
		},
		oldRelease(scope: string) {
			const key = `mta:pool:global:${scope}`;
			const next = Math.max(0, (scalars.get(key) ?? 0) - 1);
			if (next === 0) scalars.delete(key);
			else scalars.set(key, next);
		},
	};
}

describe('PoolGlobalCap leases-v1', () => {
	it('renews ownership past the original TTL using Redis server time', async () => {
		const emulator = makeRedisCoordinationEmulator();
		const cap = new PoolGlobalCap();
		cap.enable(emulator.redis, 1, 'srv', 'leases-v1');
		const lease = await cap.tryReserve('provider:gmail', 10);
		expect(lease).not.toBeNull();

		emulator.advanceServerTime(9_000);
		expect(await cap.renew(lease!, 10)).toBe(true);
		emulator.advanceServerTime(2_000);
		expect(await cap.getCount('provider:gmail')).toBe(1);
		emulator.advanceServerTime(8_001);
		expect(await cap.getCount('provider:gmail')).toBe(0);
	});

	it('ignores arbitrarily skewed process clocks for reserve, renew, and pruning', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
			const emulator = makeRedisCoordinationEmulator(10_000);
			const cap = new PoolGlobalCap();
			cap.enable(emulator.redis, 1, 'srv', 'leases-v1');
			const lease = await cap.tryReserve('mx:example', 10);
			vi.setSystemTime(new Date('1970-01-01T00:00:00Z'));
			emulator.advanceServerTime(9_000);
			expect(await cap.renew(lease!, 10)).toBe(true);
			emulator.advanceServerTime(9_000);
			expect(await cap.getCount('mx:example')).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects renewal after ownership has expired', async () => {
		const emulator = makeRedisCoordinationEmulator();
		const cap = new PoolGlobalCap();
		cap.enable(emulator.redis, 1, 'srv', 'leases-v1');
		const lease = await cap.tryReserve('mx:example', 10);
		emulator.advanceServerTime(10_001);
		expect(await cap.renew(lease!, 10)).toBe(false);
	});

	it.each(['before', 'after'] as const)(
		'fails closed when renewal fails %s commit',
		async (point) => {
			const emulator = makeRedisCoordinationEmulator();
			const cap = new PoolGlobalCap();
			cap.enable(emulator.redis, 1, 'srv', 'leases-v1');
			const lease = await cap.tryReserve('mx:example', 10);
			emulator.failNext('renew', point);
			expect(await cap.renew(lease!, 10)).toBe(false);
		}
	);

	it('recovers a slot after an owning process crashes and rejected attempts do not renew it', async () => {
		const emulator = makeRedisCoordinationEmulator();
		const crashed = new PoolGlobalCap();
		const replacement = new PoolGlobalCap();
		crashed.enable(emulator.redis, 1, 'crashed', 'leases-v1');
		replacement.enable(emulator.redis, 1, 'replacement', 'leases-v1');

		expect(await crashed.tryReserve('provider:gmail', 10)).not.toBeNull();
		for (let attempt = 0; attempt < 3; attempt++) {
			emulator.advanceServerTime(3_000);
			expect(await replacement.tryReserve('provider:gmail', 10)).toBeNull();
		}
		emulator.advanceServerTime(1_001);
		expect(await replacement.tryReserve('provider:gmail', 10)).not.toBeNull();
	});

	it('fails closed for reservation failures before and after commit', async () => {
		const emulator = makeRedisCoordinationEmulator();
		const cap = new PoolGlobalCap();
		cap.enable(emulator.redis, 1, 'srv', 'leases-v1');
		emulator.failNext('reserve', 'before');
		expect(await cap.tryReserve('mx:before', 10)).toBeNull();
		expect(await cap.getCount('mx:before')).toBe(0);
		emulator.failNext('reserve', 'after');
		expect(await cap.tryReserve('mx:after', 10)).toBeNull();
		expect(await cap.getCount('mx:after')).toBe(1);
		emulator.advanceServerTime(10_001);
		expect(await cap.getCount('mx:after')).toBe(0);
	});

	it('keeps release ownership-safe across failures and duplicate calls', async () => {
		const emulator = makeRedisCoordinationEmulator();
		const cap = new PoolGlobalCap();
		cap.enable(emulator.redis, 2, 'srv', 'leases-v1');
		const first = await cap.tryReserve('mx:example', 10);
		const second = await cap.tryReserve('mx:example', 10);
		emulator.failNext('release', 'after');
		cap.release(first!);
		await Promise.resolve();
		cap.release(first!);
		expect(await cap.getCount('mx:example')).toBe(1);
		expect(await cap.renew(second!, 10)).toBe(true);
	});
});

describe('PoolGlobalCap rolling-upgrade gate', () => {
	it('shares the legacy scalar cap with a main-version process', async () => {
		const emulator = makeRedisCoordinationEmulator();
		const upgraded = new PoolGlobalCap();
		upgraded.enable(emulator.redis, 1, 'new-node', 'legacy-v0');

		expect(await emulator.oldReserve('mx.example', 1)).toBe(true);
		expect(await upgraded.tryReserve('mx.example', 10)).toBeNull();
		expect(await upgraded.getCount('mx.example')).toBe(1);
		emulator.oldRelease('mx.example');
		expect(await upgraded.tryReserve('mx.example', 10)).not.toBeNull();
		expect(await emulator.oldReserve('mx.example', 1)).toBe(false);
	});

	it('refuses a leases-v1 cutover while a legacy global counter remains', async () => {
		const redis = {
			scan: vi.fn().mockResolvedValue(['0', ['mta:pool:global:mx.example']]),
		} as unknown as Redis;
		await expect(assertLeaseProtocolCutoverSafe(redis)).rejects.toThrow('legacy pool counters');
	});

	it('allows a leases-v1 cutover only after the legacy keyspace is empty', async () => {
		const redis = { scan: vi.fn().mockResolvedValue(['0', []]) } as unknown as Redis;
		await expect(assertLeaseProtocolCutoverSafe(redis)).resolves.toBeUndefined();
	});
});
