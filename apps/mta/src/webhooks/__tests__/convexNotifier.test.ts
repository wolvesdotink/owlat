import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';

vi.mock('../dlq.js', () => ({
	storeFailed: vi.fn().mockResolvedValue('dlq-123'),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { notifyConvex } from '../convexNotifier.js';
import { storeFailed } from '../dlq.js';
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
		smtpPool: { maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 },
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
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
		});

		const result = await notifyConvex(createEvent(), createConfig());

		expect(result).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
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

		// Advance through all retry delays: 1s, 5s, 15s, 1m, 5m + AbortController timeouts
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(600_000);
		}

		const result = await promise;

		expect(result).toBe(false);
		expect(storeFailed).toHaveBeenCalled();
	});

	it('returns false without DLQ when no Redis provided', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
		});

		const promise = notifyConvex(createEvent(), createConfig());

		// Advance through all retry delays
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(600_000);
		}

		const result = await promise;

		expect(result).toBe(false);
		expect(storeFailed).not.toHaveBeenCalled();
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
});
