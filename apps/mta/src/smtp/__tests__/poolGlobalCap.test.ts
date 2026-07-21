import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { PoolGlobalCap } from '../poolGlobalCap.js';

type ScriptOperation = 'reserve' | 'release' | 'count';
type FailurePoint = 'before' | 'after';

function makeRedisLeaseEmulator() {
	const leasesByKey = new Map<string, Map<string, number>>();
	const failures = new Map<ScriptOperation, FailurePoint>();

	const evalScript = vi.fn(
		async (script: string, _keyCount: number, key: string, ...args: string[]) => {
			const operation: ScriptOperation = script.includes('local maximum')
				? 'reserve'
				: script.includes('local removed')
					? 'release'
					: 'count';
			const failure = failures.get(operation);
			failures.delete(operation);
			if (failure === 'before') throw new Error(`${operation} failed before commit`);

			const leases = leasesByKey.get(key) ?? new Map<string, number>();
			leasesByKey.set(key, leases);
			let result: number;

			if (operation === 'reserve') {
				const [nowRaw, expiresAtRaw, maximumRaw, leaseId] = args;
				const now = Number(nowRaw);
				for (const [id, expiresAt] of leases) {
					if (expiresAt <= now) leases.delete(id);
				}
				if (leases.size >= Number(maximumRaw)) {
					result = 0;
				} else {
					leases.set(leaseId!, Number(expiresAtRaw));
					result = 1;
				}
			} else if (operation === 'release') {
				result = leases.delete(args[0]!) ? 1 : 0;
			} else {
				const now = Number(args[0]);
				for (const [id, expiresAt] of leases) {
					if (expiresAt <= now) leases.delete(id);
				}
				result = leases.size;
			}

			if (failure === 'after') throw new Error(`${operation} response was lost after commit`);
			return result;
		}
	);

	return {
		redis: { eval: evalScript } as unknown as Redis,
		failNext(operation: ScriptOperation, point: FailurePoint) {
			failures.set(operation, point);
		},
	};
}

describe('PoolGlobalCap leases', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-21T12:00:00Z'));
	});

	afterEach(() => vi.useRealTimers());

	it('recovers a slot after an owning process crashes and its lease expires', async () => {
		const emulator = makeRedisLeaseEmulator();
		const crashedProcess = new PoolGlobalCap();
		const replacementProcess = new PoolGlobalCap();
		crashedProcess.enable(emulator.redis, 1, 'crashed');
		replacementProcess.enable(emulator.redis, 1, 'replacement');

		expect(await crashedProcess.tryReserve('provider:gmail', 10)).not.toBeNull();
		expect(await replacementProcess.tryReserve('provider:gmail', 10)).toBeNull();
		vi.advanceTimersByTime(10_001);
		expect(await replacementProcess.tryReserve('provider:gmail', 10)).not.toBeNull();
	});

	it('does not extend a live lease when repeated reservations are rejected', async () => {
		const emulator = makeRedisLeaseEmulator();
		const cap = new PoolGlobalCap();
		cap.enable(emulator.redis, 1, 'srv');

		expect(await cap.tryReserve('mx:example', 10)).not.toBeNull();
		for (let attempt = 0; attempt < 3; attempt++) {
			vi.advanceTimersByTime(3_000);
			expect(await cap.tryReserve('mx:example', 10)).toBeNull();
		}
		vi.advanceTimersByTime(1_001);
		expect(await cap.tryReserve('mx:example', 10)).not.toBeNull();
	});

	it('fails closed if reservation fails before commit', async () => {
		const emulator = makeRedisLeaseEmulator();
		const cap = new PoolGlobalCap();
		cap.enable(emulator.redis, 1, 'srv');
		emulator.failNext('reserve', 'before');

		expect(await cap.tryReserve('mx:example', 10)).toBeNull();
		expect(await cap.getCount('mx:example')).toBe(0);
	});

	it('fails closed and lets a ghost lease expire when the reserve response is lost', async () => {
		const emulator = makeRedisLeaseEmulator();
		const cap = new PoolGlobalCap();
		cap.enable(emulator.redis, 1, 'srv');
		emulator.failNext('reserve', 'after');

		expect(await cap.tryReserve('mx:example', 10)).toBeNull();
		expect(await cap.getCount('mx:example')).toBe(1);
		vi.advanceTimersByTime(10_001);
		expect(await cap.getCount('mx:example')).toBe(0);
	});

	it('keeps a lease until expiry when release fails before commit', async () => {
		const emulator = makeRedisLeaseEmulator();
		const cap = new PoolGlobalCap();
		cap.enable(emulator.redis, 1, 'srv');
		const lease = await cap.tryReserve('mx:example', 10);
		expect(lease).not.toBeNull();
		emulator.failNext('release', 'before');

		cap.release(lease!);
		await Promise.resolve();
		expect(await cap.getCount('mx:example')).toBe(1);
		vi.advanceTimersByTime(10_001);
		expect(await cap.getCount('mx:example')).toBe(0);
	});

	it('makes release idempotent when the response is lost after commit', async () => {
		const emulator = makeRedisLeaseEmulator();
		const cap = new PoolGlobalCap();
		cap.enable(emulator.redis, 1, 'srv');
		const lease = await cap.tryReserve('mx:example', 10);
		expect(lease).not.toBeNull();
		emulator.failNext('release', 'after');

		cap.release(lease!);
		await Promise.resolve();
		expect(await cap.getCount('mx:example')).toBe(0);
		cap.release(lease!);
		await Promise.resolve();
		expect(await cap.getCount('mx:example')).toBe(0);
	});
});
