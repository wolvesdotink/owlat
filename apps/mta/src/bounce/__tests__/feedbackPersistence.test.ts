import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	runPipeline: vi.fn(),
	reduce: vi.fn(),
	attachFeedbackProvenance: vi.fn(),
	queueConvexWebhook: vi.fn(),
	completeComplaint: vi.fn(),
	releaseComplaint: vi.fn(),
	runComplaintEffect: vi.fn(),
	recordOutcome: vi.fn(),
}));

vi.mock('../pipeline.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../pipeline.js')>()),
	runPipeline: mocks.runPipeline,
}));
vi.mock('../outcome.js', () => ({ reduce: mocks.reduce }));
vi.mock('../feedbackProvenance.js', () => ({
	attachFeedbackProvenance: mocks.attachFeedbackProvenance,
}));
vi.mock('../serverHelpers.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../serverHelpers.js')>()),
	logAttempt: vi.fn(),
}));
vi.mock('../fblProcessor.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../fblProcessor.js')>()),
	completeComplaint: mocks.completeComplaint,
	releaseComplaint: mocks.releaseComplaint,
	runComplaintEffect: mocks.runComplaintEffect,
}));
vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: vi.fn(),
	queueConvexWebhook: mocks.queueConvexWebhook,
}));
vi.mock('../../intelligence/circuitBreaker.js', () => ({
	recordOutcome: mocks.recordOutcome,
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildOnData } from '../server.js';
import { processBounceAttempt } from '../attemptProcessor.js';
import type { MtaConfig } from '../../config.js';
import { TransientFeedbackProcessingError } from '../transientFeedbackError.js';

describe('attributed feedback durability at the SMTP boundary', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.runPipeline.mockResolvedValue({ kind: 'bounceTo', attempt: { kind: 'dsn' } });
		mocks.attachFeedbackProvenance.mockImplementation(async (_redis, attempt) => attempt);
		mocks.releaseComplaint.mockResolvedValue(undefined);
		mocks.runComplaintEffect.mockImplementation(async (_redis, _reservation, _identity, apply) =>
			apply()
		);
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

	it('completes FBL dedup after a generic effect error that the SMTP boundary ACKs', async () => {
		mocks.runPipeline
			.mockResolvedValueOnce({
				kind: 'bounceTo',
				attempt: {
					kind: 'fbl',
					arf: { type: 'complained' },
					dedupReservation: {
						key: 'mta:fbl:dedup:generic',
						token: 'reserved:generic',
					},
				},
			})
			.mockResolvedValueOnce({ kind: 'dropSilently', reason: 'duplicate_fbl_complaint' });
		mocks.reduce.mockReturnValue({
			effects: [
				{
					kind: 'notify_convex',
					event: {
						event: 'complained',
						messageId: 'message-1',
						timestamp: 1,
					},
				},
				{
					kind: 'circuit_breaker_outcome',
					orgId: 'org-feedback',
					outcome: 'complained',
				},
			],
		});
		mocks.queueConvexWebhook.mockResolvedValue('outbox-complaint');
		mocks.recordOutcome.mockRejectedValue(new Error('best-effort effect failed'));
		const redis = {};
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
		const message = Buffer.from('From: fbl@example.test\r\nSubject: complaint\r\n\r\nabuse');

		expect(await handler(message, session)).toBeUndefined();
		expect(mocks.recordOutcome).toHaveBeenCalledOnce();
		expect(mocks.completeComplaint).toHaveBeenCalledOnce();
		expect(mocks.releaseComplaint).not.toHaveBeenCalled();
		expect(await handler(message, session)).toBeUndefined();
		expect(mocks.queueConvexWebhook).toHaveBeenCalledOnce();
	});

	it('retries FBL completion without repeating checkpointed effects', async () => {
		const reservation = {
			key: 'mta:fbl:dedup:completion-retry',
			token: 'reserved:completion-retry',
		};
		mocks.runPipeline.mockResolvedValue({
			kind: 'bounceTo',
			attempt: { kind: 'fbl', arf: { type: 'complained' }, dedupReservation: reservation },
		});
		mocks.reduce.mockReturnValue({
			effects: [
				{
					kind: 'notify_convex',
					event: { event: 'complained', messageId: 'message-1', timestamp: 1 },
				},
				{ kind: 'circuit_breaker_outcome', orgId: 'org-feedback', outcome: 'complained' },
			],
		});
		mocks.queueConvexWebhook.mockResolvedValue('outbox-complaint');
		mocks.recordOutcome.mockResolvedValue(undefined);
		const applied = new Set<string>();
		mocks.runComplaintEffect.mockImplementation(
			async (_redis, _reservation, identity: string, apply: () => Promise<unknown>) => {
				if (applied.has(identity)) return undefined;
				const result = await apply();
				applied.add(identity);
				return result;
			}
		);
		mocks.completeComplaint
			.mockRejectedValueOnce(
				new TransientFeedbackProcessingError(
					'Complaint deduplication completion is unavailable',
					new Error('response lost')
				)
			)
			.mockResolvedValueOnce(undefined);
		const attempt = {
			kind: 'fbl',
			arf: { type: 'complained' },
			dedupReservation: reservation,
		} as never;
		const deps = { redis: {}, config: {} } as never;
		const ctx = { parsed: {} } as never;

		await expect(processBounceAttempt(deps, attempt, ctx)).rejects.toBeInstanceOf(
			TransientFeedbackProcessingError
		);
		await processBounceAttempt(deps, attempt, ctx);
		expect(mocks.recordOutcome).toHaveBeenCalledOnce();
		expect(mocks.completeComplaint).toHaveBeenCalledTimes(2);
		expect(mocks.releaseComplaint).toHaveBeenCalledOnce();
	});
});
