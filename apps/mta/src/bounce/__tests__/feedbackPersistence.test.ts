import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	runPipeline: vi.fn(),
	reduce: vi.fn(),
	attachFeedbackProvenance: vi.fn(),
	queueConvexWebhook: vi.fn(),
}));

vi.mock('../pipeline.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../pipeline.js')>()),
	runPipeline: mocks.runPipeline,
}));
vi.mock('../outcome.js', () => ({ reduce: mocks.reduce }));
vi.mock('../feedbackProvenance.js', () => ({
	attachFeedbackProvenance: mocks.attachFeedbackProvenance,
}));
vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: vi.fn(),
	queueConvexWebhook: mocks.queueConvexWebhook,
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildOnData } from '../server.js';
import type { MtaConfig } from '../../config.js';

describe('attributed feedback durability at the SMTP boundary', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.runPipeline.mockResolvedValue({ kind: 'bounceTo', attempt: { kind: 'dsn' } });
		mocks.attachFeedbackProvenance.mockImplementation(async (_redis, attempt) => attempt);
		mocks.reduce.mockReturnValue({
			effects: [
				{
					kind: 'notify_convex',
					event: {
						event: 'bounced',
						messageId: 'message-1',
						bounceType: 'hard',
						timestamp: 1,
					},
				},
				{
					kind: 'stage_attachment',
					redisKey: 'feedback:raw',
					contentBase64: 'ZmFpbGVk',
					ttlSeconds: 60,
				},
			],
		});
	});

	it('returns 451 on outbox failure and ACKs only after a later retry persists', async () => {
		mocks.queueConvexWebhook
			.mockRejectedValueOnce(new Error('Redis unavailable'))
			.mockResolvedValueOnce('outbox-hard');
		const redis = { setex: vi.fn().mockRejectedValue(new Error('secondary Redis failure')) };
		const handler = buildOnData(
			{
				inboundDkimEnabled: false,
				inboundDmarcEnabled: false,
				inboundArcEnabled: false,
			} as MtaConfig,
			redis as never,
			{} as never
		);
		const session = {
			rcptTo: [{ address: 'bounce+signed@bounces.owlat.test' }],
			mailFrom: { address: '' },
			transaction: {},
		} as never;
		const message = Buffer.from('From: mailer@example.test\r\nSubject: DSN\r\n\r\nfailed');

		const first = await handler(message, session);
		expect(first).toMatchObject({ code: 451, enhanced: '4.3.0' });
		expect(redis.setex).not.toHaveBeenCalled();
		const retry = await handler(message, session);
		expect(retry).toBeUndefined();
		expect(mocks.queueConvexWebhook).toHaveBeenCalledTimes(2);
		expect(redis.setex).toHaveBeenCalledOnce();
	});
});
