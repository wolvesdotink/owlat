/**
 * Delivery Event Logger
 *
 * Writes delivery events to Redis Streams for persistent, queryable audit trail.
 * Each day gets its own stream with configurable max length and TTL.
 */

import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { logger } from './logger.js';
import {
	RECORD_DELIVERY_EVENT_SCRIPT,
	indexCoversAllWrites,
	indexMatchesRetainedStream,
	messageIndexKeyFor,
	orgStatsKeyFor,
	readDayIndex,
	scanDeliveryStream,
	statsKeyFor,
	streamKeyFor,
	type StreamEntry,
} from './deliveryLogIndex.js';

export type DeliveryStatus =
	| 'delivered'
	| 'bounced'
	| 'deferred'
	| 'suppressed'
	| 'screened'
	| 'failed'
	/** Gave up after exceeding the max message age — a terminal soft-fail. */
	| 'expired';

export interface DeliveryEvent {
	messageId: string;
	to: string;
	from: string;
	orgId: string;
	status: DeliveryStatus;
	smtpCode?: number;
	smtpResponse?: string;
	bounceType?: 'hard' | 'soft';
	ip?: string;
	pool?: string;
	domain: string;
	durationMs?: number;
	attempt?: number;
	reason?: string;
	/** SMTP failure category from enhanced classifier */
	category?: string;
	/** MX-derived destination provider used for shaping and dashboard grouping. */
	provider?: string;
	/** Operator-facing explanation for a recognized provider response. */
	annotation?: string;
}

/**
 * Log a delivery event to a daily Redis Stream and its per-day indexes
 * (see deliveryLogIndex.ts) in one atomic script call.
 */
export async function logDeliveryEvent(
	redis: Redis,
	event: DeliveryEvent,
	config: MtaConfig
): Promise<void> {
	const today = new Date().toISOString().split('T')[0]!;

	try {
		// Build flat field array for XADD
		const fields: string[] = [
			'messageId',
			event.messageId,
			'to',
			event.to,
			'from',
			event.from,
			'orgId',
			event.orgId,
			'status',
			event.status,
			'domain',
			event.domain,
			'timestamp',
			String(Date.now()),
		];

		if (event.smtpCode !== undefined) fields.push('smtpCode', String(event.smtpCode));
		if (event.smtpResponse) fields.push('smtpResponse', event.smtpResponse);
		if (event.bounceType) fields.push('bounceType', event.bounceType);
		if (event.ip) fields.push('ip', event.ip);
		if (event.pool) fields.push('pool', event.pool);
		if (event.durationMs !== undefined) fields.push('durationMs', String(event.durationMs));
		if (event.attempt !== undefined) fields.push('attempt', String(event.attempt));
		if (event.reason) fields.push('reason', event.reason);
		if (event.category) fields.push('category', event.category);
		if (event.provider) fields.push('provider', event.provider);
		if (event.annotation) fields.push('annotation', event.annotation);

		// XADD with approximate maxlen trimming, the stream TTL (set once, when
		// the day's stream is created) and the index updates, atomically.
		await redis.eval(
			RECORD_DELIVERY_EVENT_SCRIPT,
			4,
			streamKeyFor(today),
			statsKeyFor(today),
			orgStatsKeyFor(today, event.orgId),
			messageIndexKeyFor(today),
			String(config.deliveryLogMaxLen),
			String(config.deliveryLogTtlHours * 3_600_000),
			event.status,
			event.messageId,
			...fields
		);
	} catch (err) {
		// Non-critical — don't let logging failures affect delivery
		logger.warn({ err, messageId: event.messageId }, 'Failed to write delivery log event');
	}
}

export interface DeliveryLogQuery {
	date?: string; // YYYY-MM-DD (defaults to today)
	startDate?: string; // YYYY-MM-DD for range queries
	endDate?: string; // YYYY-MM-DD for range queries
	orgId?: string;
	status?: DeliveryStatus;
	domain?: string;
	messageId?: string;
	limit?: number; // default 100
	cursor?: string; // Redis Stream ID for pagination
}

export interface DeliveryLogEntry {
	id: string; // Redis Stream entry ID
	messageId: string;
	to: string;
	from: string;
	orgId: string;
	status: DeliveryStatus;
	domain: string;
	timestamp: number;
	smtpCode?: number;
	smtpResponse?: string;
	bounceType?: string;
	ip?: string;
	pool?: string;
	durationMs?: number;
	attempt?: number;
	reason?: string;
	category?: string;
	provider?: string;
	annotation?: string;
}

/**
 * Query delivery logs from Redis Streams
 */
export async function queryDeliveryLogs(
	redis: Redis,
	query: DeliveryLogQuery
): Promise<{ entries: DeliveryLogEntry[]; nextCursor?: string }> {
	const limit = Math.min(query.limit ?? 100, 1000);

	// Determine which date streams to read
	const dates: string[] = [];
	if (query.date) {
		dates.push(query.date);
	} else if (query.startDate && query.endDate) {
		const start = new Date(query.startDate);
		const end = new Date(query.endDate);
		for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
			dates.push(d.toISOString().split('T')[0]!);
		}
	} else {
		dates.push(new Date().toISOString().split('T')[0]!);
	}

	const entries: DeliveryLogEntry[] = [];
	let nextCursor: string | undefined;

	for (const date of dates) {
		if (entries.length >= limit) break;

		const streamKey = streamKeyFor(date);
		const startId = query.cursor ?? '-';
		const remaining = limit - entries.length;

		const results = await redis.xrange(streamKey, startId, '+', 'COUNT', remaining + 1);

		for (const [id, fields] of results) {
			if (entries.length >= limit) {
				nextCursor = id;
				break;
			}

			// Skip the cursor entry itself (it was already returned in previous page)
			if (id === query.cursor) continue;

			const data = parseStreamFields(fields);

			// Apply filters
			if (query.orgId && data.orgId !== query.orgId) continue;
			if (query.status && data.status !== query.status) continue;
			if (query.domain && data.domain !== query.domain) continue;
			if (query.messageId && data.messageId !== query.messageId) continue;

			entries.push({ id, ...data });
		}
	}

	return { entries, nextCursor };
}

/** Stream entries read per XRANGE page when a day has to be scanned. */
export const STATS_SCAN_PAGE_SIZE = 1000;
export const MESSAGE_SCAN_PAGE_SIZE = 500;

/**
 * Status counts over the retained delivery log entries of one day,
 * optionally for one organization.
 *
 * Reads the day's counters when they provably describe the retained stream
 * (every entry indexed, nothing trimmed); otherwise scans the stream once.
 */
export async function getDeliveryLogStats(
	redis: Redis,
	date: string,
	orgId?: string
): Promise<Record<string, number>> {
	const stats: Record<string, number> = {
		delivered: 0,
		bounced: 0,
		deferred: 0,
		suppressed: 0,
		screened: 0,
		failed: 0,
		total: 0,
	};

	const { coverage, value } = orgId
		? await readDayIndex(redis, date, 'org', orgId)
		: await readDayIndex(redis, date, 'stats');
	if (coverage.kind === 'absent') return stats;
	if (indexMatchesRetainedStream(coverage)) {
		const counts = (value ?? {}) as Record<string, string>;
		for (const [field, count] of Object.entries(counts)) stats[field] = Number(count);
		return stats;
	}

	await scanDeliveryStream(redis, streamKeyFor(date), STATS_SCAN_PAGE_SIZE, (_id, fields) => {
		const data = parseStreamFields(fields);
		if (orgId && data.orgId !== orgId) return;
		stats[data.status] = (stats[data.status] ?? 0) + 1;
		stats['total'] = (stats['total'] ?? 0) + 1;
	});

	return stats;
}

/**
 * Get all retained events for a specific message ID, newest day first and in
 * stream order within a day.
 */
export async function getMessageEvents(
	redis: Redis,
	messageId: string,
	lookbackDays: number = 3
): Promise<DeliveryLogEntry[]> {
	const today = new Date();
	const dates: string[] = [];
	for (let i = 0; i < lookbackDays; i++) {
		const date = new Date(today);
		date.setDate(date.getDate() - i);
		dates.push(date.toISOString().split('T')[0]!);
	}

	const perDay = await Promise.all(
		dates.map((date) => getMessageEventsForDay(redis, date, messageId))
	);
	return perDay.flat();
}

async function getMessageEventsForDay(
	redis: Redis,
	date: string,
	messageId: string
): Promise<DeliveryLogEntry[]> {
	const streamKey = streamKeyFor(date);
	const { coverage, value } = await readDayIndex(redis, date, 'message', messageId);
	if (coverage.kind === 'absent') return [];

	const entries: DeliveryLogEntry[] = [];
	if (indexCoversAllWrites(coverage)) {
		const ids = typeof value === 'string' && value.length > 0 ? value.split(' ') : [];
		if (ids.length === 0) return entries;
		// Resolve each indexed ID against the stream; IDs trimmed by MAXLEN
		// come back empty and are skipped, so histories stay "retained events".
		const pipeline = redis.pipeline();
		for (const id of ids) pipeline.xrange(streamKey, id, id);
		const results = (await pipeline.exec()) ?? [];
		for (const [err, reply] of results) {
			if (err) throw err;
			for (const [id, fields] of reply as StreamEntry[])
				entries.push({ id, ...parseStreamFields(fields) });
		}
		return entries;
	}

	await scanDeliveryStream(redis, streamKey, MESSAGE_SCAN_PAGE_SIZE, (id, fields) => {
		const data = parseStreamFields(fields);
		if (data.messageId === messageId) entries.push({ id, ...data });
	});
	return entries;
}

function parseStreamFields(fields: string[]): Omit<DeliveryLogEntry, 'id'> {
	const map: Record<string, string> = {};
	for (let i = 0; i < fields.length; i += 2) {
		map[fields[i]!] = fields[i + 1]!;
	}

	return {
		messageId: map['messageId'] ?? '',
		to: map['to'] ?? '',
		from: map['from'] ?? '',
		orgId: map['orgId'] ?? '',
		status: (map['status'] as DeliveryStatus) ?? 'failed',
		domain: map['domain'] ?? '',
		timestamp: parseInt(map['timestamp'] ?? '0', 10),
		smtpCode: map['smtpCode'] ? parseInt(map['smtpCode'], 10) : undefined,
		smtpResponse: map['smtpResponse'],
		bounceType: map['bounceType'],
		ip: map['ip'],
		pool: map['pool'],
		durationMs: map['durationMs'] ? parseInt(map['durationMs'], 10) : undefined,
		attempt: map['attempt'] ? parseInt(map['attempt'], 10) : undefined,
		reason: map['reason'],
		category: map['category'],
		provider: map['provider'],
		annotation: map['annotation'],
	};
}
