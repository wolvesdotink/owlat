import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import type { MtaConfig } from '../../config.js';

const mocks = vi.hoisted(() => ({
	listFailed: vi.fn(),
	getStats: vi.fn(),
	getEntry: vi.fn(),
	claimOne: vi.fn(),
	settleClaim: vi.fn(),
	removeOne: vi.fn(),
	updateEntry: vi.fn(),
	getAllIds: vi.fn(),
	notifyConvex: vi.fn(),
}));

vi.mock('../../webhooks/dlq.js', () => ({
	listFailed: mocks.listFailed,
	getStats: mocks.getStats,
	getEntry: mocks.getEntry,
	claimOne: mocks.claimOne,
	settleClaim: mocks.settleClaim,
	removeOne: mocks.removeOne,
	updateEntry: mocks.updateEntry,
	getAllIds: mocks.getAllIds,
}));

vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: mocks.notifyConvex,
}));

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createDlqRoutes } = await import('../dlq.js');
const { logger } = await import('../../monitoring/logger.js');

const API_KEY = 'test-master-key';
const config = { apiKey: API_KEY } as MtaConfig;
const redis = {} as Redis;

function request(method: string, path: string): Promise<Response> {
	return createDlqRoutes(redis, config).request(path, {
		method,
		headers: { Authorization: `Bearer ${API_KEY}` },
	});
}

function storageError(): Error {
	return Object.assign(new Error('redis-route-error-never-log'), {
		command: {
			name: 'set',
			args: ['mta:dlq:entry:sensitive-id', 'serialized-sensitive-payload'],
		},
	});
}

function expectOnlySafeFailureMetadata(operation: string, message: string): void {
	expect(logger.error).toHaveBeenCalledWith({ operation, category: 'storage' }, message);
	const serializedLogs = JSON.stringify(vi.mocked(logger.error).mock.calls);
	expect(serializedLogs).not.toContain('redis-route-error-never-log');
	expect(serializedLogs).not.toContain('mta:dlq:entry:sensitive-id');
	expect(serializedLogs).not.toContain('serialized-sensitive-payload');
	expect(serializedLogs).not.toContain('sensitive-id');
}

describe('DLQ route failure logging', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('sanitizes list failures', async () => {
		mocks.listFailed.mockRejectedValueOnce(storageError());

		expect((await request('GET', '/')).status).toBe(500);
		expectOnlySafeFailureMetadata('dlq_list', 'Failed to list DLQ entries');
	});

	it('sanitizes stats failures', async () => {
		mocks.getStats.mockRejectedValueOnce(storageError());

		expect((await request('GET', '/stats')).status).toBe(500);
		expectOnlySafeFailureMetadata('dlq_stats', 'Failed to get DLQ stats');
	});

	it('sanitizes retry failures, including serialized entry writes', async () => {
		mocks.claimOne.mockResolvedValueOnce({
			dlqId: 'sensitive-id',
			event: {
				event: 'sent',
				messageId: 'serialized-sensitive-payload',
				timestamp: Date.now(),
			},
			failure: { category: 'transport' },
			attempts: 0,
			createdAt: Date.now(),
			claim: { owner: 'manual', version: 1, expiresAt: Date.now() + 1000 },
		});
		mocks.notifyConvex.mockResolvedValueOnce(false);
		mocks.settleClaim.mockRejectedValueOnce(storageError());

		expect((await request('POST', '/sensitive-id/retry')).status).toBe(500);
		expectOnlySafeFailureMetadata('dlq_retry_one', 'Failed to retry DLQ entry');
	});

	it('sanitizes retry-all failures', async () => {
		mocks.getAllIds.mockRejectedValueOnce(storageError());

		expect((await request('POST', '/retry-all')).status).toBe(500);
		expectOnlySafeFailureMetadata('dlq_retry_all', 'Failed to retry all DLQ entries');
	});

	it('sanitizes removal failures', async () => {
		mocks.removeOne.mockRejectedValueOnce(storageError());

		expect((await request('DELETE', '/sensitive-id')).status).toBe(500);
		expectOnlySafeFailureMetadata('dlq_remove_one', 'Failed to remove DLQ entry');
	});
});
