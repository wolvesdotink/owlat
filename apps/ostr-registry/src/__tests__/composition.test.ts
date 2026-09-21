/**
 * The composition root's own machinery: the two schedules, the submission
 * valve, and the choice of key directory.
 *
 * These are the parts of `index.ts` that the end-to-end and lifecycle tests
 * cannot reach, because both boot with `startTimers: false` and inject a static
 * key directory. What is pinned here is behaviour that only shows up in
 * production and only shows up late: a schedule that stops ticking, a
 * submission flood that becomes outbound DNS, and the branch that decides
 * whether a deployment enforces the §4.2 allowlist at all.
 */
import { Hono } from 'hono';
import pino, { type Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatOstrKeyRecord, generateEd25519KeyPair } from '@owlat/ostr-core';
import { DEFAULT_ZONE_ORIGIN, type OstrRegistryConfig } from '../config.js';
import { type ResolveTxt } from '../keys/index.js';
import { defaultKeyDirectory, schedule, submitRateLimit } from '../index.js';

const observer = generateEd25519KeyPair();

/** A logger over an array, so an assertion can read what the node told the operator. */
function capturingLogger(): { logger: Logger; lines: Array<Record<string, unknown>> } {
	const lines: Array<Record<string, unknown>> = [];
	const logger = pino(
		{ level: 'trace' },
		{
			write(line: string): void {
				lines.push(JSON.parse(line) as Record<string, unknown>);
			},
		}
	);
	return { logger, lines };
}

function messages(lines: Array<Record<string, unknown>>): string[] {
	return lines.map((line) => String(line['msg']));
}

describe('schedule', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('never runs two of one task at once, and says so when it skips', async () => {
		const { logger, lines } = capturingLogger();
		let release = (): void => {};
		let runs = 0;
		const timer = schedule(1, logger, 'refresh', async () => {
			runs += 1;
			await new Promise<void>((done) => {
				release = done;
			});
		});

		try {
			await vi.advanceTimersByTimeAsync(1000);
			expect(runs).toBe(1);

			// The second tick lands while the first run is still going: it must
			// queue behind nothing and skip, because two scoring passes over one
			// store is the thing this guard exists to prevent.
			await vi.advanceTimersByTimeAsync(1000);
			expect(runs).toBe(1);
			expect(messages(lines).some((msg) => msg.includes('still in progress'))).toBe(true);

			release();
			await vi.advanceTimersByTimeAsync(1000);
			expect(runs).toBe(2);
		} finally {
			clearInterval(timer);
		}
	});

	it('logs a failed run and keeps ticking', async () => {
		const { logger, lines } = capturingLogger();
		let runs = 0;
		const timer = schedule(1, logger, 'sth', async () => {
			runs += 1;
			if (runs === 1) throw new Error('transient');
			return 'ok';
		});

		try {
			await vi.advanceTimersByTimeAsync(1000);
			expect(messages(lines)).toContain('registry: scheduled task failed');

			// An hourly schedule that dies on one transient error is a node that
			// silently stops publishing while still serving.
			await vi.advanceTimersByTimeAsync(1000);
			expect(runs).toBe(2);
		} finally {
			clearInterval(timer);
		}
	});

	it('is not wedged by a task that throws synchronously', async () => {
		const { logger, lines } = capturingLogger();
		let runs = 0;
		const timer = schedule(1, logger, 'sth', (): Promise<unknown> => {
			runs += 1;
			// Called as `task()`, this throw would escape the whole expression,
			// leave the overlap guard latched and kill the schedule for good.
			throw new Error('clock exploded');
		});

		try {
			await vi.advanceTimersByTimeAsync(1000);
			await vi.advanceTimersByTimeAsync(1000);

			expect(runs).toBe(2);
			expect(messages(lines).filter((msg) => msg.includes('scheduled task failed'))).toHaveLength(
				2
			);
		} finally {
			clearInterval(timer);
		}
	});
});

describe('submitRateLimit', () => {
	function app(perMinute: number, clock: () => number): Hono {
		const hono = new Hono();
		hono.use('*', submitRateLimit(perMinute, clock));
		hono.post('/v1/attestations', (c) => c.json({ ok: true }, 201));
		hono.get('/v1/log/sth', (c) => c.json({ ok: true }));
		return hono;
	}

	it('caps submissions per clock minute and tells the caller when to come back', async () => {
		let clock = 0;
		const hono = app(2, () => clock);

		const post = async (): Promise<Response> =>
			hono.request('/v1/attestations', { method: 'POST' });
		expect((await post()).status).toBe(201);
		expect((await post()).status).toBe(201);

		const refused = await post();
		expect(refused.status).toBe(429);
		expect(refused.headers.get('retry-after')).toBe('60');

		// Reads are never limited: they touch no third party, and they are the
		// surface monitors depend on.
		expect((await hono.request('/v1/log/sth')).status).toBe(200);

		clock += 60_000;
		expect((await post()).status).toBe(201);
	});
});

describe('defaultKeyDirectory', () => {
	const config: OstrRegistryConfig = {
		port: 0,
		listenAddress: '127.0.0.1',
		dbDir: './.data',
		logId: 'log.ostr.example',
		logPrivateKeyBase64: generateEd25519KeyPair().privateKey,
		aggregatorPrivateKeyBase64: generateEd25519KeyPair().privateKey,
		zoneOrigin: DEFAULT_ZONE_ORIGIN,
		refBaseUrl: `https://${DEFAULT_ZONE_ORIGIN}/s`,
		sthIntervalSeconds: 3600,
		refreshIntervalSeconds: 3600,
		mmdSeconds: 86_400,
		submitRatePerMinute: null,
		logLevel: 'silent',
		bootstrapObservers: null,
	};

	function resolver(): ResolveTxt & { calls: string[] } {
		const calls: string[] = [];
		return Object.assign(
			async (name: string): Promise<string[][]> => {
				calls.push(name);
				if (name !== '_ostr.listed.example') {
					throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
				}
				return [[formatOstrKeyRecord(observer.publicKey)]];
			},
			{ calls }
		);
	}

	it('resolves anyone over DNS when no allowlist is configured', async () => {
		const resolve = resolver();

		const directory = defaultKeyDirectory(config, resolve);

		expect(await directory.verifyingKeys('listed.example')).toEqual([
			formatOstrKeyRecord(observer.publicKey),
		]);
		expect(await directory.verifyingKeys('stranger.example')).toEqual([]);
		expect(resolve.calls).toEqual(['_ostr.listed.example', '_ostr.stranger.example']);
	});

	it('answers only for allowlisted observers when one is configured', async () => {
		const resolve = resolver();

		const directory = defaultKeyDirectory(
			{ ...config, bootstrapObservers: [{ domain: 'listed.example', records: [] }] },
			resolve
		);

		expect(await directory.verifyingKeys('listed.example')).toEqual([
			formatOstrKeyRecord(observer.publicKey),
		]);
		// An unlisted observer is refused at the door and never becomes a query,
		// however well it publishes.
		expect(await directory.verifyingKeys('stranger.example')).toEqual([]);
		expect(resolve.calls).toEqual(['_ostr.listed.example']);
	});
});
