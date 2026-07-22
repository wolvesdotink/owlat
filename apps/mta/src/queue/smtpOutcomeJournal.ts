/**
 * Durable uncertainty boundary around the irreversible SMTP transaction.
 *
 * A fresh reservation is the only state allowed to enter `sendToMx`. If a
 * worker disappears after reserving, a replay converts the reservation to a
 * deterministic ambiguous result rather than risking a duplicate delivery.
 */

import { createHash } from 'crypto';
import type Redis from 'ioredis';
import type { EmailJobResult } from '../types.js';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';

const JOURNAL_INDEX_KEY = 'mta:{smtp-outcome}:expiries';
const JOURNAL_KEY_PREFIX = 'mta:{smtp-outcome}:job:';
export const SMTP_OUTCOME_JOURNAL_TTL_MS = GOVERNED_MTA_MAX_MESSAGE_AGE_MS + 24 * 60 * 60 * 1000;

interface InFlightSmtpOutcome {
	state: 'in_flight';
	jobId: string;
	messageId: string;
	reservedAt: number;
}

interface CompletedSmtpOutcome {
	state: 'completed';
	jobId: string;
	messageId: string;
	result: EmailJobResult;
	durationMs: number;
	completedAt: number;
}

export type SmtpOutcomeJournalEntry = InFlightSmtpOutcome | CompletedSmtpOutcome;

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

const CLEAR_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], KEYS[1])
return 1
`;

function journalKey(jobId: string): string {
	return `${JOURNAL_KEY_PREFIX}${createHash('sha256').update(jobId).digest('hex')}`;
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
		(entry['state'] !== 'in_flight' && entry['state'] !== 'completed') ||
		typeof entry['jobId'] !== 'string' ||
		typeof entry['messageId'] !== 'string'
	) {
		throw new Error('SMTP outcome journal contains an invalid entry');
	}
	if (entry['state'] === 'in_flight') {
		if (typeof entry['reservedAt'] !== 'number') {
			throw new Error('SMTP outcome journal contains an invalid reservation');
		}
		return entry as unknown as InFlightSmtpOutcome;
	}
	if (
		!entry['result'] ||
		typeof entry['result'] !== 'object' ||
		typeof entry['durationMs'] !== 'number' ||
		typeof entry['completedAt'] !== 'number'
	) {
		throw new Error('SMTP outcome journal contains an invalid completed result');
	}
	return entry as unknown as CompletedSmtpOutcome;
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
	options: { now: number; capacity: number }
): Promise<SmtpOutcomeReservation> {
	const entry: InFlightSmtpOutcome = {
		state: 'in_flight',
		jobId,
		messageId,
		reservedAt: options.now,
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

/** CAS an in-flight reservation (or replay) to one stable completed result. */
export async function finalizeSmtpOutcome(
	redis: Redis,
	entry: InFlightSmtpOutcome,
	expectedRaw: string,
	result: EmailJobResult,
	durationMs: number,
	options: { now: number }
): Promise<{ entry: CompletedSmtpOutcome; raw: string }> {
	const completed: CompletedSmtpOutcome = {
		state: 'completed',
		jobId: entry.jobId,
		messageId: entry.messageId,
		result,
		durationMs,
		completedAt: options.now,
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
	const resolved = parseEntry(response[1]);
	assertBinding(resolved, entry.jobId, entry.messageId);
	if (resolved.state !== 'completed') {
		throw new Error('SMTP outcome journal finalization lost ownership');
	}
	return { entry: resolved, raw: response[1] };
}

/** Clear only the exact completed result whose effects/handoff are durable. */
export async function clearSmtpOutcome(
	redis: Redis,
	entry: CompletedSmtpOutcome,
	expectedRaw: string
): Promise<boolean> {
	const cleared = (await redis.eval(
		CLEAR_LUA,
		2,
		journalKey(entry.jobId),
		JOURNAL_INDEX_KEY,
		expectedRaw
	)) as number;
	return cleared === 1;
}

/** Best-effort predecessor cleanup after a durable defer handoff is resumed. */
export async function clearCompletedSmtpOutcomeForJob(
	redis: Redis,
	jobId: string,
	messageId: string
): Promise<void> {
	const key = journalKey(jobId);
	const raw = await redis.get(key);
	if (!raw) return;
	const entry = parseEntry(raw);
	assertBinding(entry, jobId, messageId);
	if (entry.state === 'completed') await clearSmtpOutcome(redis, entry, raw);
}

export const smtpOutcomeJournalKeys = { index: JOURNAL_INDEX_KEY, journalKey };
