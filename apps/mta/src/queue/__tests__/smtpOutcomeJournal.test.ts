import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import {
	runSmtpSecondaryEffect,
	finalizeSmtpOutcome,
	markSmtpOutcomeUncertain,
	markSmtpEffectsApplied,
	readSmtpOutcome,
	reserveSmtpOutcome,
	SMTP_OUTCOME_JOURNAL_TTL_MS,
	smtpOutcomeJournalKeys,
} from '../smtpOutcomeJournal.js';
import { utcDateKey } from '../../intelligence/warmingKeys.js';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import type { CtxWithProviderPressure } from '../../dispatch/types.js';

function attempt(messageId: string): CtxWithProviderPressure {
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
		providerVolumePressure: 0,
		utcDate: '2026-03-01',
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

/**
 * The effect runner's clock on fake time: lease stamps (Date), contention
 * waits (setTimeout) and heartbeats (setInterval). The mock Redis keeps its own
 * scheduling, so lease transitions still run while time stands still.
 */
function useFakeLeaseClock(): void {
	vi.useFakeTimers({
		toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
	});
}

type LeaseCall = 'begin' | 'renew' | 'complete' | 'release';

/** A fragment unique to each lease transition script in lib/effectCheckpoint.ts. */
const LEASE_SCRIPT_MARKERS: ReadonlyArray<[LeaseCall, string]> = [
	['begin', 'inspectEffectLease(state, ARGV[5], tonumber(ARGV[4]))'],
	['renew', 'pendingEffectLease(ARGV[4], tonumber(ARGV[5]), tonumber(ARGV[6]))'],
	['complete', "redis.call('HSET', KEYS[2], ARGV[2], 'applied')"],
	['release', "redis.call('HDEL', KEYS[2], ARGV[2])"],
];

interface SettledLeaseCall {
	call: LeaseCall;
	result?: unknown;
	error?: unknown;
}

/**
 * Spy on the lease transitions the effect runner sends to Redis and record each
 * one as it settles. `fault` can fail a chosen call before it reaches Redis
 * (`'before'`) or after it committed, losing only the response (`'after'`).
 */
function watchLeaseCalls(
	redis: InstanceType<typeof Redis>,
	fault: (call: LeaseCall, index: number) => 'before' | 'after' | undefined = () => undefined
) {
	const settled: SettledLeaseCall[] = [];
	const waiters: Array<{ call: LeaseCall; n: number; resolve: () => void }> = [];
	const issued = new Map<LeaseCall, number>();
	const countOf = (call: LeaseCall) => settled.filter((entry) => entry.call === call).length;
	const record = (entry: SettledLeaseCall): void => {
		settled.push(entry);
		for (const waiter of waiters.filter((w) => countOf(w.call) >= w.n)) {
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve();
		}
	};
	const originalEval = redis.eval.bind(redis) as (...args: unknown[]) => Promise<unknown>;
	const spy = vi.spyOn(redis, 'eval').mockImplementation(async (...args: unknown[]) => {
		const script = String(args[0]);
		const call = LEASE_SCRIPT_MARKERS.find(([, marker]) => script.includes(marker))?.[0];
		if (!call) return originalEval(...args);
		const index = issued.get(call) ?? 0;
		issued.set(call, index + 1);
		const mode = fault(call, index);
		try {
			if (mode === 'before') throw new Error(`${call} unavailable`);
			const result = await originalEval(...args);
			if (mode === 'after') throw new Error(`${call} response lost`);
			record({ call, result });
			return result;
		} catch (error) {
			record({ call, error });
			throw error;
		}
	});
	return {
		of: (call: LeaseCall) => settled.filter((entry) => entry.call === call),
		/** Resolves once `n` calls of `call` have settled. */
		settled(call: LeaseCall, n: number): Promise<void> {
			if (countOf(call) >= n) return Promise.resolve();
			return new Promise((resolve) => waiters.push({ call, n, resolve }));
		},
		restore: () => spy.mockRestore(),
	};
}

/** The disposition code of a settled begin: 0 applied, 1 acquired, 2 busy. */
function beginDisposition(entry: SettledLeaseCall | undefined): unknown {
	return (entry?.result as unknown[] | undefined)?.[0];
}

/** An effect the test finishes by hand, with a promise for its start. */
function heldEffect() {
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	let finish!: () => void;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const apply = vi.fn(async () => {
		markStarted();
		await finished;
	});
	return { apply, started, finish };
}

describe('SMTP outcome journal', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('round-trips the per-provider volume pressure the reducer needs', async () => {
		const enriched = { ...attempt('message-1'), providerVolumePressure: 3 };
		const fresh = await reserveSmtpOutcome(redis, 'job-1', 'message-1', enriched, {
			now: 100,
			capacity: 10,
		});
		expect(fresh.kind).toBe('fresh');
		if (fresh.kind !== 'fresh') return;
		expect(fresh.entry.attempt.providerVolumePressure).toBe(3);

		const replay = await reserveSmtpOutcome(redis, 'job-1', 'message-1', enriched, {
			now: 200,
			capacity: 10,
		});
		expect(replay.kind).toBe('existing');
		if (replay.kind !== 'existing' || replay.entry.state !== 'in_flight') return;
		expect(replay.entry.attempt.providerVolumePressure).toBe(3);
	});

	it('replays an entry written before the pressure dimension existed', async () => {
		const { providerVolumePressure: _pressure, ...legacy } = attempt('message-legacy');
		const fresh = await reserveSmtpOutcome(redis, 'job-legacy', 'message-legacy', legacy as never, {
			now: 100,
			capacity: 10,
		});
		expect(fresh.kind).toBe('fresh');

		const replay = await reserveSmtpOutcome(
			redis,
			'job-legacy',
			'message-legacy',
			legacy as never,
			{ now: 200, capacity: 10 }
		);
		expect(replay.kind).toBe('existing');
		if (replay.kind !== 'existing' || replay.entry.state !== 'in_flight') return;
		// Absent, not invalid: the entry replays and reads as "no recorded pressure".
		expect(replay.entry.attempt.providerVolumePressure).toBe(0);
	});

	it('dates a legacy reservation’s warming day from the reservation, not the replaying clock', async () => {
		const { utcDate: _utcDate, ...legacy } = attempt('message-legacy');
		const reservedAt = Date.UTC(2026, 2, 14, 6, 0, 0);
		const fresh = await reserveSmtpOutcome(redis, 'job-legacy', 'message-legacy', legacy as never, {
			now: reservedAt,
			capacity: 10,
		});
		expect(fresh.kind).toBe('fresh');

		const replay = await reserveSmtpOutcome(
			redis,
			'job-legacy',
			'message-legacy',
			legacy as never,
			{ now: reservedAt + 3 * 24 * 60 * 60 * 1000, capacity: 10 }
		);
		expect(replay.kind).toBe('existing');
		if (replay.kind !== 'existing' || replay.entry.state !== 'in_flight') return;
		// The journal's own reading, never the wall clock the replay happens on —
		// the warming records this attempt books have to be stable across replays.
		expect(replay.entry.attempt.utcDate).toBe(utcDateKey(reservedAt));
	});

	it('dates a legacy completed entry from its completion reading', async () => {
		const { utcDate: _utcDate, ...legacy } = attempt('message-legacy');
		// The attempt straddles midnight, so the two readings name different days
		// and the completed path cannot pass by borrowing the reservation's.
		const reservedAt = Date.UTC(2026, 2, 14, 23, 59, 0);
		const completedAt = reservedAt + 120_000;
		const fresh = await reserveSmtpOutcome(redis, 'job-legacy', 'message-legacy', legacy as never, {
			now: reservedAt,
			capacity: 10,
		});
		if (fresh.kind !== 'fresh') throw new Error('expected fresh reservation');
		await finalizeSmtpOutcome(
			redis,
			fresh.entry,
			fresh.raw,
			{ success: true, smtpCode: 250 },
			42,
			deliveredOutcome,
			deliveredReduction,
			{ now: completedAt }
		);

		const replay = await reserveSmtpOutcome(
			redis,
			'job-legacy',
			'message-legacy',
			legacy as never,
			{ now: completedAt + 60_000, capacity: 10 }
		);
		expect(replay.kind).toBe('existing');
		if (replay.kind !== 'existing' || replay.entry.state !== 'completed') return;
		expect(replay.entry.attempt.utcDate).toBe(utcDateKey(completedAt));
		expect(utcDateKey(completedAt)).not.toBe(utcDateKey(reservedAt));
	});

	it('rejects a non-finite journal reading with its own error rather than a RangeError', async () => {
		const fresh = await reserveSmtpOutcome(redis, 'job-1', 'message-1', attempt('message-1'), {
			now: 100,
			capacity: 10,
		});
		if (fresh.kind !== 'fresh') throw new Error('expected fresh reservation');
		// JSON has no Infinity literal, but an overflowing exponent parses to one —
		// and `new Date(Infinity).toISOString()` throws past this module's guards.
		await redis.set(
			smtpOutcomeJournalKeys.journalKey('job-1'),
			fresh.raw.replace('"reservedAt":100', '"reservedAt":1e999')
		);
		await expect(readSmtpOutcome(redis, 'job-1', 'message-1')).rejects.toThrow(
			'SMTP outcome journal contains an invalid reservation'
		);

		await redis.set(smtpOutcomeJournalKeys.journalKey('job-1'), fresh.raw);
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
		await redis.set(
			smtpOutcomeJournalKeys.journalKey('job-1'),
			completed.raw.replace('"completedAt":142', '"completedAt":1e999')
		);
		await expect(readSmtpOutcome(redis, 'job-1', 'message-1')).rejects.toThrow(
			'SMTP outcome journal contains an invalid completed result'
		);
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

	it('atomically and idempotently marks the DATA body boundary without extending expiry', async () => {
		const fresh = await reserveSmtpOutcome(redis, 'job-1', 'message-1', attempt('message-1'), {
			now: Date.now(),
			capacity: 10,
		});
		if (fresh.kind !== 'fresh') throw new Error('expected fresh reservation');
		expect(fresh.entry.phase).toBe('pre_data');
		const ttlBefore = await redis.pttl(smtpOutcomeJournalKeys.journalKey('job-1'));

		const uncertain = await markSmtpOutcomeUncertain(redis, fresh.entry, fresh.raw);
		expect(uncertain.entry.phase).toBe('uncertain');
		expect(await markSmtpOutcomeUncertain(redis, fresh.entry, fresh.raw)).toEqual(uncertain);
		expect(await redis.pttl(smtpOutcomeJournalKeys.journalKey('job-1'))).toBeLessThanOrEqual(
			ttlBefore
		);

		const successorRaw = JSON.stringify({
			...uncertain.entry,
			reservationToken: 'successor-owner',
		});
		await redis.set(smtpOutcomeJournalKeys.journalKey('job-1'), successorRaw);
		await expect(markSmtpOutcomeUncertain(redis, fresh.entry, fresh.raw)).rejects.toThrow(
			'lost ownership'
		);
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
		useFakeLeaseClock();
		const leases = watchLeaseCalls(redis, (call, index) =>
			call === 'begin' && index === 0 ? 'after' : undefined
		);
		const apply = vi.fn().mockResolvedValue(undefined);

		await expect(
			runSmtpSecondaryEffect(redis, completed.entry, completed.raw, '0:metrics_record', apply, {
				leaseMs: 50,
				waitMs: 1,
			})
		).rejects.toThrow('Effect checkpoint could not be started');
		expect(apply).not.toHaveBeenCalled();

		// The lost begin still committed a 50 ms pending lease: a retry inside it
		// finds the lease busy and waits.
		const retry = runSmtpSecondaryEffect(
			redis,
			completed.entry,
			completed.raw,
			'0:metrics_record',
			apply,
			{ leaseMs: 1000, waitMs: 1 }
		);
		await leases.settled('begin', 2);
		expect(beginDisposition(leases.of('begin')[1])).toBe(2);
		expect(apply).not.toHaveBeenCalled();

		// Once that lease expires, the retry takes it over and applies the effect.
		await vi.advanceTimersByTimeAsync(50);
		await retry;
		expect(beginDisposition(leases.of('begin').at(-1))).toBe(1);
		expect(apply).toHaveBeenCalledOnce();
		leases.restore();
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
		useFakeLeaseClock();
		const leases = watchLeaseCalls(redis);
		const effect = heldEffect();
		const options = { leaseMs: 5_000, waitMs: 1 };
		const first = runSmtpSecondaryEffect(
			redis,
			completed.entry,
			completed.raw,
			'0:circuit_breaker_outcome',
			effect.apply,
			options
		);
		await effect.started;
		const contender = runSmtpSecondaryEffect(
			redis,
			completed.entry,
			completed.raw,
			'0:circuit_breaker_outcome',
			effect.apply,
			options
		);
		// The contender observes the active owned lease, waits, and asks again:
		// still busy, so it never applies.
		await leases.settled('begin', 2);
		await vi.advanceTimersByTimeAsync(options.waitMs);
		await leases.settled('begin', 3);
		expect(leases.of('begin').slice(1).map(beginDisposition)).toEqual([2, 2]);
		expect(effect.apply).toHaveBeenCalledOnce();

		effect.finish();
		await first;
		// The contender's next look finds the effect applied and stands down.
		await vi.advanceTimersByTimeAsync(options.waitMs);
		await contender;
		expect(beginDisposition(leases.of('begin').at(-1))).toBe(0);
		expect(effect.apply).toHaveBeenCalledOnce();
		leases.restore();
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
		// Heartbeats every 300 ms against a 900 ms lease. Only the second renewal
		// reaches Redis; the first and every later one fail before it. The effect
		// finishes at 1100 ms, past the original lease, so completion goes through
		// only on the ownership that second renewal extended.
		useFakeLeaseClock();
		const leases = watchLeaseCalls(redis, (call, index) =>
			call === 'renew' && index !== 1 ? 'before' : undefined
		);
		const effect = heldEffect();
		const run = runSmtpSecondaryEffect(
			redis,
			completed.entry,
			completed.raw,
			'0:renew-recovery',
			effect.apply,
			{ leaseMs: 900, waitMs: 1 }
		);
		await effect.started;
		await vi.advanceTimersByTimeAsync(600);
		await leases.settled('renew', 2);
		expect(leases.of('renew')[0]?.error).toBeInstanceOf(Error);
		expect(leases.of('renew')[1]?.result).toEqual(expect.any(Number));

		await vi.advanceTimersByTimeAsync(500);
		effect.finish();
		await expect(run).resolves.toBeUndefined();
		expect(leases.of('complete')).toEqual([{ call: 'complete', result: 1 }]);
		leases.restore();
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
		// Heartbeats every 30 ms against a 90 ms lease. The first renewal commits
		// but its response is lost; every later one fails before reaching Redis.
		// The effect finishes at 100 ms, past the original lease, so completion
		// goes through only on the lease the lost-response renewal extended.
		useFakeLeaseClock();
		const leases = watchLeaseCalls(redis, (call, index) => {
			if (call !== 'renew') return undefined;
			return index === 0 ? 'after' : 'before';
		});
		const effect = heldEffect();
		const run = runSmtpSecondaryEffect(
			redis,
			completed.entry,
			completed.raw,
			'0:lost-renewal',
			effect.apply,
			{ leaseMs: 90, waitMs: 1 }
		);
		await effect.started;
		await vi.advanceTimersByTimeAsync(100);
		await leases.settled('renew', 3);
		expect(leases.of('renew')[0]?.error).toMatchObject({ message: 'renew response lost' });

		effect.finish();
		await expect(run).resolves.toBeUndefined();
		expect(leases.of('complete')).toEqual([{ call: 'complete', result: 1 }]);
		leases.restore();
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
