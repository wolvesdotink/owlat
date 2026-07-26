/**
 * Best-effort Google Postmaster Tools v2 extras: the point-in-time Compliance
 * Status verdict and the delivery-error breakdown by category.
 *
 * Both are strictly ADDITIVE. Every failure here — a permission the operator
 * did not grant, a dimension filter Google rejects, a shape we do not
 * recognise — is logged once and swallowed, so the sweep still delivers the
 * daily ratio metrics the collector already collects today.
 *
 * @see https://developers.google.com/workspace/gmail/postmaster/reference/rest/v2/domains.domainStats/query
 */

import type {
	GooglePostmasterComplianceCheck,
	GooglePostmasterDeliveryErrorShare,
} from '../types.js';
import {
	DELIVERY_ERROR_METRIC_PREFIX,
	GOOGLE_POSTMASTER_API_BASE,
	type GooglePostmasterClient,
	POSTMASTER_DELIVERY_ERROR_CATEGORIES,
	googleDateObject,
	isRecord,
	normalizeDomainStat,
	parseComplianceStatus,
} from './googlePostmasterApi.js';
import { logger } from './logger.js';

const DELIVERY_ERROR_PAGE_SIZE = 200;

/** The current Compliance Status verdict for one domain; `[]` when unavailable. */
export async function fetchComplianceChecks(
	client: GooglePostmasterClient,
	domain: string
): Promise<GooglePostmasterComplianceCheck[]> {
	try {
		const payload = await client.json(
			'domains.complianceStatus',
			`${GOOGLE_POSTMASTER_API_BASE}/domains/${encodeURIComponent(domain)}/complianceStatus`
		);
		return parseComplianceStatus(payload);
	} catch {
		logger.warn(
			{ operation: 'domains.complianceStatus' },
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
	client: GooglePostmasterClient,
	domain: string,
	startDate: string,
	endDate: string
): Promise<Map<string, GooglePostmasterDeliveryErrorShare[]>> {
	const byDate = new Map<string, GooglePostmasterDeliveryErrorShare[]>();
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
	} catch {
		logger.warn(
			{ operation: 'domains.domainStats.query.deliveryErrors' },
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
