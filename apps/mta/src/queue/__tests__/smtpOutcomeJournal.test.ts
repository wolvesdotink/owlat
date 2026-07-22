import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import {
	claimSmtpSecondaryEffect,
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

	it('claims each secondary effect once with the same bounded lifetime', async () => {
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
		expect(
			await claimSmtpSecondaryEffect(redis, completed.entry, completed.raw, '0:metrics_record')
		).toBe(true);
		expect(
			await claimSmtpSecondaryEffect(redis, completed.entry, completed.raw, '0:metrics_record')
		).toBe(false);
		expect(await redis.pttl(smtpOutcomeJournalKeys.effectClaimsKey('job-1'))).toBeGreaterThan(
			GOVERNED_MTA_MAX_MESSAGE_AGE_MS
		);
	});

	it('treats a lost secondary-claim response as already claimed on replay', async () => {
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
			if (String(args[0]).includes("HSETNX', KEYS[2]")) throw new Error('claim response lost');
			return result;
		});

		await expect(
			claimSmtpSecondaryEffect(redis, completed.entry, completed.raw, '0:metrics_record')
		).rejects.toThrow('claim response lost');
		evalSpy.mockRestore();
		expect(
			await claimSmtpSecondaryEffect(redis, completed.entry, completed.raw, '0:metrics_record')
		).toBe(false);
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
