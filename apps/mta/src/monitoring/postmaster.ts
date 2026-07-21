/**
 * Google Postmaster Tools v2 collector.
 *
 * Domain and statistics cursors are checkpointed only after the page they
 * describe has been delivered. Redis receipts make replay after a crash safe.
 *
 * @see https://developers.google.com/workspace/gmail/postmaster/reference/rest/v2/domains/list
 * @see https://developers.google.com/workspace/gmail/postmaster/reference/rest/v2/domains.domainStats/query
 */

import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { Gauge } from 'prom-client';
import type { MtaConfig } from '../config.js';
import type { GooglePostmasterStatsEvent } from '../types.js';
import { notifyConvex } from '../webhooks/convexNotifier.js';
import { registry } from './collector.js';
import {
	GOOGLE_POSTMASTER_API_BASE,
	GOOGLE_POSTMASTER_SPAM_RATE_METRIC_NAME,
	GoogleApiError,
	GooglePostmasterClient,
	isRecord,
	normalizeDomainStat,
	parseReadableVerifiedDomain,
	type PostmasterDomainWire,
} from './googlePostmasterApi.js';
import { logger } from './logger.js';

const COLLECTION_LOCK_KEY = 'mta:postmaster:collection-lock';
const DOMAIN_CURSOR_KEY = 'mta:postmaster:domain-cursor';
const STATS_CURSOR_PREFIX = 'mta:postmaster:stats-cursor:';
const PUSHED_PREFIX = 'mta:postmaster:pushed:';
const BACKFILL_DAYS = 7;
const PUSH_RECEIPT_TTL_SECONDS = 14 * 24 * 60 * 60;
const COLLECTION_LOCK_TTL_SECONDS = 30 * 60;
const COLLECTION_RUN_BUDGET_MS = 10 * 60 * 1_000;
const DOMAIN_PAGE_SIZE = 25;
const DOMAIN_PAGES_PER_SWEEP = 2;
const STATS_PAGE_SIZE = 200;
const STATS_PAGES_PER_DOMAIN_PER_SWEEP = 4;

export const spamRate = new Gauge({
	name: 'mta_postmaster_spam_rate',
	help: 'Google Postmaster user-reported spam ratio (0-1)',
	labelNames: ['domain'] as const,
	registers: [registry],
});

interface DomainPage {
	domains: PostmasterDomainWire[];
	nextPageToken?: string;
}

interface StatsPage {
	events: GooglePostmasterStatsEvent[];
	nextPageToken?: string;
}

interface StatsCursor {
	pageToken: string;
	startDate: string;
	endDate: string;
}

function dateObject(date: string): { year: number; month: number; day: number } {
	const [year, month, day] = date.split('-').map(Number);
	return { year: year!, month: month!, day: day! };
}

function utcDateDaysAgo(daysAgo: number): string {
	return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

function optionalPageToken(
	payload: Record<string, unknown>,
	operation: string
): string | undefined {
	const token = payload['nextPageToken'];
	if (token === undefined || token === '') return undefined;
	if (typeof token !== 'string') throw new GoogleApiError(operation, 200, 'request');
	return token;
}

async function fetchDomainPage(
	client: GooglePostmasterClient,
	pageToken?: string
): Promise<DomainPage> {
	const url = new URL(`${GOOGLE_POSTMASTER_API_BASE}/domains`);
	url.searchParams.set('pageSize', String(DOMAIN_PAGE_SIZE));
	if (pageToken) url.searchParams.set('pageToken', pageToken);
	const payload = await client.json('domains.list', url.toString());
	if (!isRecord(payload)) throw new GoogleApiError('domains.list', 200, 'request');
	const domains = new Map<string, PostmasterDomainWire>();
	if (Array.isArray(payload['domains'])) {
		for (const raw of payload['domains']) {
			const domain = parseReadableVerifiedDomain(raw);
			if (domain) domains.set(domain.name, domain);
		}
	}
	return {
		domains: [...domains.values()],
		nextPageToken: optionalPageToken(payload, 'domains.list'),
	};
}

async function fetchDomainPageWithCursorRecovery(
	client: GooglePostmasterClient,
	redis: Redis,
	pageToken: string | undefined,
	mayRecoverPersistedCursor: boolean
): Promise<{ page: DomainPage; requestedPageToken?: string }> {
	try {
		return { page: await fetchDomainPage(client, pageToken), requestedPageToken: pageToken };
	} catch (error) {
		if (
			!(
				mayRecoverPersistedCursor &&
				pageToken &&
				error instanceof GoogleApiError &&
				error.category === 'request'
			)
		)
			throw error;
		await redis.del(DOMAIN_CURSOR_KEY);
		logger.warn({ operation: 'domains.list' }, 'Discarded invalid Google Postmaster domain cursor');
		return { page: await fetchDomainPage(client), requestedPageToken: undefined };
	}
}

function queryBody(startDate: string, endDate: string, pageToken?: string) {
	return {
		metricDefinitions: [
			{
				name: GOOGLE_POSTMASTER_SPAM_RATE_METRIC_NAME,
				baseMetric: { standardMetric: 'SPAM_RATE' },
			},
		],
		timeQuery: {
			dateRanges: {
				dateRanges: [{ start: dateObject(startDate), end: dateObject(endDate) }],
			},
		},
		pageSize: STATS_PAGE_SIZE,
		...(pageToken ? { pageToken } : {}),
		aggregationGranularity: 'DAILY',
	};
}

async function fetchStatsPage(
	client: GooglePostmasterClient,
	domain: string,
	startDate: string,
	endDate: string,
	pageToken?: string
): Promise<StatsPage> {
	const payload = await client.json(
		'domains.domainStats.query',
		`${GOOGLE_POSTMASTER_API_BASE}/domains/${encodeURIComponent(domain)}/domainStats:query`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(queryBody(startDate, endDate, pageToken)),
		}
	);
	if (!isRecord(payload)) throw new GoogleApiError('domains.domainStats.query', 200, 'request');
	const events = new Map<string, GooglePostmasterStatsEvent>();
	if (Array.isArray(payload['domainStats'])) {
		for (const raw of payload['domainStats']) {
			if (!isRecord(raw)) continue;
			const event = normalizeDomainStat(domain, raw);
			if (event && event.date >= startDate && event.date <= endDate) events.set(event.date, event);
		}
	}
	return {
		events: [...events.values()],
		nextPageToken: optionalPageToken(payload, 'domains.domainStats.query'),
	};
}

async function readStatsCursor(
	redis: Redis,
	key: string,
	startDate: string,
	endDate: string
): Promise<string | undefined> {
	const raw = await redis.get(key);
	if (!raw) return undefined;
	try {
		const cursor = JSON.parse(raw) as unknown;
		if (
			isRecord(cursor) &&
			typeof cursor['pageToken'] === 'string' &&
			cursor['pageToken'].length > 0 &&
			cursor['startDate'] === startDate &&
			cursor['endDate'] === endDate
		) {
			return cursor['pageToken'];
		}
	} catch {
		// Malformed or stale local state is safely replayed from page one.
	}
	await redis.del(key);
	return undefined;
}

async function checkpointStatsCursor(
	redis: Redis,
	key: string,
	pageToken: string | undefined,
	startDate: string,
	endDate: string
): Promise<void> {
	if (!pageToken) {
		await redis.del(key);
		return;
	}
	const cursor: StatsCursor = { pageToken, startDate, endDate };
	await redis.set(key, JSON.stringify(cursor), 'EX', PUSH_RECEIPT_TTL_SECONDS);
}

async function pushDomainStats(
	redis: Redis,
	config: MtaConfig,
	client: GooglePostmasterClient,
	domain: PostmasterDomainWire,
	deadline: number
): Promise<void> {
	const domainName = domain.name.slice('domains/'.length);
	const startDate = utcDateDaysAgo(BACKFILL_DAYS);
	const endDate = utcDateDaysAgo(1);
	const cursorKey = `${STATS_CURSOR_PREFIX}${domainName}`;
	let pageToken = await readStatsCursor(redis, cursorKey, startDate, endDate);
	const seenTokens = new Set<string>(pageToken ? [pageToken] : []);
	let mayRecoverPersistedCursor = pageToken !== undefined;

	for (let pageIndex = 0; pageIndex < STATS_PAGES_PER_DOMAIN_PER_SWEEP; pageIndex++) {
		let page: StatsPage;
		try {
			page = await fetchStatsPage(client, domainName, startDate, endDate, pageToken);
		} catch (error) {
			if (
				!(
					mayRecoverPersistedCursor &&
					error instanceof GoogleApiError &&
					error.category === 'request'
				)
			) {
				throw error;
			}
			await redis.del(cursorKey);
			logger.warn(
				{ operation: 'domains.domainStats.query', domain: domainName },
				'Discarded invalid Google Postmaster statistics cursor'
			);
			pageToken = undefined;
			mayRecoverPersistedCursor = false;
			page = await fetchStatsPage(client, domainName, startDate, endDate);
		}
		mayRecoverPersistedCursor = false;

		for (const event of page.events) {
			const receiptKey = `${PUSHED_PREFIX}${domainName}:${event.date}`;
			if (await redis.exists(receiptKey)) continue;
			if (!(await notifyConvex(event, config, redis, { deadline }))) {
				throw new Error('Google Postmaster webhook delivery did not complete');
			}
			await redis.set(receiptKey, '1', 'EX', PUSH_RECEIPT_TTL_SECONDS);
			spamRate.set({ domain: domainName }, event.userReportedSpamRatio);
		}

		const nextPageToken = page.nextPageToken;
		if (nextPageToken && seenTokens.has(nextPageToken)) {
			logger.warn(
				{ operation: 'domains.domainStats.query', domain: domainName },
				'Google Postmaster statistics cursor repeated'
			);
			await redis.del(cursorKey);
			return;
		}
		await checkpointStatsCursor(redis, cursorKey, nextPageToken, startDate, endDate);
		if (!nextPageToken) return;
		seenTokens.add(nextPageToken);
		pageToken = nextPageToken;
	}
}

async function releaseCollectionLock(redis: Redis, lockToken: string): Promise<void> {
	await redis.eval(
		"if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
		1,
		COLLECTION_LOCK_KEY,
		lockToken
	);
}

/** Hourly, overlap-safe sweep of the seven prior UTC days. */
export async function fetchPostmasterData(redis: Redis, config: MtaConfig): Promise<void> {
	if (!config.googlePostmaster) return;
	const lockToken = randomUUID();
	let lockAcquired = false;
	try {
		const acquired = await redis.set(
			COLLECTION_LOCK_KEY,
			lockToken,
			'EX',
			COLLECTION_LOCK_TTL_SECONDS,
			'NX'
		);
		if (acquired !== 'OK') return;
		lockAcquired = true;
		const deadline = Date.now() + COLLECTION_RUN_BUDGET_MS;
		const client = new GooglePostmasterClient(redis, config.googlePostmaster, deadline);
		let pageToken = (await redis.get(DOMAIN_CURSOR_KEY)) ?? undefined;
		const seenTokens = new Set<string>(pageToken ? [pageToken] : []);
		let mayRecoverPersistedCursor = pageToken !== undefined;

		for (let pageIndex = 0; pageIndex < DOMAIN_PAGES_PER_SWEEP; pageIndex++) {
			const result = await fetchDomainPageWithCursorRecovery(
				client,
				redis,
				pageToken,
				mayRecoverPersistedCursor
			);
			mayRecoverPersistedCursor = false;
			pageToken = result.requestedPageToken;
			// Finish the whole page before checkpointing it. Any statistics error—
			// including a possibly account-wide 403—stops the sweep at this page.
			for (const domain of result.page.domains) {
				await pushDomainStats(redis, config, client, domain, deadline);
			}

			const nextPageToken = result.page.nextPageToken;
			if (nextPageToken && seenTokens.has(nextPageToken)) {
				logger.warn({ operation: 'domains.list' }, 'Google Postmaster domain cursor repeated');
				await redis.del(DOMAIN_CURSOR_KEY);
				break;
			}
			if (!nextPageToken) {
				await redis.del(DOMAIN_CURSOR_KEY);
				break;
			}
			await redis.set(DOMAIN_CURSOR_KEY, nextPageToken);
			seenTokens.add(nextPageToken);
			pageToken = nextPageToken;
		}
	} catch (error) {
		const details =
			error instanceof GoogleApiError
				? { operation: error.operation, status: error.status, category: error.category }
				: { operation: 'collection', category: 'unexpected' };
		logger.error(details, 'Google Postmaster fetch stopped');
	} finally {
		if (lockAcquired) await releaseCollectionLock(redis, lockToken).catch(() => undefined);
	}
}
