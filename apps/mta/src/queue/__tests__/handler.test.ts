import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Queue, ReservedJob } from 'groupmq';

vi.mock('../../smtp/sender.js', () => ({ sendToMx: vi.fn() }));
vi.mock('../../smtp/destinationProvider.js', () => ({
	resolveDestinationSnapshot: vi.fn(async (_redis: unknown, domain: string) => ({
		recipientDomain: domain,
		providerKey: 'other',
		throttleKey: domain,
		mx: {
			status: 'deliverable',
			source: 'mx',
			hosts: [{ exchange: `mx.${domain}`, priority: 0 }],
		},
		daneDiscoveryAuthenticated: true,
	})),
}));
vi.mock('../../intelligence/circuitBreaker.js', () => ({
	canSend: vi.fn().mockResolvedValue({ allowed: true, state: 'closed', generation: 0 }),
	canSendScope: vi.fn().mockResolvedValue({ allowed: true, state: 'closed', generation: 0 }),
	releaseHalfOpenProbe: vi.fn().mockResolvedValue(undefined),
	reserveHalfOpenProbe: vi.fn().mockResolvedValue(true),
	recordOutcome: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../intelligence/domainThrottle.js', () => ({
	acquireSlot: vi.fn().mockResolvedValue(true),
	recordSuccess: vi.fn().mockResolvedValue(undefined),
	recordDefer: vi.fn().mockResolvedValue(undefined),
	recordReject: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../intelligence/smtpResponse.js', () => ({
	shouldDefer: vi.fn().mockResolvedValue(0),
	recordResponse: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../intelligence/warming.js', () => ({
	checkCap: vi.fn().mockResolvedValue({ allowed: true, sentToday: 0, dailyCap: Infinity }),
	ensureWarmingReservation: vi.fn(),
	releaseWarmingSlot: vi.fn().mockResolvedValue(undefined),
	recordSend: vi.fn().mockResolvedValue(undefined),
	recordBounce: vi.fn().mockResolvedValue(undefined),
	recordDeferral: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../intelligence/suppressionList.js', () => ({
	isSuppressed: vi.fn().mockResolvedValue(false),
	suppress: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../intelligence/orgLimits.js', () => ({
	checkAndIncrement: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('../../intelligence/contentScreening.js', () => ({
	screenContent: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('../../scaling/ipPool.js', () => ({
	selectIpWithLease: vi.fn().mockResolvedValue({ ip: '10.0.0.1', eligibilityGeneration: 1 }),
	isIpEligibilityLeaseValid: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../scaling/poolRules.js', () => ({
	resolvePool: vi.fn().mockResolvedValue({ pool: 'transactional' }),
}));
vi.mock('../../scaling/degradation.js', () => ({
	shouldBackoffDomain: vi.fn().mockResolvedValue({ backoff: false }),
	recordDomainFailure: vi.fn().mockResolvedValue(undefined),
	clearDomainFailure: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../monitoring/collector.js', () => ({
	registry: { registerMetric: vi.fn() },
	emailsSentTotal: { inc: vi.fn() },
	record: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../monitoring/deliveryLogger.js', () => ({
	logDeliveryEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleEmailJob } from '../handler.js';
import type { EmailJob } from '../../types.js';
import type { MtaConfig } from '../../config.js';

function createJob(overrides: Partial<EmailJob> = {}): EmailJob {
	return {
		messageId: 'msg-001',
		to: 'user@example.com',
		from: 'sender@owlat.com',
		subject: 'Test',
		html: '<p>Hello</p>',
		ipPool: 'transactional',
		organizationId: 'org-1',
		dkimDomain: 'owlat.com',
		firstEnqueuedAt: Date.now(),
		...overrides,
	};
}

function createGovernedJob(overrides: Partial<EmailJob> = {}): EmailJob {
	return createJob({
		deliveryDomain: 'production',
		routingLease: {
			token: 'lease-1',
			destinationProvider: 'other',
			probe: true,
			globalProbe: true,
			ip: '10.0.0.1',
			eligibilityGeneration: 1,
			globalBreakerGeneration: 0,
			providerBreakerGeneration: 0,
		},
		routingReentry: {
			envelopeInput: { kind: 'transactional' },
			retryState: { attempt: 1, startedAt: Date.now(), idempotencyKey: 'msg-001' },
		},
		routingReentryToken: 'reentry-token',
		workAttemptId: 'work-attempt-1',
		...overrides,
	});
}

/**
 * Wrap an EmailJob in the GroupMQ ReservedJob envelope the worker hands the
 * handler. `attempts` / `maxAttempts` / `timestamp` mirror the real reserve.
 */
function reserve(
	data: EmailJob,
	envelope: Partial<ReservedJob<EmailJob>> = {}
): ReservedJob<EmailJob> {
	return {
		id: 'job-1',
		groupId: 'transactional:example.com',
		data,
		attempts: 0,
		maxAttempts: 5,
		seq: 1,
		timestamp: data.firstEnqueuedAt ?? Date.now(),
		orderMs: 0,
		score: 0,
		deadlineAt: 0,
		...envelope,
	};
}

/**
 * A queue stub exposing only the `add` the handler uses for defer re-enqueue.
 * `add` returns a fake Job-shaped object — the handler ignores the return.
 */
function createQueueStub(): Pick<Queue<EmailJob>, 'add'> & { add: ReturnType<typeof vi.fn> } {
	return {
		add: vi.fn().mockResolvedValue({ id: 'requeued-1' }),
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
		webhookSecret: 'secret',
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
		maxMessageAgeMs: 4 * 24 * 60 * 60 * 1000, // 4 days
		...overrides,
	};
}

/**
 * Assert a jittered delay falls within ±15% of the base value.
 * Matches the withJitter() helper in handler.ts (jitterFactor in [0.85, 1.15]).
 */
function expectJitteredDelay(actual: number, base: number) {
	expect(actual).toBeGreaterThanOrEqual(Math.round(base * 0.85));
	expect(actual).toBeLessThanOrEqual(Math.round(base * 1.15));
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('handleEmailJob', () => {
	let redis: InstanceType<typeof Redis>;
	let config: MtaConfig;
	let queue: ReturnType<typeof createQueueStub>;

	beforeEach(async () => {
		vi.resetAllMocks();
		redis = new Redis();
		config = createConfig();
		queue = createQueueStub();

		// Re-establish default mock implementations after resetAllMocks
		const sender = await import('../../smtp/sender.js');
		vi.mocked(sender.sendToMx).mockResolvedValue({
			success: true,
			smtpCode: 250,
			smtpResponse: '250 OK',
			remoteMessageId: 'default-remote-id@mx.example.com',
		});

		const cb = await import('../../intelligence/circuitBreaker.js');
		vi.mocked(cb.canSend).mockResolvedValue({ allowed: true, state: 'closed', generation: 0 });
		vi.mocked(cb.canSendScope).mockResolvedValue({
			allowed: true,
			state: 'closed',
			generation: 0,
		});
		vi.mocked(cb.releaseHalfOpenProbe).mockResolvedValue(undefined);
		vi.mocked(cb.reserveHalfOpenProbe).mockResolvedValue(true);
		vi.mocked(cb.recordOutcome).mockResolvedValue(undefined);

		const dt = await import('../../intelligence/domainThrottle.js');
		vi.mocked(dt.acquireSlot).mockResolvedValue(true);
		vi.mocked(dt.recordSuccess).mockResolvedValue(undefined);
		vi.mocked(dt.recordDefer).mockResolvedValue(undefined);
		vi.mocked(dt.recordReject).mockResolvedValue(undefined);

		const smtp = await import('../../intelligence/smtpResponse.js');
		vi.mocked(smtp.shouldDefer).mockResolvedValue(0);
		vi.mocked(smtp.recordResponse).mockResolvedValue(undefined);

		const warm = await import('../../intelligence/warming.js');
		vi.mocked(warm.checkCap).mockResolvedValue({ allowed: true, sentToday: 0, dailyCap: Infinity });
		vi.mocked(warm.ensureWarmingReservation).mockResolvedValue({ allowed: true });
		vi.mocked(warm.releaseWarmingSlot).mockResolvedValue(undefined);
		vi.mocked(warm.recordSend).mockResolvedValue(undefined);
		vi.mocked(warm.recordBounce).mockResolvedValue(undefined);
		vi.mocked(warm.recordDeferral).mockResolvedValue(undefined);

		const supp = await import('../../intelligence/suppressionList.js');
		vi.mocked(supp.isSuppressed).mockResolvedValue(false);
		vi.mocked(supp.suppress).mockResolvedValue(undefined);

		const org = await import('../../intelligence/orgLimits.js');
		vi.mocked(org.checkAndIncrement).mockResolvedValue({ allowed: true });

		const cs = await import('../../intelligence/contentScreening.js');
		vi.mocked(cs.screenContent).mockResolvedValue({ allowed: true });

		const ip = await import('../../scaling/ipPool.js');
		vi.mocked(ip.selectIpWithLease).mockResolvedValue({
			ip: '10.0.0.1',
			eligibilityGeneration: 1,
		});
		vi.mocked(ip.isIpEligibilityLeaseValid).mockResolvedValue(true);

		const pr = await import('../../scaling/poolRules.js');
		vi.mocked(pr.resolvePool).mockResolvedValue({ pool: 'transactional' });

		const deg = await import('../../scaling/degradation.js');
		vi.mocked(deg.shouldBackoffDomain).mockResolvedValue({ backoff: false });
		vi.mocked(deg.recordDomainFailure).mockResolvedValue(undefined);
		vi.mocked(deg.clearDomainFailure).mockResolvedValue(undefined);

		const wh = await import('../../webhooks/convexNotifier.js');
		vi.mocked(wh.notifyConvex).mockResolvedValue(true);

		const mc = await import('../../monitoring/collector.js');
		vi.mocked(mc.record).mockResolvedValue(undefined);

		const dl = await import('../../monitoring/deliveryLogger.js');
		vi.mocked(dl.logDeliveryEvent).mockResolvedValue(undefined);
	});

	function run(data: EmailJob, envelope: Partial<ReservedJob<EmailJob>> = {}) {
		return handleEmailJob(
			reserve(data, envelope),
			queue as unknown as Queue<EmailJob>,
			redis,
			config
		);
	}

	it('delivers successfully and records to all systems', async () => {
		const { sendToMx } = await import('../../smtp/sender.js');
		const { recordOutcome } = await import('../../intelligence/circuitBreaker.js');
		const { recordSuccess } = await import('../../intelligence/domainThrottle.js');
		const { recordSend } = await import('../../intelligence/warming.js');
		const { notifyConvex } = await import('../../webhooks/convexNotifier.js');
		const { clearDomainFailure } = await import('../../scaling/degradation.js');

		vi.mocked(sendToMx).mockResolvedValue({
			success: true,
			smtpCode: 250,
			smtpResponse: '250 OK <remote-id@mx.example.com>',
			remoteMessageId: 'remote-id@mx.example.com',
		});

		await run(createJob());

		expect(sendToMx).toHaveBeenCalled();
		expect(recordOutcome).toHaveBeenCalledWith(
			redis,
			'org-1',
			'delivered',
			config,
			'other',
			undefined
		);
		expect(recordSuccess).toHaveBeenCalled();
		expect(recordSend).toHaveBeenCalled();
		expect(clearDomainFailure).toHaveBeenCalled();
		expect(notifyConvex).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'sent', messageId: 'msg-001' }),
			config,
			redis
		);
		// A delivered job is never re-enqueued.
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('releases test reservations without recording production warming or breaker usage', async () => {
		const { recordOutcome, releaseHalfOpenProbe } =
			await import('../../intelligence/circuitBreaker.js');
		const { recordSend, releaseWarmingSlot } = await import('../../intelligence/warming.js');
		const reservation = {
			ip: '10.0.0.1',
			messageId: 'msg-001',
			utcDate: '2026-07-22',
			expiresAt: Date.now() + 60_000,
		};
		await run(
			createGovernedJob({
				deliveryDomain: 'member_test',
				routingLease: {
					...createGovernedJob().routingLease!,
					warmingReservation: reservation,
				},
			})
		);

		expect(recordOutcome).not.toHaveBeenCalled();
		expect(recordSend).not.toHaveBeenCalled();
		expect(releaseWarmingSlot).toHaveBeenCalledWith(redis, reservation);
		expect(releaseHalfOpenProbe).toHaveBeenCalledTimes(2);
	});

	it('defers without acquiring SMTP when the selected IP is quarantined after selection', async () => {
		const { sendToMx } = await import('../../smtp/sender.js');
		const { isIpEligibilityLeaseValid } = await import('../../scaling/ipPool.js');
		vi.mocked(isIpEligibilityLeaseValid).mockResolvedValueOnce(false);

		await run(createJob());

		expect(sendToMx).not.toHaveBeenCalled();
		expect(queue.add).toHaveBeenCalledOnce();
		expect(queue.add).toHaveBeenCalledWith(expect.objectContaining({ delay: expect.any(Number) }));
	});

	it.each(['production', 'member_test'] as const)(
		'hands a %s governed job back to Convex when IP eligibility changes, without SMTP',
		async (deliveryDomain) => {
			const { sendToMx } = await import('../../smtp/sender.js');
			const { isIpEligibilityLeaseValid } = await import('../../scaling/ipPool.js');
			const { notifyConvex } = await import('../../webhooks/convexNotifier.js');
			const { releaseHalfOpenProbe } = await import('../../intelligence/circuitBreaker.js');
			vi.mocked(isIpEligibilityLeaseValid).mockResolvedValueOnce(false);

			await run(createGovernedJob({ deliveryDomain }));

			expect(sendToMx).not.toHaveBeenCalled();
			expect(queue.add).not.toHaveBeenCalled();
			expect(releaseHalfOpenProbe).toHaveBeenCalledTimes(2);
			expect(notifyConvex).toHaveBeenCalledWith(
				expect.objectContaining({
					event: 'routing.reentry',
					messageId: 'msg-001',
					routingReentry: expect.objectContaining({
						retryState: expect.objectContaining({ idempotencyKey: 'msg-001' }),
					}),
				}),
				config,
				redis
			);
		}
	);

	it('hands a stale breaker generation back to Convex instead of relay/self-requeue', async () => {
		const { canSend } = await import('../../intelligence/circuitBreaker.js');
		const { sendToMx } = await import('../../smtp/sender.js');
		const { notifyConvex } = await import('../../webhooks/convexNotifier.js');
		vi.mocked(canSend).mockResolvedValue({ allowed: true, state: 'closed', generation: 2 });

		await run(createGovernedJob());

		expect(sendToMx).not.toHaveBeenCalled();
		expect(queue.add).not.toHaveBeenCalled();
		expect(notifyConvex).toHaveBeenCalledWith(
			expect.objectContaining({
				event: 'routing.reentry',
				routingReentryReason: 'circuit_breaker_changed',
			}),
			config,
			redis
		);
	});

	it('routes a cross-midnight full warming cap back to Convex and releases its old slot', async () => {
		const { ensureWarmingReservation, releaseWarmingSlot } =
			await import('../../intelligence/warming.js');
		const { sendToMx } = await import('../../smtp/sender.js');
		const oldReservation = {
			ip: '10.0.0.1',
			messageId: 'msg-001',
			utcDate: '2026-07-21',
			expiresAt: Date.now() - 1,
		};
		vi.mocked(ensureWarmingReservation).mockResolvedValue({
			allowed: false,
			sentToday: 50,
			dailyCap: 50,
		});

		await run(
			createGovernedJob({
				routingLease: {
					...createGovernedJob().routingLease!,
					warmingReservation: oldReservation,
				},
			})
		);

		expect(sendToMx).not.toHaveBeenCalled();
		expect(queue.add).not.toHaveBeenCalled();
		expect(releaseWarmingSlot).toHaveBeenCalledWith(redis, oldReservation);
	});

	it('rejects when content screening fails', async () => {
		const { screenContent } = await import('../../intelligence/contentScreening.js');
		const { sendToMx } = await import('../../smtp/sender.js');
		const { logDeliveryEvent } = await import('../../monitoring/deliveryLogger.js');
		const { notifyConvex } = await import('../../webhooks/convexNotifier.js');

		vi.mocked(screenContent).mockResolvedValue({ allowed: false, reason: 'empty_body' });

		await run(createJob());

		expect(sendToMx).not.toHaveBeenCalled();
		expect(queue.add).not.toHaveBeenCalled();
		expect(logDeliveryEvent).toHaveBeenCalledWith(
			redis,
			expect.objectContaining({ status: 'screened', provider: 'other' }),
			config
		);
		expect(notifyConvex).toHaveBeenCalledWith(
			expect.objectContaining({
				event: 'failed',
				errorCode: 'CONTENT_SCREENED',
			}),
			config,
			redis
		);
	});

	it('skips suppressed recipients', async () => {
		const { isSuppressed } = await import('../../intelligence/suppressionList.js');
		const { sendToMx } = await import('../../smtp/sender.js');
		const { logDeliveryEvent } = await import('../../monitoring/deliveryLogger.js');
		const { notifyConvex } = await import('../../webhooks/convexNotifier.js');

		vi.mocked(isSuppressed).mockResolvedValue(true);

		await run(createJob());

		expect(sendToMx).not.toHaveBeenCalled();
		expect(queue.add).not.toHaveBeenCalled();
		expect(logDeliveryEvent).toHaveBeenCalledWith(
			redis,
			expect.objectContaining({ status: 'suppressed', provider: 'other' }),
			config
		);
		expect(notifyConvex).toHaveBeenCalledWith(
			expect.objectContaining({
				event: 'failed',
				errorCode: 'RECIPIENT_SUPPRESSED',
			}),
			config,
			redis
		);
	});

	it('handles hard bounce — suppresses recipient and notifies Convex', async () => {
		const { sendToMx } = await import('../../smtp/sender.js');
		const { suppress } = await import('../../intelligence/suppressionList.js');
		const { notifyConvex } = await import('../../webhooks/convexNotifier.js');

		vi.mocked(sendToMx).mockResolvedValue({
			success: false,
			bounceType: 'hard',
			smtpCode: 550,
			error: '550 5.1.1 User unknown',
		});

		await run(createJob());

		expect(suppress).toHaveBeenCalledWith(redis, 'user@example.com', 'hard_bounce');
		expect(notifyConvex).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'bounced', bounceType: 'hard' }),
			config,
			redis
		);
		expect(queue.add).not.toHaveBeenCalled();
	});

	// ── PR-04 (1): honor the computed per-category retry delay on re-enqueue ──
	// The delay must be the classifier's suggestedDelayMs (±jitter), NOT the
	// worker's static 30000*4^attempt exponential backoff.

	it('PR-04 (a): rate-limited (451 slow down) re-enqueues at ~900000ms, not the static backoff', async () => {
		const { sendToMx } = await import('../../smtp/sender.js');

		vi.mocked(sendToMx).mockResolvedValue({
			success: false,
			bounceType: 'deferred',
			smtpCode: 451,
			error: '451 4.7.1 slow down — too many messages',
		});

		await run(createJob(), { attempts: 4 });

		expect(queue.add).toHaveBeenCalledTimes(1);
		const opts = queue.add.mock.calls[0]![0];
		expect(opts.groupId).toBe('transactional:example.com');
		expectJitteredDelay(opts.delay as number, 900_000);
		// Must NOT match the dead static backoff 30000*4^attempt (= 7_680_000 capped at 7_200_000).
		expect(opts.delay).toBeLessThan(7_200_000);
	});

	it('PR-04 (a): greylist "try again in 300 seconds" re-enqueues at ~300000ms', async () => {
		const { sendToMx } = await import('../../smtp/sender.js');

		vi.mocked(sendToMx).mockResolvedValue({
			success: false,
			bounceType: 'deferred',
			smtpCode: 451,
			error: '451 4.7.1 greylisted, please try again in 300 seconds',
		});

		await run(createJob());

		expect(queue.add).toHaveBeenCalledTimes(1);
		const opts = queue.add.mock.calls[0]![0];
		expectJitteredDelay(opts.delay as number, 300_000);
	});

	it('PR-04 (a): soft bounce re-enqueues at ~60000ms', async () => {
		const { sendToMx } = await import('../../smtp/sender.js');

		vi.mocked(sendToMx).mockResolvedValue({
			success: false,
			bounceType: 'soft',
			error: 'All MX hosts failed for example.com',
		});

		await run(createJob());

		expect(queue.add).toHaveBeenCalledTimes(1);
		expectJitteredDelay(queue.add.mock.calls[0]![0].delay as number, 60_000);
	});

	// ── PR-04 (2): self-throttle defers re-enqueue WITHOUT burning an attempt ──
	// Pre-send pipeline defers (breaker / org-limit / smtp-intel / domain
	// throttle / warming cap / no-IP) re-enqueue with the computed delay and
	// the handler RESOLVES (no throw) so GroupMQ does not increment attempts.

	it('PR-04 (b): warming cap reached re-enqueues (300000ms) and does not throw', async () => {
		const { checkCap } = await import('../../intelligence/warming.js');
		vi.mocked(checkCap).mockResolvedValue({ allowed: false, sentToday: 50, dailyCap: 50 });

		await expect(run(createJob())).resolves.toBeUndefined();

		expect(queue.add).toHaveBeenCalledTimes(1);
		expectJitteredDelay(queue.add.mock.calls[0]![0].delay as number, 300_000);
	});

	it('PR-04 (b): warming-capped 5x in a row stays retryable (re-enqueued, never dead-lettered)', async () => {
		const { checkCap } = await import('../../intelligence/warming.js');
		vi.mocked(checkCap).mockResolvedValue({ allowed: false, sentToday: 50, dailyCap: 50 });

		// Simulate five consecutive self-throttle defers. Because the handler
		// re-enqueues instead of throwing, none consume a delivery attempt — so
		// even at attempts=4 (the last before maxAttempts=5) it still re-queues.
		for (let attempt = 0; attempt < 5; attempt++) {
			queue.add.mockClear();
			await expect(run(createJob(), { attempts: attempt })).resolves.toBeUndefined();
			expect(queue.add).toHaveBeenCalledTimes(1);
		}
	});

	it('PR-04 (b): circuit breaker open re-enqueues with the cooldown delay, no throw', async () => {
		const { canSend } = await import('../../intelligence/circuitBreaker.js');
		vi.mocked(canSend).mockResolvedValue({ allowed: false, state: 'open', retryAfter: 60000 });

		await expect(run(createJob())).resolves.toBeUndefined();

		expect(queue.add).toHaveBeenCalledTimes(1);
		expectJitteredDelay(queue.add.mock.calls[0]![0].delay as number, 60000);
	});

	it('PR-04 (b): no IPs available re-enqueues (60000ms), no throw', async () => {
		const { selectIpWithLease } = await import('../../scaling/ipPool.js');
		vi.mocked(selectIpWithLease).mockResolvedValue(null);

		await expect(run(createJob())).resolves.toBeUndefined();

		expect(queue.add).toHaveBeenCalledTimes(1);
		expectJitteredDelay(queue.add.mock.calls[0]![0].delay as number, 60000);
	});

	it('PR-04 (2): re-enqueued job preserves the original firstEnqueuedAt across re-queues', async () => {
		const { checkCap } = await import('../../intelligence/warming.js');
		vi.mocked(checkCap).mockResolvedValue({ allowed: false, sentToday: 50, dailyCap: 50 });

		const firstEnqueuedAt = Date.now() - DAY_MS; // 1 day old, well under cap
		await run(createJob({ firstEnqueuedAt }));

		expect(queue.add).toHaveBeenCalledTimes(1);
		const requeuedData = queue.add.mock.calls[0]![0].data as EmailJob;
		expect(requeuedData.firstEnqueuedAt).toBe(firstEnqueuedAt);
	});

	// ── PR-04 (3): max message age give-up emits a terminal expired-bounce ──

	it('PR-04 (c): persistent 4xx on a 5-day-old message gives up — expired-bounce, no re-enqueue', async () => {
		const { sendToMx } = await import('../../smtp/sender.js');
		const { logDeliveryEvent } = await import('../../monitoring/deliveryLogger.js');
		const { notifyConvex } = await import('../../webhooks/convexNotifier.js');

		vi.mocked(sendToMx).mockResolvedValue({
			success: false,
			bounceType: 'deferred',
			smtpCode: 451,
			error: '451 4.7.1 greylisted, please try again later',
		});

		const firstEnqueuedAt = Date.now() - 5 * DAY_MS; // older than the 4-day cap
		await run(createJob({ firstEnqueuedAt }), { timestamp: firstEnqueuedAt });

		// Gave up: no re-enqueue.
		expect(queue.add).not.toHaveBeenCalled();
		// Terminal bounce notified to Convex.
		expect(notifyConvex).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'bounced' }),
			config,
			redis
		);
		// Delivery log records status 'expired'.
		expect(logDeliveryEvent).toHaveBeenCalledWith(
			redis,
			expect.objectContaining({
				status: 'expired',
				messageId: 'msg-001',
				provider: 'other',
			}),
			config
		);
	});

	it('expires at the exact shared four-day boundary', async () => {
		const { sendToMx } = await import('../../smtp/sender.js');
		const { notifyConvex } = await import('../../webhooks/convexNotifier.js');
		vi.mocked(sendToMx).mockResolvedValue({
			success: false,
			bounceType: 'deferred',
			smtpCode: 451,
			error: '451 4.7.1 retry later',
		});
		const firstEnqueuedAt = Date.now() - 4 * DAY_MS;
		await run(createJob({ firstEnqueuedAt }), { timestamp: firstEnqueuedAt });
		expect(sendToMx).toHaveBeenCalledOnce();
		expect(queue.add).not.toHaveBeenCalled();
		expect(notifyConvex).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'bounced' }),
			config,
			redis
		);
	});

	it('PR-04 (c): a 1-hour-old message under the same persistent 4xx is still retried', async () => {
		const { sendToMx } = await import('../../smtp/sender.js');
		const { notifyConvex } = await import('../../webhooks/convexNotifier.js');

		vi.mocked(sendToMx).mockResolvedValue({
			success: false,
			bounceType: 'deferred',
			smtpCode: 451,
			error: '451 4.7.1 greylisted, please try again later',
		});

		const firstEnqueuedAt = Date.now() - 60 * 60 * 1000; // 1 hour old
		await run(createJob({ firstEnqueuedAt }), { timestamp: firstEnqueuedAt });

		// Still retried: re-enqueued, no terminal bounce.
		expect(queue.add).toHaveBeenCalledTimes(1);
		expect(notifyConvex).not.toHaveBeenCalledWith(
			expect.objectContaining({ event: 'bounced' }),
			config,
			redis
		);
	});

	it('PR-04 (c): self-throttle defer also expires past max age', async () => {
		const { checkCap } = await import('../../intelligence/warming.js');
		const { logDeliveryEvent } = await import('../../monitoring/deliveryLogger.js');
		vi.mocked(checkCap).mockResolvedValue({ allowed: false, sentToday: 50, dailyCap: 50 });

		const firstEnqueuedAt = Date.now() - 5 * DAY_MS;
		await run(createJob({ firstEnqueuedAt }), { timestamp: firstEnqueuedAt });

		expect(queue.add).not.toHaveBeenCalled();
		expect(logDeliveryEvent).toHaveBeenCalledWith(
			redis,
			expect.objectContaining({ status: 'expired', provider: 'other' }),
			config
		);
	});

	it('PR-04 (c): legacy job without firstEnqueuedAt falls back to ReservedJob.timestamp for age', async () => {
		const { sendToMx } = await import('../../smtp/sender.js');
		const { logDeliveryEvent } = await import('../../monitoring/deliveryLogger.js');

		vi.mocked(sendToMx).mockResolvedValue({
			success: false,
			bounceType: 'deferred',
			smtpCode: 451,
			error: '451 4.7.1 try again later',
		});

		const legacy = createJob();
		delete legacy.firstEnqueuedAt;
		const oldTimestamp = Date.now() - 5 * DAY_MS;

		await run(legacy, { timestamp: oldTimestamp });

		expect(queue.add).not.toHaveBeenCalled();
		expect(logDeliveryEvent).toHaveBeenCalledWith(
			redis,
			expect.objectContaining({ status: 'expired', provider: 'other' }),
			config
		);
	});
});
