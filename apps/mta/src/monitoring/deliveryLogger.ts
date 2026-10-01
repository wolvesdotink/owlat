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
	indexMatchesRetainedStream,
	messageIndexCoversAllWrites,
	messageIndexKeyFor,
	orgStatsKeyFor,
	compareStreamIds,
	nextStreamId,
	previousStreamId,
	readDayIndex,
	retainedCounts,
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

		// XADD, the stream TTL (set once, when the day's stream is created), the
		// index updates and the exact MAXLEN trim with its counts, atomically.
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
	limit?: number; // default 100, at most 1000
	/** `nextCursor` of the previous page. A bare stream ID from an older MTA is still accepted. */
	cursor?: string;
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

/** A malformed `GET /delivery-logs` query; the route answers 400. */
export class DeliveryLogQueryError extends Error {}

/**
 * Largest XRANGE a filtered query makes. Its reads start at one page and
 * double up to this, so a selective filter reads few entries it then leaves
 * for the next page.
 */
export const QUERY_SCAN_PAGE_SIZE = 1000;
/** Most stream entries one query examines before it returns a cursor. */
export const QUERY_SCAN_BUDGET = 10_000;
/** Most XRANGE calls one query makes (bounds long ranges of empty days). */
export const QUERY_MAX_READS = 64;

/** Where a query resumes: strictly after stream ID `after` in `date`'s stream. */
interface QueryPosition {
	date: string;
	after: string;
}

/** Before every real stream ID (XADD refuses 0-0), so `<date>:0-0` is "the start of that day". */
const DAY_START = '0-0';
const DAY_MS = 86_400_000;
const CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}):(\d{1,20}-\d{1,20})$/;
const LEGACY_CURSOR_PATTERN = /^\d{1,20}(-\d{1,20})?$/;

const encodeCursor = (position: QueryPosition): string => `${position.date}:${position.after}`;

/**
 * `<date>:<id>` is the last entry the previous page examined, matched or not.
 * A bare stream ID is a cursor from an MTA before this format: the first entry
 * that page did not return, applied to every date as an inclusive lower bound,
 * as those MTAs did.
 */
function decodeCursor(cursor: string): QueryPosition | { legacyFrom: string } {
	const position = CURSOR_PATTERN.exec(cursor);
	if (position) {
		const date = position[1]!;
		const parsed = new Date(date);
		if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
			throw new DeliveryLogQueryError('Invalid cursor');
		}
		return { date, after: position[2]! };
	}
	if (LEGACY_CURSOR_PATTERN.test(cursor)) return { legacyFrom: cursor };
	throw new DeliveryLogQueryError('Invalid cursor');
}

/** The dates a query covers, oldest first, starting no earlier than `from`. */
function* queryDates(query: DeliveryLogQuery, from: string | undefined): Generator<string> {
	if (query.date) {
		if (from === undefined || query.date >= from) yield query.date;
		return;
	}
	if (!query.startDate || !query.endDate) {
		const today = new Date().toISOString().split('T')[0]!;
		if (from === undefined || today >= from) yield today;
		return;
	}
	const end = Date.parse(query.endDate);
	let day = Date.parse(query.startDate);
	if (from !== undefined) day = Math.max(day, Date.parse(from));
	// UTC days are all 24 h long, so stepping milliseconds never skips or repeats one.
	for (; day <= end; day += DAY_MS) yield new Date(day).toISOString().split('T')[0]!;
}

/**
 * Query delivery logs from Redis Streams, oldest first, one day after another.
 *
 * `nextCursor` is present while anything may be left, and names the last entry
 * examined, so the next page starts strictly after it: no entry is returned
 * twice or skipped, whatever the filters drop. One request examines at most
 * `QUERY_SCAN_BUDGET` entries in at most `QUERY_MAX_READS` reads, so a page can
 * hold fewer than `limit` entries, or none, and still carry a cursor.
 */
export async function queryDeliveryLogs(
	redis: Redis,
	query: DeliveryLogQuery
): Promise<{ entries: DeliveryLogEntry[]; nextCursor?: string }> {
	const limit = Number.isFinite(query.limit)
		? Math.min(Math.max(Math.trunc(query.limit!), 1), 1000)
		: 100;
	const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
	const resume = cursor && 'date' in cursor ? cursor : undefined;
	const legacyAfter =
		cursor && 'legacyFrom' in cursor ? previousStreamId(cursor.legacyFrom) : undefined;
	const filtered = Boolean(query.orgId || query.status || query.domain || query.messageId);

	const entries: DeliveryLogEntry[] = [];
	let examined = 0;
	let reads = 0;
	let filteredReadSize = Math.min(limit + 1, QUERY_SCAN_PAGE_SIZE);
	const dates = queryDates(query, resume?.date);
	let next = dates.next();
	while (!next.done) {
		const date = next.value;
		const position: QueryPosition = {
			date,
			after: resume?.date === date ? resume.after : (legacyAfter ?? DAY_START),
		};
		for (;;) {
			if (reads >= QUERY_MAX_READS || examined >= QUERY_SCAN_BUDGET) {
				return { entries, nextCursor: encodeCursor(position) };
			}
			// Unfiltered, one entry past the page says whether the day holds more.
			const count = Math.min(
				filtered ? filteredReadSize : limit - entries.length + 1,
				QUERY_SCAN_BUDGET - examined
			);
			filteredReadSize = Math.min(filteredReadSize * 2, QUERY_SCAN_PAGE_SIZE);
			const page = (await redis.xrange(
				streamKeyFor(date),
				position.after === DAY_START ? '-' : nextStreamId(position.after),
				'+',
				'COUNT',
				count
			)) as StreamEntry[];
			reads += 1;
			for (const [id, fields] of page) {
				if (entries.length >= limit) return { entries, nextCursor: encodeCursor(position) };
				if (compareStreamIds(id, position.after) <= 0) {
					throw new Error(`Delivery log query made no progress at ${id} on ${date}`);
				}
				position.after = id;
				examined += 1;
				const data = parseStreamFields(fields);
				if (query.orgId && data.orgId !== query.orgId) continue;
				if (query.status && data.status !== query.status) continue;
				if (query.domain && data.domain !== query.domain) continue;
				if (query.messageId && data.messageId !== query.messageId) continue;
				entries.push({ id, ...data });
			}
			if (page.length < count) break; // the day is exhausted
			if (entries.length >= limit) return { entries, nextCursor: encodeCursor(position) };
		}
		next = dates.next();
		if (entries.length >= limit) {
			return next.done
				? { entries }
				: { entries, nextCursor: encodeCursor({ date: next.value, after: DAY_START }) };
		}
	}
	return { entries };
}

/** Stream entries read per XRANGE page when a day has to be scanned. */
export const STATS_SCAN_PAGE_SIZE = 1000;
export const MESSAGE_SCAN_PAGE_SIZE = 500;

/**
 * Status counts over the retained delivery log entries of one day,
 * optionally for one organization.
 *
 * Reads the day's counters when they provably describe the retained stream
 * (every entry indexed, every trimmed entry counted out); otherwise scans the
 * stream once.
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
		return retainedCounts((value ?? {}) as Record<string, string>, stats);
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
	if (messageIndexCoversAllWrites(coverage)) {
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
