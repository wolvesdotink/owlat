/**
 * DATA-phase durability fence (smtp/send/dataJournal.ts) at the envelope
 * boundary: where a worker may disappear during an attempt, what the journal
 * records at each step, and that a resumed attempt never double-delivers.
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
import type { SmtpConnection } from '@owlat/smtp-client';
import type { EmailJob } from '../../types.js';
import type { CtxWithIp } from '../../dispatch/types.js';
import { runJournaledSmtpAttempt } from '../../queue/journaledSmtpAttempt.js';
import { reserveSmtpOutcome, smtpOutcomeJournalKeys } from '../../queue/smtpOutcomeJournal.js';
import { createConfig, createJob, installSenderDefaults } from './helpers/senderFixtures.js';

describe('sendToMx DATA journal boundary', () => {
	let redis: InstanceType<typeof Redis>;
	let config: MtaConfig;

	beforeEach(async () => {
		vi.clearAllMocks();
		redis = new Redis();
		await redis.flushall();
		config = createConfig();
		installSenderDefaults(harness);
	});

	function createAttempt(job: EmailJob): CtxWithIp {
		return {
			job,
			domain: 'example.com',
			destination: {
				recipientDomain: 'example.com',
				providerKey: 'other',
				throttleKey: 'example.com',
				mx: {
					status: 'deliverable',
					source: 'mx',
					hosts: [
						{ exchange: 'mx1.example.com', priority: 10 },
						{ exchange: 'mx2.example.com', priority: 20 },
					],
				},
				daneDiscoveryAuthenticated: true,
			},
			fromDomain: 'owlat.com',
			pool: 'transactional',
			dedicatedIp: undefined,
			ip: '10.0.0.1',
			eligibilityGeneration: 1,
		};
	}

	describe('SMTP outcome journal envelope boundary', () => {
		const journalKey = smtpOutcomeJournalKeys.journalKey('job-sender-boundary');
		const neverCompletes = new Promise<never>(() => {});

		async function runJournaled(job: EmailJob) {
			return runJournaledSmtpAttempt({
				redis,
				config,
				jobId: 'job-sender-boundary',
				job,
				eligibilityLease: { ip: '10.0.0.1', eligibilityGeneration: 1 },
				attempt: createAttempt(job),
				startedAt: Date.now(),
			});
		}

		async function journalPhase(): Promise<unknown> {
			const raw = await redis.get(journalKey);
			return raw ? (JSON.parse(raw) as { phase?: unknown }).phase : undefined;
		}

		it('retries after a worker disappears before opening the SMTP connection', async () => {
			const job = createJob();
			let connectionAttempted!: () => void;
			const reachedConnection = new Promise<void>((resolve) => {
				connectionAttempted = resolve;
			});
			connectMock.mockImplementationOnce(async () => {
				connectionAttempted();
				return neverCompletes;
			});

			void runJournaled(job);
			await reachedConnection;
			expect(await journalPhase()).toBe('pre_data');

			await expect(runJournaled(job)).resolves.toMatchObject({
				kind: 'completed',
				journal: { entry: { state: 'completed', result: { success: true } } },
			});
			expect(sendEnvelopeMock).toHaveBeenCalledOnce();
		});

		it('retries after a worker disappears after 354 but before the DATA body', async () => {
			const job = createJob();
			let dataAccepted!: () => void;
			const reachedDataBoundary = new Promise<void>((resolve) => {
				dataAccepted = resolve;
			});
			sendEnvelopeMock.mockImplementationOnce(async () => {
				// The smtp-client contract invokes beforeDataBodyWrite only after 354.
				// Leaving it uncalled models interruption in the instruction gap
				// immediately before the body write.
				dataAccepted();
				return neverCompletes;
			});

			void runJournaled(job);
			await reachedDataBoundary;
			expect(await journalPhase()).toBe('pre_data');

			await expect(runJournaled(job)).resolves.toMatchObject({
				kind: 'completed',
				journal: { entry: { state: 'completed', result: { success: true } } },
			});
			expect(sendEnvelopeMock).toHaveBeenCalledTimes(2);
		});

		it('does not resend after the body boundary when the final reply is never observed', async () => {
			const job = createJob();
			let bodyWritten!: () => void;
			const reachedMissingFinalReply = new Promise<void>((resolve) => {
				bodyWritten = resolve;
			});
			sendEnvelopeMock.mockImplementationOnce(
				async (
					_conn: SmtpConnection,
					options: { beforeDataBodyWrite?: () => void | Promise<void> }
				) => {
					await options.beforeDataBodyWrite?.();
					bodyWritten();
					return neverCompletes;
				}
			);

			void runJournaled(job);
			await reachedMissingFinalReply;
			expect(await journalPhase()).toBe('uncertain');

			await expect(runJournaled(job)).resolves.toMatchObject({
				kind: 'completed',
				journal: {
					entry: {
						state: 'completed',
						result: { success: false, bounceType: 'ambiguous' },
					},
				},
			});
			expect(sendEnvelopeMock).toHaveBeenCalledOnce();
		});

		it('treats a legacy phase-less in-flight reservation as uncertain', async () => {
			const job = createJob();
			const legacy = await reserveSmtpOutcome(
				redis,
				'job-sender-boundary',
				job.messageId,
				createAttempt(job),
				{ now: Date.now(), capacity: config.smtpOutcomeJournalMaxSize }
			);
			if (legacy.kind !== 'fresh') throw new Error('expected fresh reservation');
			const legacyEntry = JSON.parse(legacy.raw) as Record<string, unknown>;
			delete legacyEntry['phase'];
			await redis.set(journalKey, JSON.stringify(legacyEntry));

			await expect(runJournaled(job)).resolves.toMatchObject({
				kind: 'completed',
				journal: {
					entry: {
						state: 'completed',
						result: { success: false, bounceType: 'ambiguous' },
					},
				},
			});
			expect(sendEnvelopeMock).not.toHaveBeenCalled();
		});
	});
});
