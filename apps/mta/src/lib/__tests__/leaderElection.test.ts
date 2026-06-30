import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// We need to re-import the module for each test to reset module-level state
let startLeaderElection: typeof import('../leaderElection.js').startLeaderElection;
let isLeader: typeof import('../leaderElection.js').isLeader;
let stopLeaderElection: typeof import('../leaderElection.js').stopLeaderElection;

describe('leaderElection', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		redis = new Redis();

		// Reset module state by re-importing
		vi.resetModules();
		const mod = await import('../leaderElection.js');
		startLeaderElection = mod.startLeaderElection;
		isLeader = mod.isLeader;
		stopLeaderElection = mod.stopLeaderElection;
	});

	afterEach(async () => {
		// Ensure we stop the election to clear any setInterval timers
		try {
			await stopLeaderElection(redis, 'server-1');
		} catch {
			// ignore
		}
	});

	// Helper to flush async microtasks
	async function flushMicrotasks() {
		for (let i = 0; i < 20; i++) {
			await new Promise<void>((r) => setImmediate(r));
		}
	}

	it('isLeader returns false initially', () => {
		expect(isLeader()).toBe(false);
	});

	it('startLeaderElection acquires leadership (check Redis key)', async () => {
		startLeaderElection(redis, 'server-1');
		await flushMicrotasks();

		const leaderValue = await redis.get('mta:leader');
		expect(leaderValue).toBe('server-1');
	});

	it('after acquisition, isLeader returns true', async () => {
		startLeaderElection(redis, 'server-1');
		await flushMicrotasks();

		expect(isLeader()).toBe(true);
	});

	it('stopLeaderElection releases leadership and clears timer', async () => {
		startLeaderElection(redis, 'server-1');
		await flushMicrotasks();
		expect(isLeader()).toBe(true);

		await stopLeaderElection(redis, 'server-1');

		const leaderValue = await redis.get('mta:leader');
		expect(leaderValue).toBeNull();
	});

	it('after stop, isLeader returns false', async () => {
		startLeaderElection(redis, 'server-1');
		await flushMicrotasks();

		await stopLeaderElection(redis, 'server-1');
		expect(isLeader()).toBe(false);
	});
});
