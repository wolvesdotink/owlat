import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';

vi.mock('../dlq.js', () => ({
	storeFailed: vi.fn().mockResolvedValue('dlq-123'),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { notifyConvex, notifyPostmasterConvex } from '../convexNotifier.js';
import { storeFailed } from '../dlq.js';
import { logger } from '../../monitoring/logger.js';
import type { MtaWebhookEvent } from '../../types.js';
import type { MtaConfig } from '../../config.js';

function createEvent(overrides: Partial<MtaWebhookEvent> = {}): MtaWebhookEvent {
	return {
		event: 'sent',
		messageId: 'msg-001',
		organizationId: 'org-1',
		timestamp: Date.now(),
		...overrides,
	};
}

function createConfig(overrides: Partial<MtaConfig> = {}): MtaConfig {
	return {
		port: 3100,
		bouncePort: 25,
		redisUrl: 'redis://localhost:6379',
		apiKey: 'test-key',
		ehloHostname: 'mail.owlat.com',
		ehloHostnames: {},
		returnPathDomain: 'bounces.owlat.com',
		convexSiteUrl: 'https://test.convex.site',
		webhookSecret: 'test-webhook-secret',
		ipPools: { transactional: ['10.0.0.1'], campaign: ['10.0.0.2'] },
		dkimKeys: {},
		workerConcurrency: 50,
		serverId: 'test-server',
		smtpPool: {
			maxPerHost: 3,
			idleTimeoutMs: 30000,
			maxAgeMs: 300000,
			maxMessagesPerConnection: 100,
		},
		orgLimits: { defaultDailyLimit: 50000, defaultHourlyLimit: 5000 },
		submissionPort: 587,
		submissionEnabled: false,
		contentScreeningEnabled: true,
		contentMaxSizeKb: 500,
		deliveryLogMaxLen: 100000,
		deliveryLogTtlHours: 72,
		webhookDlqMaxSize: 10000,
		bounceMaxConnectionsPerIp: 10,
		bounceMaxClients: 200,
		bounceTarpitEnabled: false,
		bounceTarpitDelayMs: 5000,
		inboundSpfEnabled: false,
		rspamdRejectThreshold: 15,
		smtpPoolGlobalMaxPerHost: 10,
		...overrides,
	};
}

describe('notifyConvex', () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.useRealTimers();
	});

	it('returns true on successful first attempt', async () => {
		const payloadSentinel = 'success-payload-never-log';
		const secretSentinel = 'success-secret-never-log';
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
		});

		const result = await notifyConvex(
			createEvent({ messageId: payloadSentinel, organizationId: payloadSentinel }),
			createConfig({ webhookSecret: secretSentinel })
		);

		expect(result).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(logger.debug).toHaveBeenCalledWith(
			{
				operation: 'convex_webhook',
				category: 'delivered',
				eventType: 'sent',
			},
			'Convex webhook delivered'
		);
		const serializedLogs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
		expect(serializedLogs).not.toContain(payloadSentinel);
		expect(serializedLogs).not.toContain(secretSentinel);
	});

	it('includes HMAC signature and timestamp headers', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
		});

		await notifyConvex(createEvent(), createConfig());

		const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
		const options = fetchCall[1] as RequestInit;
		const headers = options.headers as Record<string, string>;

		expect(headers['X-MTA-Signature']).toBeDefined();
		expect(headers['X-MTA-Signature']).toMatch(/^[0-9a-f]+$/);
		expect(headers['X-MTA-Timestamp']).toBeDefined();
		expect(headers['X-MTA-Timestamp']).toMatch(/^\d+$/);
	});

	it('stores in DLQ after all retries fail with Redis available', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
		});

		const redis = new Redis();
		const promise = notifyConvex(createEvent(), createConfig(), redis);

		await vi.runAllTimersAsync();

		const result = await promise;

		expect(result).toBe(false);
		expect(storeFailed).toHaveBeenCalledOnce();
		const storedFailure = vi.mocked(storeFailed).mock.calls[0]![2];
		expect(['transport', 'deadline_exhausted', 'unknown', 'http']).toContain(
			storedFailure.category
		);
		expect(storedFailure).not.toHaveProperty('error');
		expect(storedFailure).not.toHaveProperty('message');
	});

	it('returns false without DLQ when no Redis provided', async () => {
		const payloadSentinel = 'no-redis-payload-never-log';
		const secretSentinel = 'no-redis-secret-never-log';
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
		});

		const promise = notifyConvex(
			createEvent({ messageId: payloadSentinel, organizationId: payloadSentinel }),
			createConfig({ webhookSecret: secretSentinel })
		);

		// Advance through all retry delays
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(600_000);
		}

		const result = await promise;

		expect(result).toBe(false);
		expect(storeFailed).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledWith(
			{
				operation: 'convex_webhook_dlq',
				category: 'unavailable',
				eventType: 'sent',
			},
			'Convex webhook delivery FAILED after all retries (no Redis for DLQ)'
		);
		const serializedLogs = JSON.stringify([
			...vi.mocked(logger.warn).mock.calls,
			...vi.mocked(logger.error).mock.calls,
		]);
		expect(serializedLogs).not.toContain(payloadSentinel);
		expect(serializedLogs).not.toContain(secretSentinel);
	});

	it('handles fetch throwing (network/timeout error)', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error('AbortError: signal timed out'));

		const promise = notifyConvex(createEvent(), createConfig());

		// Advance through all retry delays
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(600_000);
		}

		const result = await promise;

		expect(result).toBe(false);
	});

	it('never logs webhook payloads or Redis command arguments when delivery and DLQ fail', async () => {
		const payloadSentinel = 'sentinel-recipient-payload-never-log';
		const webhookSecretSentinel = 'sentinel-webhook-secret-never-log';
		const redisArgumentSentinel = 'sentinel-redis-command-argument-never-log';
		globalThis.fetch = vi.fn().mockRejectedValue(
			Object.assign(new Error(`Failed request for ${payloadSentinel}`), {
				request: { body: payloadSentinel, secret: webhookSecretSentinel },
			})
		);
		vi.mocked(storeFailed).mockRejectedValueOnce(
			Object.assign(new Error(`Redis failed for ${redisArgumentSentinel}`), {
				command: {
					name: 'set',
					args: ['mta:dlq:entry:sentinel', redisArgumentSentinel, payloadSentinel],
				},
			})
		);
		const redis = new Redis();
		const promise = notifyConvex(
			createEvent({ messageId: payloadSentinel }),
			createConfig({ webhookSecret: webhookSecretSentinel }),
			redis,
			{ deadline: Date.now() + 500 }
		);
		await vi.runAllTimersAsync();

		expect(await promise).toBe(false);
		const serializedLogs = JSON.stringify([
			...vi.mocked(logger.warn).mock.calls,
			...vi.mocked(logger.error).mock.calls,
		]);
		expect(serializedLogs).not.toContain(payloadSentinel);
		expect(serializedLogs).not.toContain(webhookSecretSentinel);
		expect(serializedLogs).not.toContain(redisArgumentSentinel);
		expect(serializedLogs).not.toContain('mta:dlq:entry:sentinel');
		expect(logger.warn).toHaveBeenCalledWith(
			{
				operation: 'convex_webhook',
				category: 'transport',
				attempt: 0,
				eventType: 'sent',
			},
			'Convex webhook failed'
		);
		expect(logger.error).toHaveBeenCalledWith(
			{
				operation: 'convex_webhook_dlq',
				category: 'storage',
				eventType: 'sent',
			},
			'Failed to store event in DLQ — event permanently lost'
		);
	});

	it('does not wait past a caller-provided delivery deadline', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
		});

		const promise = notifyConvex(createEvent(), createConfig(), undefined, {
			deadline: Date.now() + 500,
		});
		await vi.runAllTimersAsync();

		expect(await promise).toBe(false);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('acknowledges an unowned Postmaster domain without DLQ retention or payload logs', async () => {
		const domainSentinel = 'unrelated-private.example';
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					kind: 'internal.postmaster_authorize_domain',
					disposition: 'ignored_unowned',
					retained: false,
				}),
				{ status: 200 }
			)
		);
		const redis = new Redis();

		const result = await notifyConvex(
			{
				event: 'postmaster.authorize_domain',
				domain: domainSentinel,
				timestamp: Date.now(),
			},
			createConfig(),
			redis
		);

		expect(result).toBe(true);
		expect(storeFailed).not.toHaveBeenCalled();
		expect(
			JSON.stringify([
				...vi.mocked(logger.debug).mock.calls,
				...vi.mocked(logger.warn).mock.calls,
				...vi.mocked(logger.error).mock.calls,
			])
		).not.toContain(domainSentinel);
	});

	it('retries Postmaster transport failures without retaining its payload in the DLQ', async () => {
		const domainSentinel = 'transport-private.example';
		globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
		const promise = notifyPostmasterConvex(
			{
				event: 'postmaster.stats',
				domain: domainSentinel,
				date: '2026-07-20',
				userReportedSpamRatio: 0.75,
				timestamp: Date.now(),
			},
			createConfig(),
			{ deadline: Date.now() + 500 }
		);
		await vi.runAllTimersAsync();

		expect(await promise).toEqual({ disposition: 'delivery_failed', retained: false });
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(storeFailed).not.toHaveBeenCalled();
		const serializedLogs = JSON.stringify([
			...vi.mocked(logger.warn).mock.calls,
			...vi.mocked(logger.error).mock.calls,
		]);
		expect(serializedLogs).not.toContain(domainSentinel);
		expect(serializedLogs).not.toContain('0.75');
	});
});
