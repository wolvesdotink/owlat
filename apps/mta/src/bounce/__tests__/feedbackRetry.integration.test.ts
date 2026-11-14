import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type * as ConvexNotifierModule from '../../webhooks/convexNotifier.js';

const mocks = vi.hoisted(() => ({
	queueConvexWebhook: vi.fn(),
}));

vi.mock('../../webhooks/convexNotifier.js', async (importOriginal) => ({
	...(await importOriginal<typeof ConvexNotifierModule>()),
	queueConvexWebhook: mocks.queueConvexWebhook,
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type RealRedis from 'ioredis';
import type { MtaConfig } from '../../config.js';
import type { EmailJob } from '../../types.js';
import { buildOnData } from '../server.js';
import { recordFeedbackProvenance } from '../feedbackProvenance.js';
import { buildVerpAddress } from '../verp.js';
import { buildUnsubscribeAddress } from '@owlat/shared/verp';
import { unsubscribeMailTotal } from '../../monitoring/collector.js';

const VERP_KEY = 'feedback-retry-verp-key-012345678901';
const MESSAGE_ID = 'feedback-retry-message';
const RECIPIENT = 'complainer@example.net';

function config(): MtaConfig {
	return {
		inboundDkimEnabled: false,
		inboundDmarcEnabled: false,
		inboundArcEnabled: false,
	} as MtaConfig;
}

function session(rcptTo: string) {
	return {
		rcptTo: [{ address: rcptTo }],
		mailFrom: { address: '' },
		transaction: {},
	} as never;
}

function arfMessage(originalMailFrom: string): Buffer {
	return Buffer.from(
		[
			'From: feedbackloop@isp.example',
			'To: fbl@owlat.test',
			'Subject: Spam Feedback Report',
			'MIME-Version: 1.0',
			'Content-Type: multipart/report; report-type=feedback-report; boundary="arf"',
			'',
			'--arf',
			'Content-Type: text/plain',
			'',
			'An abuse complaint.',
			'--arf',
			'Content-Type: message/feedback-report',
			'',
			'Feedback-Type: abuse',
			'User-Agent: Example Feedback Loop/1.0',
			`Original-Mail-From: ${originalMailFrom}`,
			`Original-Rcpt-To: ${RECIPIENT}`,
			'--arf--',
			'',
		].join('\r\n')
	);
}

describe('feedback durability through the real bounce pipeline', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		process.env['BOUNCE_VERP_KEY'] = VERP_KEY;
		redis = new Redis();
		await redis.flushall();
		vi.clearAllMocks();
	});

	afterEach(async () => {
		delete process.env['BOUNCE_VERP_KEY'];
		await redis.quit();
	});

	it('retries the same complaint after a 451 and deduplicates only after outbox persistence', async () => {
		await recordFeedbackProvenance(redis, {
			messageId: MESSAGE_ID,
			to: RECIPIENT,
			organizationId: 'org-feedback',
			deliveryDomain: 'production',
			headers: {},
		} as EmailJob);
		mocks.queueConvexWebhook
			.mockRejectedValueOnce(new Error('outbox unavailable'))
			.mockResolvedValueOnce('outbox-feedback');
		const handler = buildOnData(config(), redis as unknown as RealRedis, {} as never);
		const signedReturnPath = buildVerpAddress(MESSAGE_ID, 'bounces.owlat.test', VERP_KEY);
		const message = arfMessage(signedReturnPath);
		const smtpSession = session(signedReturnPath);

		expect(await handler(message, smtpSession)).toMatchObject({ code: 451, enhanced: '4.3.0' });
		const [ownedKey] = await redis.keys('mta:fbl:dedup:owned-v2:*');
		expect(await redis.hget(ownedKey!, 'status')).toBe('retryable');
		expect(await handler(message, smtpSession)).toBeUndefined();
		expect(await redis.hget(ownedKey!, 'status')).toBe('completed');
		expect(await handler(message, smtpSession)).toBeUndefined();
		expect(mocks.queueConvexWebhook).toHaveBeenCalledTimes(2);
	});

	it('returns 451 for signed attribution when provenance Redis is unavailable', async () => {
		const signedReturnPath = buildVerpAddress(MESSAGE_ID, 'bounces.owlat.test', VERP_KEY);
		const redisWithFailedProvenance = new Proxy(redis, {
			get(target, property, receiver) {
				if (property === 'get') {
					return async (key: string) => {
						if (key.startsWith('mta:{feedback}:message:')) throw new Error('Redis unavailable');
						return target.get(key);
					};
				}
				const value = Reflect.get(target, property, receiver) as unknown;
				return typeof value === 'function' ? value.bind(target) : value;
			},
		}) as unknown as RealRedis;
		const handler = buildOnData(config(), redisWithFailedProvenance, {} as never);

		expect(await handler(arfMessage(signedReturnPath), session(signedReturnPath))).toMatchObject({
			code: 451,
			enhanced: '4.3.0',
		});
		const [ownedKey] = await redis.keys('mta:fbl:dedup:owned-v2:*');
		expect(await redis.hget(ownedKey!, 'status')).toBe('retryable');
		expect(mocks.queueConvexWebhook).not.toHaveBeenCalled();
	});

	it('ACKs malformed and unattributed feedback during the same provenance get outage', async () => {
		const redisWithFailedReads = new Proxy(redis, {
			get(target, property, receiver) {
				if (property === 'get') return async () => Promise.reject(new Error('Redis unavailable'));
				const value = Reflect.get(target, property, receiver) as unknown;
				return typeof value === 'function' ? value.bind(target) : value;
			},
		}) as unknown as RealRedis;
		const handler = buildOnData(config(), redisWithFailedReads, {} as never);
		const malformed = Buffer.from(
			'From: attacker@example.test\r\nSubject: invalid\r\n\r\nnot a DSN'
		);
		const forgedUnsignedReturnPath = `bounce+${Buffer.from('forged-message').toString('base64url')}@bounces.owlat.test`;

		expect(await handler(malformed, session('bounce+invalid@bounces.owlat.test'))).toBeUndefined();
		expect(
			await handler(arfMessage(forgedUnsignedReturnPath), session(forgedUnsignedReturnPath))
		).toBeUndefined();
		expect(mocks.queueConvexWebhook).not.toHaveBeenCalled();
	});
});

describe('a mailed unsubscribe through the real bounce listener', () => {
	let redis: InstanceType<typeof Redis>;
	const now = Date.now();

	function unsubscribeMail(): Buffer {
		return Buffer.from(
			'From: reader@example.net\r\nTo: unsubscribe@owlat.test\r\nSubject: unsubscribe\r\n\r\nPlease remove me.\r\n'
		);
	}

	async function outcomeCount(outcome: string): Promise<number> {
		const metric = await unsubscribeMailTotal.get();
		return metric.values.find((value) => value.labels['outcome'] === outcome)?.value ?? 0;
	}

	beforeEach(async () => {
		process.env['BOUNCE_VERP_KEY'] = VERP_KEY;
		redis = new Redis();
		await redis.flushall();
		vi.clearAllMocks();
		mocks.queueConvexWebhook.mockResolvedValue('outbox-unsubscribe');
	});

	afterEach(async () => {
		delete process.env['BOUNCE_VERP_KEY'];
		await redis.quit();
	});

	it('reports a valid address to Convex as one unsubscribe for the message it was minted for', async () => {
		const handler = buildOnData(config(), redis as unknown as RealRedis, {} as never);
		const address = buildUnsubscribeAddress(MESSAGE_ID, 'bounces.owlat.test', VERP_KEY, now)!;

		expect(await handler(unsubscribeMail(), session(address))).toBeUndefined();
		expect(await handler(unsubscribeMail(), session(address))).toBeUndefined();

		expect(mocks.queueConvexWebhook).toHaveBeenCalledTimes(2);
		const [event, , , idempotencyKey] = mocks.queueConvexWebhook.mock.calls[0]!;
		expect(event).toMatchObject({ event: 'unsubscribed', messageId: MESSAGE_ID });
		// The outbox slot is keyed by the message, so repeats collapse into one.
		expect(mocks.queueConvexWebhook.mock.calls[1]![3]).toBe(idempotencyKey);
		expect((event as { eventId: string }).eventId).toBe(
			(mocks.queueConvexWebhook.mock.calls[1]![0] as { eventId: string }).eventId
		);
	});

	it('accepts and drops a forged or expired address: no DSN, nothing told to Convex, counted', async () => {
		const handler = buildOnData(config(), redis as unknown as RealRedis, {} as never);
		const valid = buildUnsubscribeAddress(MESSAGE_ID, 'bounces.owlat.test', VERP_KEY, now)!;
		const forged = valid.replace(/\+[A-Za-z0-9_-]{14}@/, '+AAAAAAAAAAAAAA@');
		const expired = buildUnsubscribeAddress(
			MESSAGE_ID,
			'bounces.owlat.test',
			VERP_KEY,
			now - 100 * 24 * 60 * 60 * 1000
		)!;
		const invalidBefore = await outcomeCount('invalid');
		const expiredBefore = await outcomeCount('expired');

		expect(await handler(unsubscribeMail(), session(forged))).toBeUndefined();
		expect(await handler(unsubscribeMail(), session(expired))).toBeUndefined();

		expect(mocks.queueConvexWebhook).not.toHaveBeenCalled();
		expect(await outcomeCount('invalid')).toBe(invalidBefore + 1);
		expect(await outcomeCount('expired')).toBe(expiredBefore + 1);
	});

	it('asks the sender to retry when the outbox cannot take the request', async () => {
		mocks.queueConvexWebhook.mockRejectedValueOnce(new Error('outbox unavailable'));
		const handler = buildOnData(config(), redis as unknown as RealRedis, {} as never);
		const address = buildUnsubscribeAddress(MESSAGE_ID, 'bounces.owlat.test', VERP_KEY, now)!;

		expect(await handler(unsubscribeMail(), session(address))).toMatchObject({
			code: 451,
			enhanced: '4.3.0',
		});
	});
});
