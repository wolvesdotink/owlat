/**
 * The compliance-side Google Postmaster Tools v2 collectors: the point-in-time
 * Compliance Status verdict and the delivery-error breakdown by category.
 *
 * Both are strictly ADDITIVE. A permission the operator did not grant, a
 * dimension filter Google rejects, a shape we do not recognise — each is
 * reported once and swallowed, so the sweep still delivers the daily ratio
 * metrics the collector already collects today.
 *
 * The one failure that is NOT swallowed is budget exhaustion: it is the
 * sweep's own stop signal rather than an upstream problem, so it propagates.
 *
 * @see https://developers.google.com/workspace/gmail/postmaster/reference/rest/v2/domains.domainStats/query
 */

import type Redis from 'ioredis';
import type {
	PostmasterComplianceCheck,
	PostmasterDeliveryError,
} from '@owlat/shared/mtaWebhookEvent';
import type { MtaConfig } from '../config.js';
import { notifyPostmasterConvex } from '../webhooks/convexNotifier.js';
import {
	DELIVERY_ERROR_METRIC_PREFIX,
	GOOGLE_POSTMASTER_API_BASE,
	GoogleApiError,
	type GooglePostmasterClient,
	POSTMASTER_DELIVERY_ERROR_CATEGORIES,
	googleDateObject,
	isRecord,
	normalizeDomainStat,
	parseComplianceStatus,
	utcDateDaysAgo,
} from './googlePostmasterApi.js';
import { logger } from './logger.js';

const DELIVERY_ERROR_PAGE_SIZE = 200;
export const COMPLIANCE_PUSHED_PREFIX = 'mta:postmaster:compliance-pushed:';
const PUSH_RECEIPT_TTL_SECONDS = 14 * 24 * 60 * 60;
const UNAVAILABLE_WARN_PREFIX = 'mta:postmaster:unavailable-warned:';
/** One warning per operation per domain per day, not one per hourly sweep. */
const UNAVAILABLE_WARN_TTL_SECONDS = 24 * 60 * 60;

/**
 * Report an unavailable best-effort collector once per day per domain.
 *
 * A permission the operator never granted is a permanent condition: without
 * this marker it would produce a warning for every domain on every sweep,
 * forever, and drown the signal an operator actually needs to see.
 */
async function warnUnavailable(
	redis: Redis,
	operation: string,
	domain: string,
	message: string
): Promise<void> {
	try {
		const claimed = await redis.set(
			`${UNAVAILABLE_WARN_PREFIX}${operation}:${domain}`,
			'1',
			'EX',
			UNAVAILABLE_WARN_TTL_SECONDS,
			'NX'
		);
		if (claimed !== 'OK') return;
	} catch {
		// A Redis hiccup must not silence an operator-facing warning.
	}
	logger.warn({ operation }, message);
}

/** Budget exhaustion stops the whole sweep; everything else is swallowed. */
function rethrowIfBudgetExhausted(error: unknown): void {
	if (error instanceof GoogleApiError && error.category === 'budget') throw error;
}

/** The current Compliance Status verdict for one domain; `[]` when unavailable. */
async function fetchComplianceChecks(
	redis: Redis,
	client: GooglePostmasterClient,
	domain: string
): Promise<PostmasterComplianceCheck[]> {
	try {
		const payload = await client.json(
			'domains.complianceStatus',
			`${GOOGLE_POSTMASTER_API_BASE}/domains/${encodeURIComponent(domain)}/complianceStatus`
		);
		return parseComplianceStatus(payload);
	} catch (error) {
		rethrowIfBudgetExhausted(error);
		await warnUnavailable(
			redis,
			'domains.complianceStatus',
			domain,
			'Google Postmaster compliance status unavailable'
		);
		return [];
	}
}

function deliveryErrorQueryBody(startDate: string, endDate: string) {
	return {
		metricDefinitions: POSTMASTER_DELIVERY_ERROR_CATEGORIES.map((category) => ({
			name: `${DELIVERY_ERROR_METRIC_PREFIX}${category}`,
			baseMetric: { standardMetric: 'DELIVERY_ERROR_RATE' },
			dimensionFilters: [{ dimension: 'DELIVERY_ERROR_TYPE', stringFilter: { value: category } }],
		})),
		timeQuery: {
			dateRanges: {
				dateRanges: [{ start: googleDateObject(startDate), end: googleDateObject(endDate) }],
			},
		},
		pageSize: DELIVERY_ERROR_PAGE_SIZE,
		aggregationGranularity: 'DAILY',
	};
}

/**
 * Delivery-error shares per UTC day, keyed by `YYYY-MM-DD`. Only the first
 * page is read: the breakdown is a hint for the operator, never a gate input,
 * and one page already covers every category over the backfill window.
 */
export async function fetchDeliveryErrorShares(
	redis: Redis,
	client: GooglePostmasterClient,
	domain: string,
	startDate: string,
	endDate: string
): Promise<Map<string, PostmasterDeliveryError[]>> {
	const byDate = new Map<string, PostmasterDeliveryError[]>();
	let payload: unknown;
	try {
		payload = await client.json(
			'domains.domainStats.query.deliveryErrors',
			`${GOOGLE_POSTMASTER_API_BASE}/domains/${encodeURIComponent(domain)}/domainStats:query`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(deliveryErrorQueryBody(startDate, endDate)),
			}
		);
	} catch (error) {
		rethrowIfBudgetExhausted(error);
		await warnUnavailable(
			redis,
			'domains.domainStats.query.deliveryErrors',
			domain,
			'Google Postmaster delivery-error breakdown unavailable'
		);
		return byDate;
	}
	if (!isRecord(payload) || !Array.isArray(payload['domainStats'])) return byDate;
	for (const raw of payload['domainStats']) {
		if (!isRecord(raw)) continue;
		const observation = normalizeDomainStat(raw);
		if (
			!observation ||
			!observation.metric.startsWith(DELIVERY_ERROR_METRIC_PREFIX) ||
			observation.date < startDate ||
			observation.date > endDate ||
			observation.ratio === 0
		) {
			continue;
		}
		const category = observation.metric.slice(DELIVERY_ERROR_METRIC_PREFIX.length);
		const shares = byDate.get(observation.date) ?? [];
		if (shares.some((share) => share.category === category)) continue;
		shares.push({ category, ratio: observation.ratio });
		byDate.set(observation.date, shares);
	}
	return byDate;
}

/**
 * Push today's Compliance Status verdict once per UTC day.
 *
 * Additive-only: an unavailable verdict, a rejected push or a lost
 * authorization all leave the receipt unwritten and return quietly. The
 * statistics sweep is never interrupted by compliance collection.
 */
export async function pushComplianceStatus(
	redis: Redis,
	config: MtaConfig,
	client: GooglePostmasterClient,
	domainName: string,
	deadline: number
): Promise<void> {
	const date = utcDateDaysAgo(0);
	const receiptKey = `${COMPLIANCE_PUSHED_PREFIX}${domainName}:${date}`;
	if (await redis.exists(receiptKey)) return;
	const checks = await fetchComplianceChecks(redis, client, domainName);
	if (checks.length === 0) return;
	const acknowledgement = await notifyPostmasterConvex(
		{ event: 'postmaster.compliance', domain: domainName, date, checks, timestamp: Date.now() },
		config,
		{ deadline }
	);
	if (acknowledgement.disposition !== 'accepted_authorized') return;
	await redis.set(receiptKey, '1', 'EX', PUSH_RECEIPT_TTL_SECONDS);
}
