/**
 * Durable uncertainty boundary around the irreversible SMTP transaction.
 *
 * A fresh reservation starts retry-safe. It becomes uncertain immediately
 * before the DATA body and terminator are written; only that phase replays as
 * ambiguous after worker interruption.
 */

import { createHash, randomUUID } from 'crypto';
import type Redis from 'ioredis';
import type { EmailJobResult } from '../types.js';
import type { CtxWithProviderPressure } from '../dispatch/types.js';
import type { DispatchOutcome, OutcomeReduction } from '../dispatch/outcome.js';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import { runCheckpointedEffect, type DurableEffectIdentity } from '../lib/effectCheckpoint.js';

const JOURNAL_INDEX_KEY = 'mta:{smtp-outcome}:expiries';
const JOURNAL_KEY_PREFIX = 'mta:{smtp-outcome}:job:';
export const SMTP_OUTCOME_JOURNAL_TTL_MS = GOVERNED_MTA_MAX_MESSAGE_AGE_MS + 24 * 60 * 60 * 1000;

export type SmtpAttemptSnapshot = Omit<CtxWithProviderPressure, 'job'>;

interface InFlightSmtpOutcome {
	state: 'in_flight';
	/**
	 * Missing only on reservations persisted before the DATA-boundary protocol.
	 * Legacy entries are treated as uncertain because they may already have sent
	 * the message body.
	 */
	phase?: 'pre_data' | 'uncertain';
	jobId: string;
	messageId: string;
	reservedAt: number;
	/** Unique CAS owner; absent only on legacy phase-less reservations. */
	reservationToken?: string;
	/** Immutable routing/reducer input captured before the SMTP transaction. */
	attempt: SmtpAttemptSnapshot;
}

interface CompletedSmtpOutcome {
	state: 'completed';
	jobId: string;
	messageId: string;
	result: EmailJobResult;
	durationMs: number;
	completedAt: number;
	attempt: SmtpAttemptSnapshot;
	outcome: DispatchOutcome;
	reduction: OutcomeReduction;
}

interface EffectsAppliedSmtpOutcome {
	state: 'effects_applied';
	jobId: string;
	messageId: string;
	appliedAt: number;
}

export type SmtpOutcomeJournalEntry =
	| InFlightSmtpOutcome
	| CompletedSmtpOutcome
	| EffectsAppliedSmtpOutcome;

export type SmtpOutcomeReservation =
	| { kind: 'fresh'; entry: InFlightSmtpOutcome; raw: string }
	| { kind: 'existing'; entry: SmtpOutcomeJournalEntry; raw: string }
	| { kind: 'capacity' };

const RESERVE_LUA = `
local existing = redis.call('GET', KEYS[1])
if existing then return {'existing', existing} end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[2])
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then return {'capacity', ''} end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[4])
redis.call('ZADD', KEYS[2], tonumber(ARGV[2]) + tonumber(ARGV[4]), KEYS[1])
return {'fresh', ARGV[1]}
`;

const FINALIZE_LUA = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  redis.call('ZADD', KEYS[2], tonumber(ARGV[4]) + tonumber(ARGV[3]), KEYS[1])
  return {1, ARGV[2]}
end
return {0, current or ''}
`;

const MARK_UNCERTAIN_LUA = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[2] then return {1, current} end
if current ~= ARGV[1] then return {0, current or ''} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then return {0, ''} end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
return {1, ARGV[2]}
`;

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], KEYS[1])
return 1
`;

const MARK_EFFECTS_APPLIED_LUA = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
	redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
	redis.call('ZREM', KEYS[2], KEYS[1])
	return {1, ARGV[2]}
end
return {0, current or ''}
`;

function journalKey(jobId: string): string {
	return `${JOURNAL_KEY_PREFIX}${createHash('sha256').update(jobId).digest('hex')}`;
}

function effectCheckpointsKey(jobId: string): string {
	return `mta:{smtp-outcome}:effects:${createHash('sha256').update(jobId).digest('hex')}`;
}

function parseEntry(raw: string): SmtpOutcomeJournalEntry {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error('SMTP outcome journal contains malformed JSON');
	}
	if (!value || typeof value !== 'object') {
		throw new Error('SMTP outcome journal contains an invalid entry');
	}
	const entry = value as Record<string, unknown>;
	if (
		entry['state'] !== 'in_flight' &&
		entry['state'] !== 'completed' &&
		entry['state'] !== 'effects_applied'
	) {
		throw new Error('SMTP outcome journal contains an invalid entry');
	}
	if (typeof entry['jobId'] !== 'string' || typeof entry['messageId'] !== 'string') {
		throw new Error('SMTP outcome journal contains an invalid entry');
	}
	if (entry['state'] === 'in_flight') {
		if (
			(entry['phase'] !== undefined &&
				entry['phase'] !== 'pre_data' &&
				entry['phase'] !== 'uncertain') ||
			(entry['phase'] !== undefined && typeof entry['reservationToken'] !== 'string') ||
			(entry['reservationToken'] !== undefined && typeof entry['reservationToken'] !== 'string') ||
			typeof entry['reservedAt'] !== 'number' ||
			!isAttemptSnapshot(entry['attempt'])
		) {
			throw new Error('SMTP outcome journal contains an invalid reservation');
		}
		normalizeAttemptSnapshot(entry['attempt']);
		return entry as unknown as InFlightSmtpOutcome;
	}
	if (entry['state'] === 'effects_applied') {
		if (typeof entry['appliedAt'] !== 'number') {
			throw new Error('SMTP outcome journal contains an invalid terminal tombstone');
		}
		return entry as unknown as EffectsAppliedSmtpOutcome;
	}
	if (
		!entry['result'] ||
		typeof entry['result'] !== 'object' ||
		typeof entry['durationMs'] !== 'number' ||
		typeof entry['completedAt'] !== 'number' ||
		!isAttemptSnapshot(entry['attempt']) ||
		!entry['outcome'] ||
		!entry['reduction']
	) {
		throw new Error('SMTP outcome journal contains an invalid completed result');
	}
	normalizeAttemptSnapshot(entry['attempt']);
	return entry as unknown as CompletedSmtpOutcome;
}

/** Fill in fields added after an entry was written, so a replay never sees a hole. */
function normalizeAttemptSnapshot(value: unknown): void {
	if (!value || typeof value !== 'object') return;
	const attempt = value as Record<string, unknown>;
	if (typeof attempt['providerVolumePressure'] !== 'number') {
		attempt['providerVolumePressure'] = 0;
	}
}

function isAttemptSnapshot(value: unknown): value is SmtpAttemptSnapshot {
	if (!value || typeof value !== 'object') return false;
	const attempt = value as Record<string, unknown>;
	if (
		typeof attempt['domain'] !== 'string' ||
		(attempt['fromDomain'] !== undefined && typeof attempt['fromDomain'] !== 'string') ||
		(attempt['pool'] !== 'transactional' && attempt['pool'] !== 'campaign') ||
		(attempt['dedicatedIp'] !== undefined && typeof attempt['dedicatedIp'] !== 'string') ||
		typeof attempt['ip'] !== 'string' ||
		typeof attempt['eligibilityGeneration'] !== 'number' ||
		!Number.isSafeInteger(attempt['eligibilityGeneration'])
	) {
		return false;
	}
	// Entries persisted before the per-provider pressure dimension carry no
	// counter. Tolerated rather than rejected — a legacy in-flight entry must
	// still replay — and normalized to zero by `normalizeAttemptSnapshot`.
	if (
		attempt['providerVolumePressure'] !== undefined &&
		typeof attempt['providerVolumePressure'] !== 'number'
	) {
		return false;
	}
	const destination = attempt['destination'];
	if (!destination || typeof destination !== 'object') return false;
	const route = destination as Record<string, unknown>;
	return (
		typeof route['recipientDomain'] === 'string' &&
		['gmail', 'microsoft', 'yahoo', 'apple', 'other'].includes(String(route['providerKey'])) &&
		typeof route['throttleKey'] === 'string' &&
		typeof route['daneDiscoveryAuthenticated'] === 'boolean' &&
		isMxSnapshot(route['mx']) &&
		(route['daneDestinations'] === undefined || Array.isArray(route['daneDestinations']))
	);
}

function isMxSnapshot(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false;
	const mx = value as Record<string, unknown>;
	if (mx['status'] === 'null-mx') return true;
	if (mx['status'] === 'domain-not-found' || mx['status'] === 'temporary-failure') {
		return typeof mx['reason'] === 'string';
	}
	return (
		mx['status'] === 'deliverable' &&
		(mx['source'] === 'mx' || mx['source'] === 'implicit') &&
		Array.isArray(mx['hosts']) &&
		mx['hosts'].length > 0 &&
		mx['hosts'].length <= 50 &&
		mx['hosts'].every(
			(host) =>
				!!host &&
				typeof host === 'object' &&
				typeof (host as Record<string, unknown>)['exchange'] === 'string' &&
				typeof (host as Record<string, unknown>)['priority'] === 'number' &&
				Number.isSafeInteger((host as Record<string, unknown>)['priority'])
		)
	);
}

export async function readSmtpOutcome(
	redis: Redis,
	jobId: string,
	messageId: string
): Promise<{ entry: SmtpOutcomeJournalEntry; raw: string } | null> {
	const raw = await redis.get(journalKey(jobId));
	if (!raw) return null;
	const entry = parseEntry(raw);
	assertBinding(entry, jobId, messageId);
	return { entry, raw };
}

function assertBinding(entry: SmtpOutcomeJournalEntry, jobId: string, messageId: string): void {
	if (entry.jobId !== jobId || entry.messageId !== messageId) {
		throw new Error('SMTP outcome journal is bound to another queue job');
	}
}

export async function reserveSmtpOutcome(
	redis: Redis,
	jobId: string,
	messageId: string,
	attempt: SmtpAttemptSnapshot,
	options: { now: number; capacity: number }
): Promise<SmtpOutcomeReservation> {
	if (!isAttemptSnapshot(attempt)) {
		throw new Error('SMTP outcome journal received an invalid attempt snapshot');
	}
	const entry: InFlightSmtpOutcome = {
		state: 'in_flight',
		phase: 'pre_data',
		jobId,
		messageId,
		reservedAt: options.now,
		reservationToken: randomUUID(),
		attempt: {
			domain: attempt.domain,
			destination: attempt.destination,
			fromDomain: attempt.fromDomain,
			pool: attempt.pool,
			dedicatedIp: attempt.dedicatedIp,
			ip: attempt.ip,
			eligibilityGeneration: attempt.eligibilityGeneration,
			providerVolumePressure: attempt.providerVolumePressure,
		},
	};
	const raw = JSON.stringify(entry);
	const result = (await redis.eval(
		RESERVE_LUA,
		2,
		journalKey(jobId),
		JOURNAL_INDEX_KEY,
		raw,
		String(options.now),
		String(options.capacity),
		String(SMTP_OUTCOME_JOURNAL_TTL_MS)
	)) as [string, string];
	if (result[0] === 'capacity') return { kind: 'capacity' };
	if (result[0] === 'fresh') return { kind: 'fresh', entry, raw };
	const existing = parseEntry(result[1]);
	assertBinding(existing, jobId, messageId);
	return { kind: 'existing', entry: existing, raw: result[1] };
}

/**
 * Atomically cross the irreversible SMTP boundary.
 *
 * The expected raw value includes a random reservation token, so a
 * delayed worker cannot mutate its successor. Repeating the same transition is
 * idempotent, and the original fixed expiry is preserved rather than extended.
 */
export async function markSmtpOutcomeUncertain(
	redis: Redis,
	entry: InFlightSmtpOutcome,
	expectedRaw: string
): Promise<{ entry: InFlightSmtpOutcome; raw: string }> {
	if (entry.phase !== 'pre_data') {
		throw new Error('SMTP outcome journal is not at the pre-DATA boundary');
	}
	const uncertainEntry: InFlightSmtpOutcome = { ...entry, phase: 'uncertain' };
	const uncertainRaw = JSON.stringify(uncertainEntry);
	const response = (await redis.eval(
		MARK_UNCERTAIN_LUA,
		1,
		journalKey(entry.jobId),
		expectedRaw,
		uncertainRaw
	)) as [number, string];
	if (response[0] !== 1 || !response[1]) {
		throw new Error('SMTP outcome journal DATA transition lost ownership');
	}
	const resolved = parseEntry(response[1]);
	assertBinding(resolved, entry.jobId, entry.messageId);
	if (resolved.state !== 'in_flight' || resolved.phase !== 'uncertain') {
		throw new Error('SMTP outcome journal DATA transition lost ownership');
	}
	return { entry: resolved, raw: response[1] };
}

/**
 * CAS-release a reservation whose message body was never written.
 *
 * Eligibility reads, MX/profile lookups, DKIM signing, pool acquisition,
 * connection setup, MTA-STS, TLS negotiation, and MAIL/RCPT/DATA negotiation
 * may all fail before the DATA body. Those failures cannot make the recipient
 * accept the message, so retaining the reservation would incorrectly turn a
 * safe retry into an ambiguous terminal outcome.
 */
export async function releaseSmtpOutcome(
	redis: Redis,
	entry: InFlightSmtpOutcome,
	expectedRaw: string
): Promise<boolean> {
	if (entry.phase !== 'pre_data') return false;
	const released = (await redis.eval(
		RELEASE_LUA,
		2,
		journalKey(entry.jobId),
		JOURNAL_INDEX_KEY,
		expectedRaw
	)) as number;
	return released === 1;
}

/** CAS an in-flight reservation (or replay) to one stable completed result. */
export async function finalizeSmtpOutcome(
	redis: Redis,
	entry: InFlightSmtpOutcome,
	expectedRaw: string,
	result: EmailJobResult,
	durationMs: number,
	outcome: DispatchOutcome,
	reduction: OutcomeReduction,
	options: { now: number }
): Promise<{ entry: CompletedSmtpOutcome; raw: string }> {
	const completed: CompletedSmtpOutcome = {
		state: 'completed',
		jobId: entry.jobId,
		messageId: entry.messageId,
		result,
		durationMs,
		completedAt: options.now,
		attempt: entry.attempt,
		outcome,
		reduction,
	};
	const completedRaw = JSON.stringify(completed);
	const response = (await redis.eval(
		FINALIZE_LUA,
		2,
		journalKey(entry.jobId),
		JOURNAL_INDEX_KEY,
		expectedRaw,
		completedRaw,
		String(SMTP_OUTCOME_JOURNAL_TTL_MS),
		String(options.now)
	)) as [number, string];
	// An empty observation means the reservation is simply gone — a concurrent
	// pre-envelope release. Say so rather than reporting malformed JSON.
	if (!response[1]) throw new Error('SMTP outcome journal finalization lost ownership');
	const resolved = parseEntry(response[1]);
	assertBinding(resolved, entry.jobId, entry.messageId);
	if (resolved.state !== 'completed') {
		throw new Error('SMTP outcome journal finalization lost ownership');
	}
	return { entry: resolved, raw: response[1] };
}

/**
 * Terminalize a completed attempt without deleting its replay guard.
 *
 * The tombstone is intentionally retained beyond GroupMQ's retry horizon. Its
 * capacity-index membership is removed, so completed queue history cannot
 * prevent new SMTP attempts from reserving journal space.
 */
export async function markSmtpEffectsApplied(
	redis: Redis,
	entry: CompletedSmtpOutcome,
	expectedRaw: string,
	options: { now: number }
): Promise<EffectsAppliedSmtpOutcome> {
	const tombstone: EffectsAppliedSmtpOutcome = {
		state: 'effects_applied',
		jobId: entry.jobId,
		messageId: entry.messageId,
		appliedAt: options.now,
	};
	const tombstoneRaw = JSON.stringify(tombstone);
	const response = (await redis.eval(
		MARK_EFFECTS_APPLIED_LUA,
		2,
		journalKey(entry.jobId),
		JOURNAL_INDEX_KEY,
		expectedRaw,
		tombstoneRaw,
		String(SMTP_OUTCOME_JOURNAL_TTL_MS)
	)) as [number, string];
	const resolved = parseEntry(response[1]);
	assertBinding(resolved, entry.jobId, entry.messageId);
	if (resolved.state !== 'effects_applied') {
		throw new Error('SMTP outcome journal terminalization lost ownership');
	}
	return resolved;
}

/** Run a secondary effect and checkpoint it only after successful completion. */
export async function runSmtpSecondaryEffect<T>(
	redis: Redis,
	entry: CompletedSmtpOutcome,
	expectedRaw: string,
	effectIdentity: string,
	apply: (downstreamIdentity: DurableEffectIdentity) => Promise<T>,
	options: { leaseMs?: number; waitMs?: number } = {}
): Promise<T | undefined> {
	return runCheckpointedEffect(
		redis,
		{
			ownerKey: journalKey(entry.jobId),
			ownerValue: expectedRaw,
			checkpointsKey: effectCheckpointsKey(entry.jobId),
			downstreamScope: `smtp-job:${entry.jobId}`,
			ttlMs: SMTP_OUTCOME_JOURNAL_TTL_MS,
			leaseMs: options.leaseMs,
			waitMs: options.waitMs,
		},
		effectIdentity,
		apply
	);
}

export const smtpOutcomeJournalKeys = {
	index: JOURNAL_INDEX_KEY,
	journalKey,
	effectCheckpointsKey,
};
