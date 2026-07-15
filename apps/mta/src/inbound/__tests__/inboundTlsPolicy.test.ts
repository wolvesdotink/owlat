import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import {
	inboundTlsRequiredError,
	isInboundTlsRequired,
	setInboundTlsRequired,
} from '../inboundTlsPolicy.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), error: vi.fn() },
}));

describe('inbound TLS policy', () => {
	it('requires TLS when no stored choice exists', async () => {
		const redis = { get: vi.fn().mockResolvedValue(null) } as unknown as Redis;
		expect(await isInboundTlsRequired(redis)).toBe(true);
	});

	it('honours an explicit owner/admin opt-out', async () => {
		const redis = { get: vi.fn().mockResolvedValue('0') } as unknown as Redis;
		expect(await isInboundTlsRequired(redis)).toBe(false);
	});

	it('fails closed when Redis cannot be read', async () => {
		const redis = { get: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as Redis;
		expect(await isInboundTlsRequired(redis)).toBe(true);
	});

	it('persists both policy choices without a TTL', async () => {
		const set = vi.fn().mockResolvedValue('OK');
		const redis = { set } as unknown as Redis;
		await setInboundTlsRequired(redis, true);
		await setInboundTlsRequired(redis, false);
		expect(set).toHaveBeenNthCalledWith(1, 'mta:inbound-tls-required', '1');
		expect(set).toHaveBeenNthCalledWith(2, 'mta:inbound-tls-required', '0');
	});

	it('returns a permanent SMTP encryption-needed rejection', () => {
		const error = inboundTlsRequiredError();
		expect(error.responseCode).toBe(550);
		expect(error.message).toContain('5.7.10 Encryption needed');
		expect(error.message).toContain('STARTTLS');
	});
});
