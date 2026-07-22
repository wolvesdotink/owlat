import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import {
	runSmtpSecondaryEffect,
	finalizeSmtpOutcome,
	markSmtpEffectsApplied,
	reserveSmtpOutcome,
	SMTP_OUTCOME_JOURNAL_TTL_MS,
	smtpOutcomeJournalKeys,
} from '../smtpOutcomeJournal.js';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import type { CtxWithIp } from '../../dispatch/types.js';

function attempt(messageId: string): CtxWithIp {
	return {
		job: {
			messageId,
			to: 'recipient@example.com',
			from: 'sender@example.org',
			subject: 'Subject',
			html: '<p>Body</p>',
			ipPool: 'transactional',
			organizationId: 'org-1',
			dkimDomain: 'example.org',
		},
		domain: 'example.com',
		destination: {
			recipientDomain: 'example.com',
			providerKey: 'other',
			throttleKey: 'example.com',
			mx: {
				status: 'deliverable',
				source: 'mx',
				hosts: [{ exchange: 'mx.example.com', priority: 0 }],
			},
			daneDiscoveryAuthenticated: true,
		},
		fromDomain: 'example.org',
		pool: 'transactional',
		dedicatedIp: undefined,
		ip: '192.0.2.1',
		eligibilityGeneration: 1,
	};
}

const deliveredOutcome = {
	kind: 'delivered',
	smtpCode: 250,
	smtpResponse: undefined,
	remoteMessageId: 'remote-1',
	enhancedCode: undefined,
} as const;
const deliveredReduction = { effects: [], defer: undefined };

describe('SMTP outcome journal', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
	});

	it('terminalizes to a retained tombstone while releasing journal capacity', async () => {
		const fresh = await reserveSmtpOutcome(redis, 'job-1', 'message-1', attempt('message-1'), {
			now: 100,
			capacity: 10,
		});
		expect(fresh.kind).toBe('fresh');
		if (fresh.kind !== 'fresh') return;
		expect(fresh.raw).not.toContain('<p>Body</p>');
		expect(fresh.entry.attempt).not.toHaveProperty('job');
		const completed = await finalizeSmtpOutcome(
			redis,
			fresh.entry,
			fresh.raw,
			{ success: true, smtpCode: 250, remoteMessageId: 'remote-1' },
			42,
			deliveredOutcome,
			deliveredReduction,
			{ now: 142 }
		);
		const replay = await reserveSmtpOutcome(redis, 'job-1', 'message-1', attempt('message-1'), {
			now: 200,
			capacity: 10,
		});
		expect(replay).toMatchObject({
			kind: 'existing',
			entry: { state: 'completed', durationMs: 42, result: { remoteMessageId: 'remote-1' } },
		});
		await markSmtpEffectsApplied(redis, completed.entry, completed.raw, { now: 200 });
		expect(
			await reserveSmtpOutcome(redis, 'job-1', 'message-1', attempt('message-1'), {
				now: 300,
				capacity: 10,
			})
		).toMatchObject({ kind: 'existing', entry: { state: 'effects_applied' } });
		expect(await redis.zcard(smtpOutcomeJournalKeys.index)).toBe(0);
		expect(await redis.pttl(smtpOutcomeJournalKeys.journalKey('job-1'))).toBeGreaterThan(
			GOVERNED_MTA_MAX_MESSAGE_AGE_MS
		);
		expect(
			await reserveSmtpOutcome(redis, 'job-2', 'message-2', attempt('message-2'), {
				now: 300,
				capacity: 1,
			})
		).toMatchObject({ kind: 'fresh' });
	});

	it('checkpoints each successful secondary effect with the same bounded lifetime', async () => {
		const fresh = await reserveSmtpOutcome(redis, 'job-1', 'message-1', attempt('message-1'), {
			now: 100,
			capacity: 10,
		});
		if (fresh.kind !== 'fresh') throw new Error('expected fresh reservation');
		const completed = await finalizeSmtpOutcome(
			redis,
			fresh.entry,
			fresh.raw,
			{ success: true, smtpCode: 250 },
			42,
			deliveredOutcome,
			deliveredReduction,
			{ now: 142 }
		);
		const apply = vi.fn().mockResolvedValue('recorded');
		expect(
			await runSmtpSecondaryEffect(redis, completed.entry, completed.raw, '0:metrics_record', apply)
		).toBe('recorded');
		expect(
			await runSmtpSecondaryEffect(redis, completed.entry, completed.raw, '0:metrics_record', apply)
		).toBeUndefined();
		expect(apply).toHaveBeenCalledOnce();
		expect(await redis.pttl(smtpOutcomeJournalKeys.effectCheckpointsKey('job-1'))).toBeGreaterThan(
			GOVERNED_MTA_MAX_MESSAGE_AGE_MS
		);
	});

	it('retries a secondary effect after its pending-checkpoint response is lost', async () => {
		const fresh = await reserveSmtpOutcome(redis, 'job-1', 'message-1', attempt('message-1'), {
			now: 100,
			capacity: 10,
		});
		if (fresh.kind !== 'fresh') throw new Error('expected fresh reservation');
		const completed = await finalizeSmtpOutcome(
			redis,
			fresh.entry,
			fresh.raw,
			{ success: true, smtpCode: 250 },
			42,
			deliveredOutcome,
			deliveredReduction,
			{ now: 142 }
		);
		const originalEval = redis.eval.bind(redis);
		const evalSpy = vi.spyOn(redis, 'eval').mockImplementation(async (...args: unknown[]) => {
			const result = await (originalEval as (...inner: unknown[]) => Promise<unknown>)(...args);
			if (String(args[0]).includes("'pending:'")) throw new Error('checkpoint response lost');
			return result;
		});
		const apply = vi.fn().mockResolvedValue(undefined);

		await expect(
			runSmtpSecondaryEffect(redis, completed.entry, completed.raw, '0:metrics_record', apply, {
				leaseMs: 50,
				waitMs: 1,
			})
		).rejects.toThrow('Effect checkpoint could not be started');
		expect(apply).not.toHaveBeenCalled();
		evalSpy.mockRestore();
		await new Promise((resolve) => setTimeout(resolve, 55));
		await runSmtpSecondaryEffect(redis, completed.entry, completed.raw, '0:metrics_record', apply, {
			leaseMs: 1000,
			waitMs: 1,
		});
		expect(apply).toHaveBeenCalledOnce();
	});

	it('takes over expired crash leases without accepting non-finite expiries', async () => {
		const fresh = await reserveSmtpOutcome(redis, 'job-1', 'message-1', attempt('message-1'), {
			now: 100,
			capacity: 10,
		});
		if (fresh.kind !== 'fresh') throw new Error('expected fresh reservation');
		const completed = await finalizeSmtpOutcome(
			redis,
			fresh.entry,
			fresh.raw,
			{ success: true, smtpCode: 250 },
			42,
			deliveredOutcome,
			deliveredReduction,
			{ now: 142 }
		);
		await redis.hset(
			smtpOutcomeJournalKeys.effectCheckpointsKey('job-1'),
			'0:domain_throttle_success',
			`pending:crashed-worker:${Date.now() - 1}`
		);
		const apply = vi.fn().mockResolvedValue(undefined);

		await runSmtpSecondaryEffect(
			redis,
			completed.entry,
			completed.raw,
			'0:domain_throttle_success',
			apply
		);
		expect(apply).toHaveBeenCalledOnce();

		const invalidExpiryApply = vi.fn().mockResolvedValue(undefined);
		await redis.hset(
			smtpOutcomeJournalKeys.effectCheckpointsKey('job-1'),
			'1:smtp_response',
			'pending:forged-worker:Infinity'
		);
		await runSmtpSecondaryEffect(
			redis,
			completed.entry,
			completed.raw,
			'1:smtp_response',
			invalidExpiryApply
		);
		expect(invalidExpiryApply).toHaveBeenCalledOnce();
	});

	it('serializes concurrent processors that share the same durable owner', async () => {
		const fresh = await reserveSmtpOutcome(redis, 'job-1', 'message-1', attempt('message-1'), {
			now: 100,
			capacity: 10,
		});
		if (fresh.kind !== 'fresh') throw new Error('expected fresh reservation');
		const completed = await finalizeSmtpOutcome(
			redis,
			fresh.entry,
			fresh.raw,
			{ success: true, smtpCode: 250 },
			42,
			deliveredOutcome,
			deliveredReduction,
			{ now: 142 }
		);
		let finishFirst!: () => void;
		const firstCanFinish = new Promise<void>((resolve) => {
			finishFirst = resolve;
		});
		const apply = vi.fn(async () => firstCanFinish);
		const options = { leaseMs: 5_000, waitMs: 1 };
		const first = runSmtpSecondaryEffect(
			redis,
			completed.entry,
			completed.raw,
			'0:circuit_breaker_outcome',
			apply,
			options
		);
		await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
		const contender = runSmtpSecondaryEffect(
			redis,
			completed.entry,
			completed.raw,
			'0:circuit_breaker_outcome',
			apply,
			options
		);
		// Give the contender time to observe the active owned lease and wait.
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(apply).toHaveBeenCalledOnce();

		finishFirst();
		await Promise.all([first, contender]);
		expect(apply).toHaveBeenCalledOnce();
	});

	it('recovers after one transient heartbeat renewal failure', async () => {
		const fresh = await reserveSmtpOutcome(
			redis,
			'job-renew',
			'message-renew',
			attempt('message-renew'),
			{
				now: 100,
				capacity: 10,
			}
		);
		if (fresh.kind !== 'fresh') throw new Error('expected fresh reservation');
		const completed = await finalizeSmtpOutcome(
			redis,
			fresh.entry,
			fresh.raw,
			{ success: true, smtpCode: 250 },
			42,
			deliveredOutcome,
			deliveredReduction,
			{ now: 142 }
		);
		const originalEval = redis.eval.bind(redis);
		let renewalCalls = 0;
		const evalSpy = vi.spyOn(redis, 'eval').mockImplementation(async (...args: unknown[]) => {
			const script = String(args[0]);
			const isRenewal = script.includes(
				'pendingEffectLease(ARGV[4], tonumber(ARGV[5]), tonumber(ARGV[6]))'
			);
			if (isRenewal && renewalCalls++ === 0) throw new Error('transient renewal outage');
			return (originalEval as (...inner: unknown[]) => Promise<unknown>)(...args);
		});
		// Keep the synthetic lease comfortably above scheduler jitter from the
		// repository-wide parallel suite while still spanning multiple heartbeats:
		// the first renewal fails, a later one succeeds, and completion observes
		// that renewed ownership. Production uses the much larger 60-second lease.
		const apply = vi.fn(async () => new Promise((resolve) => setTimeout(resolve, 1_100)));

		await expect(
			runSmtpSecondaryEffect(redis, completed.entry, completed.raw, '0:renew-recovery', apply, {
				leaseMs: 900,
				waitMs: 1,
			})
		).resolves.toBeUndefined();
		expect(renewalCalls).toBeGreaterThanOrEqual(2);
		evalSpy.mockRestore();
	});

	it('completes when a heartbeat renewal committed but its response was lost', async () => {
		const fresh = await reserveSmtpOutcome(
			redis,
			'job-lost-renew',
			'message-lost-renew',
			attempt('message-lost-renew'),
			{
				now: 100,
				capacity: 10,
			}
		);
		if (fresh.kind !== 'fresh') throw new Error('expected fresh reservation');
		const completed = await finalizeSmtpOutcome(
			redis,
			fresh.entry,
			fresh.raw,
			{ success: true, smtpCode: 250 },
			42,
			deliveredOutcome,
			deliveredReduction,
			{ now: 142 }
		);
		const originalEval = redis.eval.bind(redis);
		let lost = false;
		const evalSpy = vi.spyOn(redis, 'eval').mockImplementation(async (...args: unknown[]) => {
			const result = await (originalEval as (...inner: unknown[]) => Promise<unknown>)(...args);
			if (
				!lost &&
				String(args[0]).includes(
					'pendingEffectLease(ARGV[4], tonumber(ARGV[5]), tonumber(ARGV[6]))'
				)
			) {
				lost = true;
				throw new Error('renewal response lost');
			}
			return result;
		});
		const apply = vi.fn(async () => new Promise((resolve) => setTimeout(resolve, 50)));

		await expect(
			runSmtpSecondaryEffect(redis, completed.entry, completed.raw, '0:lost-renewal', apply, {
				leaseMs: 90,
				waitMs: 1,
			})
		).resolves.toBeUndefined();
		expect(lost).toBe(true);
		evalSpy.mockRestore();
	});

	it('retries a secondary effect after the effect rejects', async () => {
		const fresh = await reserveSmtpOutcome(redis, 'job-1', 'message-1', attempt('message-1'), {
			now: 100,
			capacity: 10,
		});
		if (fresh.kind !== 'fresh') throw new Error('expected fresh reservation');
		const completed = await finalizeSmtpOutcome(
			redis,
			fresh.entry,
			fresh.raw,
			{ success: true, smtpCode: 250 },
			42,
			deliveredOutcome,
			deliveredReduction,
			{ now: 142 }
		);
		const apply = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error('effect unavailable'))
			.mockResolvedValueOnce(undefined);

		await expect(
			runSmtpSecondaryEffect(redis, completed.entry, completed.raw, '0:warming_record', apply)
		).rejects.toThrow('effect unavailable');
		await runSmtpSecondaryEffect(redis, completed.entry, completed.raw, '0:warming_record', apply);
		expect(apply).toHaveBeenCalledTimes(2);
	});

	it('does not repeat an effect when the applied-checkpoint response is lost', async () => {
		const fresh = await reserveSmtpOutcome(redis, 'job-1', 'message-1', attempt('message-1'), {
			now: 100,
			capacity: 10,
		});
		if (fresh.kind !== 'fresh') throw new Error('expected fresh reservation');
		const completed = await finalizeSmtpOutcome(
			redis,
			fresh.entry,
			fresh.raw,
			{ success: true, smtpCode: 250 },
			42,
			deliveredOutcome,
			deliveredReduction,
			{ now: 142 }
		);
		const originalEval = redis.eval.bind(redis);
		const evalSpy = vi.spyOn(redis, 'eval').mockImplementation(async (...args: unknown[]) => {
			const result = await (originalEval as (...inner: unknown[]) => Promise<unknown>)(...args);
			if (String(args[0]).includes("HSET', KEYS[2], ARGV[2], 'applied'")) {
				throw new Error('completion response lost');
			}
			return result;
		});
		const apply = vi.fn().mockResolvedValue(undefined);

		await expect(
			runSmtpSecondaryEffect(
				redis,
				completed.entry,
				completed.raw,
				'0:circuit_breaker_outcome',
				apply
			)
		).rejects.toThrow('Effect checkpoint could not be completed');
		evalSpy.mockRestore();
		await runSmtpSecondaryEffect(
			redis,
			completed.entry,
			completed.raw,
			'0:circuit_breaker_outcome',
			apply
		);
		expect(apply).toHaveBeenCalledOnce();
	});

	it('fails closed at capacity without evicting an unresolved reservation', async () => {
		await reserveSmtpOutcome(redis, 'job-1', 'message-1', attempt('message-1'), {
			now: Date.now(),
			capacity: 1,
		});
		expect(
			await reserveSmtpOutcome(redis, 'job-2', 'message-2', attempt('message-2'), {
				now: Date.now(),
				capacity: 1,
			})
		).toEqual({ kind: 'capacity' });
		expect(
			await reserveSmtpOutcome(redis, 'job-1', 'message-1', attempt('message-1'), {
				now: Date.now(),
				capacity: 1,
			})
		).toMatchObject({ kind: 'existing', entry: { state: 'in_flight' } });
	});

	it('rejects a queue identity rebound to another message', async () => {
		await reserveSmtpOutcome(redis, 'job-1', 'message-1', attempt('message-1'), {
			now: Date.now(),
			capacity: 10,
		});
		await expect(
			reserveSmtpOutcome(redis, 'job-1', 'forged-message', attempt('forged-message'), {
				now: Date.now(),
				capacity: 10,
			})
		).rejects.toThrow('bound to another queue job');
	});

	it('rejects malformed immutable attempt snapshots', async () => {
		await expect(
			reserveSmtpOutcome(redis, 'job-1', 'message-1', { ip: '192.0.2.1' } as never, {
				now: Date.now(),
				capacity: 10,
			})
		).rejects.toThrow('invalid attempt snapshot');
	});

	it('keeps an in-flight reservation beyond the governed queue horizon', async () => {
		await reserveSmtpOutcome(redis, 'slow-smtp', 'message-1', attempt('message-1'), {
			now: Date.now(),
			capacity: 10,
		});
		expect(SMTP_OUTCOME_JOURNAL_TTL_MS).toBeGreaterThan(GOVERNED_MTA_MAX_MESSAGE_AGE_MS);
		expect(await redis.pttl(smtpOutcomeJournalKeys.journalKey('slow-smtp'))).toBeGreaterThan(
			GOVERNED_MTA_MAX_MESSAGE_AGE_MS
		);
	});
});
