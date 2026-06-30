/**
 * Delivery Event Logger
 *
 * Writes delivery events to Redis Streams for persistent, queryable audit trail.
 * Each day gets its own stream with configurable max length and TTL.
 */

import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { logger } from './logger.js';

const DELIVERY_LOG_PREFIX = 'mta:delivery-log:';

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
}

/**
 * Log a delivery event to a daily Redis Stream
 */
export async function logDeliveryEvent(
	redis: Redis,
	event: DeliveryEvent,
	config: MtaConfig
): Promise<void> {
	const today = new Date().toISOString().split('T')[0]!;
	const streamKey = `${DELIVERY_LOG_PREFIX}${today}`;

	try {
		// Build flat field array for XADD
		const fields: string[] = [
			'messageId', event.messageId,
			'to', event.to,
			'from', event.from,
			'orgId', event.orgId,
			'status', event.status,
			'domain', event.domain,
			'timestamp', String(Date.now()),
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

		// XADD with approximate maxlen trimming
		await redis.xadd(streamKey, 'MAXLEN', '~', String(config.deliveryLogMaxLen), '*', ...fields);

		// Set TTL on the stream key (only if not already set — avoids resetting on every write)
		const ttl = await redis.ttl(streamKey);
		if (ttl === -1) {
			await redis.expire(streamKey, config.deliveryLogTtlHours * 3600);
		}
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

		const streamKey = `${DELIVERY_LOG_PREFIX}${date}`;
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

/**
 * Get delivery log stats for a date range
 */
export async function getDeliveryLogStats(
	redis: Redis,
	date: string,
	orgId?: string
): Promise<Record<string, number>> {
	const streamKey = `${DELIVERY_LOG_PREFIX}${date}`;
	const stats: Record<string, number> = {
		delivered: 0,
		bounced: 0,
		deferred: 0,
		suppressed: 0,
		screened: 0,
		failed: 0,
		total: 0,
	};

	// Read all entries and aggregate
	let cursor = '-';
	while (true) {
		const results = await redis.xrange(streamKey, cursor, '+', 'COUNT', 1000);
		if (results.length === 0) break;

		for (const [id, fields] of results) {
			const data = parseStreamFields(fields);
			if (orgId && data.orgId !== orgId) continue;

			stats[data.status] = (stats[data.status] ?? 0) + 1;
			stats['total'] = (stats['total'] ?? 0) + 1;
			cursor = id;
		}

		if (results.length < 1000) break;
	}

	return stats;
}

/**
 * Get all events for a specific message ID
 */
export async function getMessageEvents(
	redis: Redis,
	messageId: string,
	lookbackDays: number = 3
): Promise<DeliveryLogEntry[]> {
	const entries: DeliveryLogEntry[] = [];
	const today = new Date();

	for (let i = 0; i < lookbackDays; i++) {
		const date = new Date(today);
		date.setDate(date.getDate() - i);
		const dateStr = date.toISOString().split('T')[0]!;
		const streamKey = `${DELIVERY_LOG_PREFIX}${dateStr}`;

		let cursor = '-';
		while (true) {
			const results = await redis.xrange(streamKey, cursor, '+', 'COUNT', 500);
			if (results.length === 0) break;

			for (const [id, fields] of results) {
				const data = parseStreamFields(fields);
				if (data.messageId === messageId) {
					entries.push({ id, ...data });
				}
				cursor = id;
			}

			if (results.length < 500) break;
		}
	}

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
	};
}
