/**
 * Outcome classification (smtp/send/outcome.ts): how a structured SmtpError
 * from one attempt becomes a delivery result — 5xx hard, 5.2.2 soft, 4xx
 * deferred, a client refusal, a next-MX connection failure, and the post-DATA
 * ambiguity that must never be auto-retried.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';

// Every sendToMx suite stubs the same seams — transport, pool, MX/DANE/STS
// discovery, DKIM keys, logger — so the mock set is built once in
// helpers/senderHarness.ts and registered here.
const harness = await vi.hoisted(async () => {
	const { createSenderHarness } = await import('./helpers/senderHarness.js');
	return createSenderHarness();
});

vi.mock('../../scaling/ipPool.js', () => harness.ipPoolModule());
vi.mock('@owlat/smtp-client', async (importOriginal) =>
	harness.smtpClientModule(await importOriginal<Record<string, unknown>>())
);
vi.mock('../connectionPool.js', () => harness.connectionPoolModule());
vi.mock('../mxResolver.js', () => harness.mxResolverModule());
vi.mock('../daneMxResolver.js', () => harness.daneMxResolverModule());
vi.mock('../mtaSts.js', async (importOriginal) =>
	harness.mtaStsModule(await importOriginal<Record<string, unknown>>())
);
vi.mock('../dkim.js', () => harness.dkimModule());
vi.mock('../daneResolver.js', () => harness.daneResolverModule());
vi.mock('../../bounce/verp.js', () => harness.verpModule());
vi.mock('../../queue/groups.js', () => harness.queueGroupsModule());
vi.mock('../../monitoring/logger.js', () => harness.loggerModule());

const {
	connectMock,
	sendEnvelopeMock,
	acquireMock,
	releaseMock,
	evictConnectionMock,
	leaseValidMock,
} = harness;

import { sendToMx } from '../sender.js';
import type { MtaConfig } from '../../config.js';
import {
	createConfig,
	createJob,
	installSenderDefaults,
	liveConn,
	okReply,
	smtpError,
} from './helpers/senderFixtures.js';

describe('sendToMx outcome classification', () => {
	let redis: InstanceType<typeof Redis>;
	let config: MtaConfig;

	beforeEach(async () => {
		vi.clearAllMocks();
		redis = new Redis();
		await redis.flushall();
		config = createConfig();
		installSenderDefaults(harness);
	});

	it('returns success with remoteMessageId parsed from response', async () => {
		sendEnvelopeMock.mockResolvedValue({
			accepted: [],
			rejected: [],
			response: okReply('2.0.0 OK <remote-id@mx.example.com>'),
		});

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(true);
		expect(result.smtpCode).toBe(250);
		expect(result.remoteMessageId).toBe('remote-id@mx.example.com');
	});

	it('returns hard bounce on 5xx SMTP error and stops trying', async () => {
		sendEnvelopeMock.mockRejectedValue(
			smtpError({
				phase: 'rcpt',
				message: '550 5.1.1 User unknown',
				replyCode: 550,
				secured: true,
			})
		);

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('hard');
		expect(result.smtpCode).toBe(550);
		// A 5xx is a permanent verdict on the recipient — never retry the next MX.
		expect(sendEnvelopeMock).toHaveBeenCalledTimes(1);
	});

	it('returns soft bounce for 5.2.2 (mailbox full) despite 5xx code', async () => {
		sendEnvelopeMock.mockRejectedValue(
			smtpError({
				phase: 'rcpt',
				message: '552 5.2.2 Mailbox full',
				replyCode: 552,
				enhancedCode: '5.2.2',
				secured: true,
			})
		);

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('soft');
		expect(result.smtpCode).toBe(552);
		expect(result.enhancedCode).toBe('5.2.2');
	});

	it('returns hard bounce on an SMTPUTF8 client refusal and stops trying (X3)', async () => {
		// The envelope is internationalized but the MX did not advertise SMTPUTF8, so
		// the client fails closed with a phase-`mail` refusal carrying no reply code.
		// There is no ASCII downgrade for a UTF-8 local-part, so this is permanent —
		// a HARD bounce, and the next MX is never tried.
		sendEnvelopeMock.mockRejectedValue(
			smtpError({
				phase: 'mail',
				message:
					'server does not advertise SMTPUTF8 (RFC 6531); refusing to send an internationalized envelope address',
				secured: true,
				clientRefusal: 'smtputf8-unavailable',
			})
		);

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('hard');
		// A reply-less client refusal carries no SMTP code — but is still terminal.
		expect(result.smtpCode).toBeUndefined();
		expect(sendEnvelopeMock).toHaveBeenCalledTimes(1);
	});

	it('returns deferred on 4xx SMTP error', async () => {
		sendEnvelopeMock.mockRejectedValue(
			smtpError({ phase: 'mail', message: '451 4.7.1 Try later', replyCode: 451, secured: true })
		);

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('deferred');
		expect(result.smtpCode).toBe(451);
	});

	it('tries next MX host on connection error', async () => {
		// A reply-less, tls-less connect failure is a connection-level error.
		connectMock
			.mockRejectedValueOnce(
				smtpError({ phase: 'connect', message: 'ECONNREFUSED', secured: false })
			)
			.mockResolvedValue(liveConn(true));

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(true);
		expect(connectMock).toHaveBeenCalledTimes(2); // tried both MX
		expect(sendEnvelopeMock).toHaveBeenCalledTimes(1); // only the second delivered
	});

	it('returns soft bounce when all MX hosts fail with connection errors', async () => {
		connectMock.mockRejectedValue(
			smtpError({ phase: 'connect', message: 'ECONNREFUSED', secured: false })
		);

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('soft');
		expect(connectMock).toHaveBeenCalledTimes(2);
	});

	describe('ambiguous post-DATA failure is never auto-retried (W8 AMBIGUOUS_TIMEOUT)', () => {
		for (const phase of ['data', 'data-final'] as const) {
			it(`phase '${phase}' with no server reply → non-retryable, no next-MX attempt`, async () => {
				// The body (and possibly the terminating dot) was already written, so the
				// receiver MAY have accepted the message. Retrying risks a double delivery.
				sendEnvelopeMock.mockRejectedValue(
					smtpError({ phase, message: 'connection dropped after DATA', secured: true })
				);

				const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

				expect(result.success).toBe(false);
				// Its OWN terminal `ambiguous` classification — NOT a `hard` bounce (which
				// would suppress the recipient + fabricate a 550) and NOT a retryable
				// soft/deferred bounce that requeues. No smtpCode: there was no reply.
				expect(result.bounceType).toBe('ambiguous');
				expect(result.bounceType).not.toBe('hard');
				expect(result.bounceType).not.toBe('soft');
				expect(result.bounceType).not.toBe('deferred');
				expect(result.smtpCode).toBeUndefined();
				// Attempted on exactly ONE MX — the loop never advanced to the second.
				expect(sendEnvelopeMock).toHaveBeenCalledTimes(1);
				expect(connectMock).toHaveBeenCalledTimes(1);
			});
		}

		it('a data-final failure WITH a reply code is classified by the code (deferred), not ambiguous', async () => {
			// A real 4xx at DATA-final is a DEFINITIVE deferral (retryable), proving the
			// ambiguous guard fires only on reply-LESS drops.
			sendEnvelopeMock.mockRejectedValue(
				smtpError({
					phase: 'data-final',
					message: '451 4.7.1 Try later',
					replyCode: 451,
					secured: true,
				})
			);

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.bounceType).toBe('deferred');
			expect(result.smtpCode).toBe(451);
		});
	});
});
