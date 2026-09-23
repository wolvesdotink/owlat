import { describe, it, expect, vi } from 'vitest';
import type { ComposeService } from '@owlat/shared/containerHealth';
import { waitForReadiness, type ReadinessProbe, type ReadinessTiming } from '../readiness.js';

/**
 * The readiness contract a rollout must meet before the updater calls it a
 * success. Driven with a virtual clock and a scripted container list, so each
 * case is a sequence of `docker compose ps` answers over time.
 */

type Row = Partial<ComposeService> & { service: string };

function row(r: Row): ComposeService {
	return { state: 'running', status: '', image: '', imageTag: '', health: '', ...r };
}

const HEALTHY: Row[] = [
	{ service: 'web' },
	{ service: 'convex', health: 'healthy' },
	{ service: 'mta' },
];
const SERVICES = ['web', 'convex', 'mta'];

/** A clock that only moves when the code under test sleeps. */
function virtualClock(overrides: Partial<ReadinessTiming> = {}) {
	let now = 0;
	const sleeps: number[] = [];
	const timing: ReadinessTiming = {
		timeoutMs: 60_000,
		firstPollMs: 1_000,
		maxPollMs: 8_000,
		settleMs: 3_000,
		now: () => now,
		sleep: async (ms) => {
			sleeps.push(ms);
			now += ms;
		},
		...overrides,
	};
	return { timing, sleeps, elapsed: () => now };
}

/**
 * Answers `ps` from `script` in order, repeating the last entry once it runs
 * out. `null` is a container list Docker would not give.
 */
function scriptedProbe(
	script: Array<Row[] | null>,
	smoke: () => Promise<{ ok: boolean; detail: string } | null> = async () => ({
		ok: true,
		detail: 'web answered HTTP 200',
	})
) {
	let call = 0;
	const probe: ReadinessProbe = {
		list: vi.fn(() => {
			const rows = script[Math.min(call++, script.length - 1)] ?? null;
			return rows === null ? null : rows.map(row);
		}),
		smoke: vi.fn(smoke),
	};
	return probe;
}

describe('waitForReadiness', () => {
	it('is ready once every service is up on two polls one settle interval apart', async () => {
		const clock = virtualClock();
		const probe = scriptedProbe([HEALTHY]);

		const result = await waitForReadiness(SERVICES, probe, clock.timing);

		expect(result.ready).toBe(true);
		expect(result.summary).toContain('convex: healthy');
		expect(result.summary).toContain('web answered HTTP 200');
		expect(probe.list).toHaveBeenCalledTimes(2);
		expect(clock.sleeps).toEqual([3_000]);
		expect(probe.smoke).toHaveBeenCalledOnce();
	});

	it('never calls a running service that fails its healthcheck ready', async () => {
		const clock = virtualClock();
		const probe = scriptedProbe([
			[{ service: 'web' }, { service: 'convex', health: 'unhealthy' }, { service: 'mta' }],
		]);

		const result = await waitForReadiness(SERVICES, probe, clock.timing);

		expect(result.ready).toBe(false);
		expect(result.summary).toContain('not healthy: convex (failing its healthcheck)');
		expect(probe.smoke).not.toHaveBeenCalled();
		// Bounded: gave up at the deadline, not before and not long after.
		expect(clock.elapsed()).toBeLessThanOrEqual(60_000);
		expect(clock.elapsed()).toBeGreaterThan(50_000);
	});

	it('waits out a healthcheck that passes late, backing off between polls', async () => {
		const clock = virtualClock();
		const starting: Row[] = [
			{ service: 'web' },
			{ service: 'convex', health: 'starting' },
			{ service: 'mta' },
		];
		const probe = scriptedProbe([starting, starting, starting, starting, HEALTHY]);

		const result = await waitForReadiness(SERVICES, probe, clock.timing);

		expect(result.ready).toBe(true);
		expect(clock.sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 3_000]);
	});

	it('reports a service still starting at the deadline as starting, not as failed', async () => {
		const clock = virtualClock({ timeoutMs: 10_000 });
		const probe = scriptedProbe([
			[{ service: 'web' }, { service: 'convex', health: 'starting' }, { service: 'mta' }],
		]);

		const result = await waitForReadiness(SERVICES, probe, clock.timing);

		expect(result.ready).toBe(false);
		expect(result.summary).toContain('still starting: convex (healthcheck has not passed yet)');
		expect(result.summary).not.toContain('not healthy');
	});

	it('catches a container that crashes right after it started', async () => {
		const clock = virtualClock();
		const crashed: Row[] = [
			{ service: 'web', state: 'restarting', status: 'Restarting (1) 2 seconds ago' },
			{ service: 'convex', health: 'healthy' },
			{ service: 'mta' },
		];
		// Up on the first look, crash-looping on every look after it.
		const probe = scriptedProbe([HEALTHY, crashed]);

		const result = await waitForReadiness(SERVICES, probe, clock.timing);

		expect(result.ready).toBe(false);
		expect(result.summary).toContain('web (restarting after a crash)');
		expect(probe.smoke).not.toHaveBeenCalled();
	});

	it('accepts a crash that recovers, once it has stayed up', async () => {
		const clock = virtualClock();
		const crashed: Row[] = [{ service: 'web', state: 'restarting' }, ...HEALTHY.slice(1)];
		const probe = scriptedProbe([HEALTHY, crashed, HEALTHY]);

		const result = await waitForReadiness(SERVICES, probe, clock.timing);

		expect(result.ready).toBe(true);
		expect(probe.list).toHaveBeenCalledTimes(4);
	});

	it('names a service with no container as not started', async () => {
		const clock = virtualClock({ timeoutMs: 5_000 });
		const probe = scriptedProbe([HEALTHY.slice(0, 2)]);

		const result = await waitForReadiness(SERVICES, probe, clock.timing);

		expect(result.ready).toBe(false);
		expect(result.summary).toContain('not started: mta (no container)');
	});

	it('counts a one-shot service that exited 0 as done, and one that exited 1 as failed', async () => {
		const done = scriptedProbe([
			[
				...HEALTHY,
				{ service: 'imap-cert-init', state: 'exited', status: 'Exited (0) 3 seconds ago' },
			],
		]);
		const failed = scriptedProbe([
			[
				...HEALTHY,
				{ service: 'imap-cert-init', state: 'exited', status: 'Exited (1) 3 seconds ago' },
			],
		]);
		const services = [...SERVICES, 'imap-cert-init'];

		await expect(waitForReadiness(services, done, virtualClock().timing)).resolves.toMatchObject({
			ready: true,
		});
		const result = await waitForReadiness(services, failed, virtualClock().timing);
		expect(result.ready).toBe(false);
		expect(result.summary).toContain('imap-cert-init (Exited (1) 3 seconds ago)');
	});

	it('judges a service by its running container, not a stopped one a cut-short recreate left', async () => {
		const probe = scriptedProbe([
			[...HEALTHY, { service: 'web', state: 'exited', status: 'Exited (137) 1 second ago' }],
		]);
		const result = await waitForReadiness(SERVICES, probe, virtualClock().timing);
		expect(result.ready).toBe(true);
	});

	it('is not ready while the web app does not answer, even with every container up', async () => {
		const clock = virtualClock({ timeoutMs: 20_000 });
		const probe = scriptedProbe([HEALTHY], async () => ({
			ok: false,
			detail: 'web answered HTTP 503 to http://web:3000/api/instance-info',
		}));

		const result = await waitForReadiness(SERVICES, probe, clock.timing);

		expect(result.ready).toBe(false);
		expect(result.summary).toContain('web answered HTTP 503');
	});

	it('is ready once the web app starts answering', async () => {
		let answers = 0;
		const probe = scriptedProbe([HEALTHY], async () =>
			++answers < 3
				? { ok: false, detail: 'web did not answer' }
				: { ok: true, detail: 'web answered HTTP 200' }
		);
		const result = await waitForReadiness(SERVICES, probe, virtualClock().timing);
		expect(result.ready).toBe(true);
		expect(probe.smoke).toHaveBeenCalledTimes(3);
	});

	it('reports an unreadable container list as unknown, never as ready', async () => {
		const clock = virtualClock({ timeoutMs: 5_000 });
		const probe = scriptedProbe([null]);

		const result = await waitForReadiness(SERVICES, probe, clock.timing);

		expect(result.ready).toBe(false);
		expect(result.summary).toContain('could not be read back');
	});
});
