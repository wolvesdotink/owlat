/** Durable handoff from atomic readiness transitions into the webhook outbox. */

import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { isMtaWebhookEvent } from '@owlat/shared/mtaWebhookEvent';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';
import type { MtaWebhookEvent } from '../types.js';
import { queueConvexWebhook } from '../webhooks/convexNotifier.js';
import { IP_READINESS_ALERTS_PENDING } from './ipPool.js';

export const IP_READINESS_ALERT_FLUSH_BATCH_SIZE = 100;
export const IP_READINESS_ALERT_SCAN_STATE = 'mta:{ip-readiness-alerts}:scan-state';
const IP_READINESS_ALERT_SCAN_LOCK = 'mta:{ip-readiness-alerts}:scan-lock';
const IP_READINESS_ALERT_SCAN_LOCK_TTL_MS = 60_000;
const IP_READINESS_ALERT_SCAN_PAGE_LIMIT = 16;
const PERSIST_SCAN_STATE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[2], 'cursor', ARGV[2], 'candidates', ARGV[3])
return 1
`;
const RELEASE_SCAN_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

interface AlertScanState {
	cursor: string;
	candidates: string[];
}

async function readScanState(redis: Redis): Promise<AlertScanState> {
	const [storedCursor, storedCandidates] = await redis.hmget(
		IP_READINESS_ALERT_SCAN_STATE,
		'cursor',
		'candidates'
	);
	let candidates: string[] = [];
	if (storedCandidates) {
		try {
			const parsed: unknown = JSON.parse(storedCandidates);
			if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) {
				candidates = parsed;
			}
		} catch {
			logger.error('Resetting corrupt IP-readiness alert scan candidates');
		}
	}
	return {
		cursor: storedCursor && /^\d+$/.test(storedCursor) ? storedCursor : '0',
		candidates,
	};
}

/**
 * The lock and state keys share one explicit Redis Cluster hash tag, so the
 * owner-fenced two-key script is cluster-safe. The pending hash is scanned and
 * deleted only through separate single-key commands and may live in any slot.
 */
async function persistScanState(
	redis: Redis,
	lockToken: string,
	state: AlertScanState
): Promise<void> {
	const persisted = await redis.eval(
		PERSIST_SCAN_STATE_SCRIPT,
		2,
		IP_READINESS_ALERT_SCAN_LOCK,
		IP_READINESS_ALERT_SCAN_STATE,
		lockToken,
		state.cursor,
		JSON.stringify(state.candidates)
	);
	if (Number(persisted) !== 1) throw new Error('IP-readiness alert scan lock expired');
}

export async function flushPendingIpReadinessAlerts(
	redis: Redis,
	config: MtaConfig
): Promise<number> {
	const lockToken = randomUUID();
	const acquired = await redis.set(
		IP_READINESS_ALERT_SCAN_LOCK,
		lockToken,
		'PX',
		IP_READINESS_ALERT_SCAN_LOCK_TTL_MS,
		'NX'
	);
	if (acquired !== 'OK') return 0;

	try {
		const state = await readScanState(redis);
		for (
			let scannedPages = 0;
			state.candidates.length === 0 && scannedPages < IP_READINESS_ALERT_SCAN_PAGE_LIMIT;
			scannedPages += 1
		) {
			const [nextCursor, entries] = await redis.hscan(
				IP_READINESS_ALERTS_PENDING,
				state.cursor,
				'COUNT',
				IP_READINESS_ALERT_FLUSH_BATCH_SIZE
			);
			state.cursor = nextCursor;
			for (let index = 0; index < entries.length; index += 2) {
				state.candidates.push(entries[index]!);
			}
			// This also persists empty pages with a non-zero cursor. A crash
			// before this HSET simply repeats the page; a crash after it resumes
			// from the stored candidates/cursor.
			await persistScanState(redis, lockToken, state);
			if (nextCursor === '0') break;
		}

		let queued = 0;
		let processed = 0;
		while (state.candidates.length > 0 && processed < IP_READINESS_ALERT_FLUSH_BATCH_SIZE) {
			const eventId = state.candidates[0]!;
			const raw = await redis.hget(IP_READINESS_ALERTS_PENDING, eventId);
			if (raw) {
				const [readinessCheck, readinessReason, timestamp, message, ip, eligibilityGeneration] =
					raw.split('\x1f');
				const parsed: unknown = {
					event: 'ip.readiness_regressed',
					eventId,
					readinessCheck,
					readinessReason,
					timestamp: Number(timestamp),
					message,
					ip,
					eligibilityGeneration: Number(eligibilityGeneration),
				};
				if (!isMtaWebhookEvent(parsed) || parsed.event !== 'ip.readiness_regressed') {
					logger.error({ eventId }, 'Discarding invalid pending IP-readiness alert');
				} else {
					await queueConvexWebhook(parsed as MtaWebhookEvent, config, redis, eventId);
					queued += 1;
				}
				await redis.hdel(IP_READINESS_ALERTS_PENDING, eventId);
			}
			state.candidates.shift();
			await persistScanState(redis, lockToken, state);
			processed += 1;
		}
		return queued;
	} finally {
		await redis.eval(RELEASE_SCAN_LOCK_SCRIPT, 1, IP_READINESS_ALERT_SCAN_LOCK, lockToken);
	}
}
