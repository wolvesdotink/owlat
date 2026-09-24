import { afterEach, describe, it, expect, vi } from 'vitest';
import type { ComposeService } from '@owlat/shared/containerHealth';
import type { ReadinessProbe, ReadinessTiming } from '../readiness.js';

/**
 * The readiness wait against the healthcheck cadence services declare, and
 * against failures that were there before the rollout.
 *
 * The 180 s bound used to be fixed. ClamAV declares `interval: 60s,
 * start_period: 600s`, so Docker re-evaluates its health once a minute and a
 * clamd that finished loading at ~125 s is reported healthy at the 180 s
 * probe: a healthy rollout came back as `started`.
 */

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('../http.js', () => ({ exec: execMock, OWLAT_DIR: '/owlat' }));

const { parseGoDuration, parseHealthCadence } = await import('../healthCadence.js');
const { failingBeforeRollout, setReadinessTiming, verifyReadiness, waitForReadiness } =
	await import('../readiness.js');

type Row = Partial<ComposeService> & { service: string };

function row(r: Row): ComposeService {
	return { state: 'running', status: '', image: '', imageTag: '', health: '', ...r };
}

/** The production bounds, on a clock that only moves when the code sleeps. */
function virtualClock() {
	let now = 0;
	const timing: ReadinessTiming = {
		timeoutMs: 180_000,
		maxTimeoutMs: 720_000,
		firstPollMs: 2_000,
		maxPollMs: 10_000,
		settleMs: 5_000,
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
	};
	return { timing, now: () => now };
}

const CLAMAV = { intervalMs: 60_000, startPeriodMs: 600_000 };
const SERVICES = ['web', 'convex', 'redis', 'clamav'];

/** web, convex and redis up; clamav as `clamav(now)` says. */
function stackProbe(
	clock: { now: () => number },
	clamav: (now: number) => Row,
	cadence: ReadinessProbe['cadence'] = () => new Map([['clamav', CLAMAV]])
): ReadinessProbe {
	return {
		list: () =>
			[
				{ service: 'web' },
				{ service: 'convex', health: 'healthy' },
				{ service: 'redis', health: 'healthy' },
				clamav(clock.now()),
			].map(row),
		smoke: async () => ({ ok: true, detail: 'web answered HTTP 200' }),
		cadence,
	};
}

afterEach(() => {
	setReadinessTiming(null);
	execMock.mockReset();
});

describe('healthcheck cadence from docker compose config', () => {
	it('parses the Go durations compose prints', () => {
		expect(parseGoDuration('1m0s')).toBe(60_000);
		expect(parseGoDuration('10m0s')).toBe(600_000);
		expect(parseGoDuration('1h2m3s')).toBe(3_723_000);
		expect(parseGoDuration('500ms')).toBe(500);
		expect(parseGoDuration('1.5s')).toBe(1_500);
		expect(parseGoDuration('ten seconds')).toBeNull();
		expect(parseGoDuration('10')).toBeNull();
		expect(parseGoDuration(60)).toBeNull();
	});

	it('reads each declared healthcheck, skipping disabled ones and defaulting the interval', () => {
		const cadence = parseHealthCadence(
			JSON.stringify({
				services: {
					clamav: {
						healthcheck: { test: ['CMD-SHELL', 'x'], interval: '1m0s', start_period: '10m0s' },
					},
					convex: { healthcheck: { test: ['CMD', 'x'], interval: '15s', start_period: '10s' } },
					redis: { healthcheck: { test: ['CMD', 'x'] } },
					web: { image: 'web' },
					off: { healthcheck: { disable: true } },
					none: { healthcheck: { test: ['NONE'] } },
				},
			})
		);
		expect(Object.fromEntries(cadence)).toEqual({
			clamav: { intervalMs: 60_000, startPeriodMs: 600_000 },
			convex: { intervalMs: 15_000, startPeriodMs: 10_000 },
			redis: { intervalMs: 30_000, startPeriodMs: 0 },
		});
		expect(parseHealthCadence('not json').size).toBe(0);
	});
});

describe('waitForReadiness honours the declared cadence', () => {
	it('waits for a ClamAV that turns healthy at its 180 s probe', async () => {
		const clock = virtualClock();
		const probe = stackProbe(clock, (now) => ({
			service: 'clamav',
			health: now >= 180_000 ? 'healthy' : 'starting',
		}));

		const result = await waitForReadiness(SERVICES, probe, clock.timing);

		expect(result.ready).toBe(true);
		expect(result.summary).toContain('clamav: healthy');
		expect(clock.now()).toBeGreaterThanOrEqual(180_000);
		expect(clock.now()).toBeLessThan(200_000);
	});

	it('gives a slow ClamAV its whole start period plus one probe, and no longer', async () => {
		const clock = virtualClock();
		const probe = stackProbe(clock, () => ({ service: 'clamav', health: 'starting' }));

		const result = await waitForReadiness(SERVICES, probe, clock.timing);

		expect(result.ready).toBe(false);
		// 600 s start period + one 60 s interval + one 5 s settle.
		expect(clock.now()).toBeGreaterThan(600_000);
		expect(clock.now()).toBeLessThanOrEqual(665_000);
		expect(result.summary).toContain('still starting: clamav');
	});

	it('reports a service still inside its start period at the cap as warming up, not failed', async () => {
		const clock = virtualClock();
		const probe = stackProbe(
			clock,
			() => ({ service: 'clamav', health: 'starting' }),
			() => new Map([['clamav', { intervalMs: 60_000, startPeriodMs: 1_800_000 }]])
		);

		const result = await waitForReadiness(SERVICES, probe, clock.timing);

		expect(result.ready).toBe(false);
		expect(clock.now()).toBeLessThanOrEqual(720_000);
		expect(result.summary).toContain('still warming up: clamav');
		expect(result.summary).toContain('within its 1800s start period');
		expect(result.summary).not.toContain('not healthy');
	});

	it('keeps the fixed bound for a failing service that declares no healthcheck', async () => {
		const clock = virtualClock();
		const probe = stackProbe(
			clock,
			() => ({ service: 'clamav', health: 'healthy' }),
			() => new Map([['clamav', CLAMAV]])
		);
		probe.list = () =>
			[
				{ service: 'web', state: 'restarting' },
				{ service: 'convex', health: 'healthy' },
				{ service: 'redis', health: 'healthy' },
				{ service: 'clamav', health: 'healthy' },
			].map(row);

		const result = await waitForReadiness(SERVICES, probe, clock.timing);

		expect(result.ready).toBe(false);
		expect(clock.now()).toBeLessThanOrEqual(180_000);
	});
});

describe('failures that were there before the rollout', () => {
	it('reports a service already crash-looping as a warning, not as a failed rollout', async () => {
		const clock = virtualClock();
		const probe = stackProbe(clock, () => ({
			service: 'clamav',
			state: 'restarting',
			status: 'Restarting (1) 4 seconds ago',
		}));

		const result = await waitForReadiness(SERVICES, probe, clock.timing, {
			preExisting: new Map([['clamav', 'restarting after a crash']]),
		});

		expect(result.ready).toBe(true);
		expect(result.warnings).toEqual([
			'clamav was already restarting after a crash before the update and is still restarting after a crash',
		]);
		expect(result.summary).toContain('3 of 4 services are up');
		expect(result.summary).toContain('Already failing before the update');
		// It did not hold the verdict: one settle interval, not the whole bound.
		expect(clock.now()).toBe(5_000);
	});

	it('drops the warning once the update fixed the service', async () => {
		const clock = virtualClock();
		const probe = stackProbe(clock, () => ({ service: 'clamav', health: 'healthy' }));

		const result = await waitForReadiness(SERVICES, probe, clock.timing, {
			preExisting: new Map([['clamav', 'failing its healthcheck']]),
		});

		expect(result.ready).toBe(true);
		expect(result.warnings).toEqual([]);
		expect(result.summary).toContain('All 4 services are up');
	});

	it('still fails a service the rollout broke', async () => {
		const clock = virtualClock();
		const probe = stackProbe(clock, () => ({ service: 'clamav', health: 'unhealthy' }));

		const result = await waitForReadiness(SERVICES, probe, clock.timing, {
			preExisting: new Map([['redis', 'failing its healthcheck']]),
		});

		expect(result.ready).toBe(false);
		expect(result.summary).toContain('not healthy: clamav');
	});

	it('snapshots which services are failing before the rollout', () => {
		execMock.mockImplementation((_file: string, args: string[]) => ({
			ok: true,
			stderr: '',
			stdout: args.includes('ps')
				? [
						{ Service: 'web', State: 'running' },
						{ Service: 'clamav', State: 'running', Health: 'unhealthy' },
						{ Service: 'mta', State: 'restarting', Status: 'Restarting (1)' },
					]
						.map((r) => JSON.stringify(r))
						.join('\n')
				: '',
		}));

		const failing = failingBeforeRollout(['web', 'clamav', 'mta', 'convex'], ['compose']);

		expect(Object.fromEntries(failing)).toEqual({
			clamav: 'failing its healthcheck',
			mta: 'restarting after a crash',
		});
	});
});

describe('verifyReadiness bounds', () => {
	function stuckClamav() {
		execMock.mockImplementation((_file: string, args: string[]) => {
			if (args.includes('ps')) {
				return {
					ok: true,
					stderr: '',
					stdout: JSON.stringify({ Service: 'clamav', State: 'running', Health: 'starting' }),
				};
			}
			if (args.includes('config')) {
				return {
					ok: true,
					stderr: '',
					stdout: JSON.stringify({
						services: { clamav: { healthcheck: { interval: '1m0s', start_period: '10m0s' } } },
					}),
				};
			}
			return { ok: false, stdout: '', stderr: 'unexpected' };
		});
		const clock = virtualClock();
		setReadinessTiming({ now: clock.timing.now, sleep: clock.timing.sleep });
		return clock;
	}

	it('stretches a rollout wait to the cadence the compose file declares', async () => {
		const clock = stuckClamav();

		const result = await verifyReadiness(['clamav'], ['compose']);

		expect(result.ready).toBe(false);
		expect(clock.now()).toBeGreaterThan(600_000);
	});

	it('keeps the recovery after a failed up short, whatever the cadence', async () => {
		const clock = stuckClamav();

		const result = await verifyReadiness(['clamav'], ['compose'], { recovery: true });

		expect(result.ready).toBe(false);
		// Inside the web route's five-minute window with room to spare.
		expect(clock.now()).toBeLessThanOrEqual(60_000);
		expect(result.summary).toContain('still warming up: clamav');
	});
});
