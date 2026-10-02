import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync }));

// The gate memoizes its probe per module instance, so each test imports a
// fresh copy.
async function loadGate() {
	vi.resetModules();
	return await import('./helpers/redisCluster.js');
}

describe('dockerRedisAvailable', () => {
	beforeEach(() => {
		execFileSync.mockReset();
		vi.stubEnv('OWLAT_REQUIRE_DOCKER', undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('is true when the daemon answers for the redis:7-alpine image', async () => {
		const { dockerRedisAvailable } = await loadGate();
		expect(dockerRedisAvailable()).toBe(true);
		expect(execFileSync).toHaveBeenCalledWith(
			'docker',
			['image', 'inspect', 'redis:7-alpine'],
			expect.objectContaining({ timeout: 30_000 })
		);
	});

	it('skips (false) when Docker is unavailable and the flag is unset', async () => {
		execFileSync.mockImplementation(() => {
			throw new Error('Cannot connect to the Docker daemon');
		});
		const { dockerRedisAvailable } = await loadGate();
		expect(dockerRedisAvailable()).toBe(false);
	});

	it('throws instead of skipping when the flag is set and Docker is unavailable', async () => {
		execFileSync.mockImplementation(() => {
			throw new Error('Cannot connect to the Docker daemon');
		});
		const { dockerRedisAvailable, REQUIRE_DOCKER_ENV } = await loadGate();
		vi.stubEnv(REQUIRE_DOCKER_ENV, '1');
		expect(() => dockerRedisAvailable()).toThrow(/OWLAT_REQUIRE_DOCKER=1 .*redis:7-alpine/);
	});

	it('probes Docker once per module, however many suites ask', async () => {
		const { dockerRedisAvailable } = await loadGate();
		dockerRedisAvailable();
		dockerRedisAvailable();
		expect(execFileSync).toHaveBeenCalledTimes(1);
	});
});
