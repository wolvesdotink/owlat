import { beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import {
	clearSmtpOutcome,
	finalizeSmtpOutcome,
	reserveSmtpOutcome,
	SMTP_OUTCOME_JOURNAL_TTL_MS,
	smtpOutcomeJournalKeys,
} from '../smtpOutcomeJournal.js';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';

describe('SMTP outcome journal', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
	});

	it('stores and replays one exact completed result until it is cleared', async () => {
		const fresh = await reserveSmtpOutcome(redis, 'job-1', 'message-1', {
			now: 100,
			capacity: 10,
		});
		expect(fresh.kind).toBe('fresh');
		if (fresh.kind !== 'fresh') return;
		const completed = await finalizeSmtpOutcome(
			redis,
			fresh.entry,
			fresh.raw,
			{ success: true, smtpCode: 250, remoteMessageId: 'remote-1' },
			42,
			{ now: 142 }
		);
		const replay = await reserveSmtpOutcome(redis, 'job-1', 'message-1', {
			now: 200,
			capacity: 10,
		});
		expect(replay).toMatchObject({
			kind: 'existing',
			entry: { state: 'completed', durationMs: 42, result: { remoteMessageId: 'remote-1' } },
		});
		expect(await clearSmtpOutcome(redis, completed.entry, completed.raw)).toBe(true);
		expect(
			await reserveSmtpOutcome(redis, 'job-1', 'message-1', {
				now: 300,
				capacity: 10,
			})
		).toMatchObject({ kind: 'fresh' });
	});

	it('fails closed at capacity without evicting an unresolved reservation', async () => {
		await reserveSmtpOutcome(redis, 'job-1', 'message-1', {
			now: Date.now(),
			capacity: 1,
		});
		expect(
			await reserveSmtpOutcome(redis, 'job-2', 'message-2', {
				now: Date.now(),
				capacity: 1,
			})
		).toEqual({ kind: 'capacity' });
		expect(
			await reserveSmtpOutcome(redis, 'job-1', 'message-1', {
				now: Date.now(),
				capacity: 1,
			})
		).toMatchObject({ kind: 'existing', entry: { state: 'in_flight' } });
	});

	it('rejects a queue identity rebound to another message', async () => {
		await reserveSmtpOutcome(redis, 'job-1', 'message-1', {
			now: Date.now(),
			capacity: 10,
		});
		await expect(
			reserveSmtpOutcome(redis, 'job-1', 'forged-message', {
				now: Date.now(),
				capacity: 10,
			})
		).rejects.toThrow('bound to another queue job');
	});

	it('keeps an in-flight reservation beyond the governed queue horizon', async () => {
		await reserveSmtpOutcome(redis, 'slow-smtp', 'message-1', {
			now: Date.now(),
			capacity: 10,
		});
		expect(SMTP_OUTCOME_JOURNAL_TTL_MS).toBeGreaterThan(GOVERNED_MTA_MAX_MESSAGE_AGE_MS);
		expect(await redis.pttl(smtpOutcomeJournalKeys.journalKey('slow-smtp'))).toBeGreaterThan(
			GOVERNED_MTA_MAX_MESSAGE_AGE_MS
		);
	});
});
