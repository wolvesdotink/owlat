/** OAuth transport and wire validation for Google Postmaster Tools API v2. */

import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import type { GooglePostmasterComplianceCheck, GooglePostmasterStatsEvent } from '../types.js';

const TOKEN_KEY = 'mta:postmaster:oauth-access-token';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MAX_TRANSIENT_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

export const GOOGLE_POSTMASTER_API_BASE = 'https://gmailpostmastertools.googleapis.com/v2';
export const GOOGLE_POSTMASTER_SPAM_RATE_METRIC_NAME = 'userReportedSpamRatio';

/**
 * The ratio metrics requested in one v2 `domainStats:query`. `name` is OUR
 * label: the API echoes each `metricDefinitions[].name` back on every
 * `DomainStat`, so the response parser keys on names this module owns rather
 * than on Google's enum spelling. Adding a metric here is the only change
 * needed to collect it — the parser is name-driven and forward-compatible.
 */
export const POSTMASTER_RATIO_METRICS = [
	{ name: GOOGLE_POSTMASTER_SPAM_RATE_METRIC_NAME, standardMetric: 'SPAM_RATE' },
	{ name: 'spfSuccessRatio', standardMetric: 'SPF_SUCCESS_RATE' },
	{ name: 'dkimSuccessRatio', standardMetric: 'DKIM_SUCCESS_RATE' },
	{ name: 'dmarcSuccessRatio', standardMetric: 'DMARC_SUCCESS_RATE' },
	{ name: 'deliveryErrorRatio', standardMetric: 'DELIVERY_ERROR_RATE' },
] as const;

const RATIO_METRIC_NAMES: ReadonlySet<string> = new Set(
	POSTMASTER_RATIO_METRICS.map((metric) => metric.name)
);

/**
 * Delivery-error categories broken out of `DELIVERY_ERROR_RATE` by dimension.
 * The breakdown is collected by a SEPARATE, best-effort query so that a
 * rejected dimension filter can never cost us the aggregate ratios above.
 */
export const POSTMASTER_DELIVERY_ERROR_CATEGORIES = [
	'RATE_LIMIT_EXCEEDED',
	'SUSPECTED_SPAM',
	'CONTENT_SPAMMY',
	'BAD_ATTACHMENT',
	'BAD_DMARC_POLICY',
	'LOW_IP_REPUTATION',
	'LOW_DOMAIN_REPUTATION',
	'IP_IN_RBL',
	'DOMAIN_IN_RBL',
	'BAD_PTR_RECORD',
] as const;

export const DELIVERY_ERROR_METRIC_PREFIX = 'deliveryError.';

const DELIVERY_ERROR_METRIC_NAMES: ReadonlySet<string> = new Set(
	POSTMASTER_DELIVERY_ERROR_CATEGORIES.map(
		(category) => `${DELIVERY_ERROR_METRIC_PREFIX}${category}`
	)
);

/** Upper bound on the Compliance Status checks retained from one response. */
export const POSTMASTER_COMPLIANCE_CHECK_LIMIT = 32;

/** Scopes that must be granted when the operator creates the offline refresh token. */
export const GOOGLE_POSTMASTER_AUTHORIZATION_SCOPES = [
	'https://www.googleapis.com/auth/postmaster.domain',
	'https://www.googleapis.com/auth/postmaster.traffic.readonly',
] as const;

export interface PostmasterDomainWire {
	name: string;
	permission: 'OWNER' | 'ADMIN' | 'READER';
	verificationState: 'VERIFIED';
}

interface GoogleDateWire {
	year?: unknown;
	month?: unknown;
	day?: unknown;
}

interface DomainStatWire {
	date?: unknown;
	metric?: unknown;
	value?: unknown;
}

export type GoogleApiErrorCategory =
	| 'auth'
	| 'permission'
	| 'rate_limit'
	| 'transient'
	| 'request'
	| 'budget';

export class GoogleApiError extends Error {
	constructor(
		readonly operation: string,
		readonly status: number,
		readonly category: GoogleApiErrorCategory
	) {
		super(`Google Postmaster ${operation} failed (${category}, HTTP ${status})`);
		this.name = 'GoogleApiError';
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRatio(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseGoogleDate(value: unknown): string | null {
	if (!isRecord(value)) return null;
	const { year, month, day } = value as GoogleDateWire;
	if (![year, month, day].every(Number.isSafeInteger)) return null;
	const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
	const parsed = Date.parse(`${date}T00:00:00.000Z`);
	return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date
		? date
		: null;
}

/** `YYYY-MM-DD` → the `google.type.Date` object the v2 query body expects. */
export function googleDateObject(date: string): { year: number; month: number; day: number } {
	const [year, month, day] = date.split('-').map(Number);
	return { year: year ?? 0, month: month ?? 0, day: day ?? 0 };
}

/** One `(date, metric)` ratio observation lifted off a v2 `DomainStat`. */
export interface DomainStatObservation {
	date: string;
	metric: string;
	ratio: number;
}

/**
 * Normalize one v2 `DomainStat`. Metric names this collector did not request
 * are dropped rather than rejected: Google may add metrics to a response at
 * any time and an unknown name must never fail a sweep.
 */
export function normalizeDomainStat(raw: DomainStatWire): DomainStatObservation | null {
	const metric = raw.metric;
	if (typeof metric !== 'string' || !isRecord(raw.value)) return null;
	if (!RATIO_METRIC_NAMES.has(metric) && !DELIVERY_ERROR_METRIC_NAMES.has(metric)) return null;
	const date = parseGoogleDate(raw.date);
	const ratio = raw.value['doubleValue'] ?? raw.value['floatValue'];
	if (!date || !isRatio(ratio)) return null;
	return { date, metric, ratio };
}

const COMPLIANCE_STATE_BY_WIRE: Readonly<Record<string, GooglePostmasterComplianceCheck['state']>> =
	{
		PASSING: 'passing',
		PASS: 'passing',
		COMPLIANT: 'passing',
		OK: 'passing',
		FAILING: 'failing',
		FAIL: 'failing',
		NON_COMPLIANT: 'failing',
	};

function normalizeCheckName(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > 128) return null;
	const name = value.trim().toUpperCase();
	// Deliberately strict: the name is stored and rendered, so only an opaque
	// enum-shaped token is accepted. Anything else is dropped, never escaped.
	return /^[A-Z0-9_]{1,64}$/.test(name) ? name : null;
}

/**
 * Parse a v2 Compliance Status payload into de-duplicated, bounded checks.
 *
 * Forward-compatible by construction: an unrecognised check name is retained
 * verbatim (the UI has a generic renderer for it) and an unrecognised state
 * degrades to `'unknown'`. Never throws — a malformed payload yields `[]`.
 */
export function parseComplianceStatus(value: unknown): GooglePostmasterComplianceCheck[] {
	if (!isRecord(value)) return [];
	const rawChecks = value['checks'] ?? value['complianceChecks'];
	if (!Array.isArray(rawChecks)) return [];
	const byName = new Map<string, GooglePostmasterComplianceCheck>();
	for (const raw of rawChecks) {
		if (byName.size >= POSTMASTER_COMPLIANCE_CHECK_LIMIT) break;
		if (!isRecord(raw)) continue;
		const name = normalizeCheckName(raw['name'] ?? raw['checkName']);
		if (name === null || byName.has(name)) continue;
		const wireState = raw['state'] ?? raw['status'];
		const state =
			typeof wireState === 'string' && wireState.length <= 64
				? (COMPLIANCE_STATE_BY_WIRE[wireState.trim().toUpperCase()] ?? 'unknown')
				: 'unknown';
		byName.set(name, { name, state });
	}
	return [...byName.values()];
}

function retryAfterMs(response: Response, retryIndex: number): number {
	const jitterMs = Math.floor(Math.random() * 250);
	const header = response.headers.get('retry-after');
	if (header !== null) {
		const seconds = Number(header);
		if (Number.isFinite(seconds) && seconds >= 0) {
			return Math.floor(seconds * 1_000) + jitterMs;
		}
		const date = Date.parse(header);
		if (Number.isFinite(date)) {
			return Math.max(0, date - Date.now()) + jitterMs;
		}
	}
	const exponentialMs = 1_000 * 2 ** retryIndex;
	return Math.min(MAX_RETRY_DELAY_MS, exponentialMs + jitterMs);
}

async function wait(ms: number): Promise<void> {
	if (ms <= 0) return;
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function googleErrorReason(response: Response): Promise<string | null> {
	try {
		const payload = (await response.clone().json()) as unknown;
		if (!isRecord(payload) || !isRecord(payload['error'])) return null;
		const errors = payload['error']['errors'];
		if (!Array.isArray(errors)) return null;
		for (const error of errors) {
			if (isRecord(error) && typeof error['reason'] === 'string') return error['reason'];
		}
	} catch {
		// Error bodies are optional and are never logged.
	}
	return null;
}

async function classifyError(response: Response): Promise<GoogleApiErrorCategory> {
	if (response.status === 401) return 'auth';
	if (response.status === 429) return 'rate_limit';
	if (response.status >= 500) return 'transient';
	if (response.status === 403) {
		const reason = await googleErrorReason(response);
		return reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'
			? 'rate_limit'
			: 'permission';
	}
	return 'request';
}

function isRetryable(category: GoogleApiErrorCategory): boolean {
	return category === 'rate_limit' || category === 'transient';
}

function assertRunBudget(deadline: number, operation: string, delayMs = 0): void {
	if (Date.now() + delayMs >= deadline) {
		throw new GoogleApiError(operation, 0, 'budget');
	}
}

async function fetchWithTransientRetries(
	operation: string,
	deadline: number,
	input: string,
	init: RequestInit
): Promise<Response> {
	for (let retryIndex = 0; ; retryIndex++) {
		assertRunBudget(deadline, operation);
		const remainingMs = deadline - Date.now();
		let response: Response;
		try {
			response = await fetch(input, {
				...init,
				signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remainingMs)),
			});
		} catch {
			if (retryIndex >= MAX_TRANSIENT_RETRIES) {
				throw new GoogleApiError(operation, 0, 'transient');
			}
			const delayMs = Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** retryIndex);
			assertRunBudget(deadline, operation, delayMs);
			await wait(delayMs);
			continue;
		}

		if (response.ok) return response;
		const category = await classifyError(response);
		if (!isRetryable(category) || retryIndex >= MAX_TRANSIENT_RETRIES) return response;
		const delayMs = retryAfterMs(response, retryIndex);
		assertRunBudget(deadline, operation, delayMs);
		await wait(delayMs);
	}
}

async function fetchAccessToken(
	credentials: NonNullable<MtaConfig['googlePostmaster']>,
	deadline: number
): Promise<{ accessToken: string; cacheTtlSeconds: number }> {
	const response = await fetchWithTransientRetries('oauth.token', deadline, TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: credentials.clientId,
			client_secret: credentials.clientSecret,
			refresh_token: credentials.refreshToken,
			grant_type: 'refresh_token',
		}),
	});
	if (!response.ok) {
		throw new GoogleApiError('oauth.token', response.status, await classifyError(response));
	}
	const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
	if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
		throw new GoogleApiError('oauth.token', response.status, 'auth');
	}
	const cacheTtlSeconds =
		typeof payload.expires_in === 'number' &&
		Number.isFinite(payload.expires_in) &&
		payload.expires_in > 0
			? Math.max(0, Math.floor(payload.expires_in) - 60)
			: 0;
	return { accessToken: payload.access_token, cacheTtlSeconds };
}

export class GooglePostmasterClient {
	constructor(
		private readonly redis: Redis,
		private readonly credentials: NonNullable<MtaConfig['googlePostmaster']>,
		private readonly deadline: number
	) {}

	private async accessToken(): Promise<string> {
		const cached = await this.redis.get(TOKEN_KEY);
		if (cached) return cached;
		const token = await fetchAccessToken(this.credentials, this.deadline);
		if (token.cacheTtlSeconds > 0) {
			await this.redis.set(TOKEN_KEY, token.accessToken, 'EX', token.cacheTtlSeconds);
		}
		return token.accessToken;
	}

	async json(operation: string, url: string, init: RequestInit = {}): Promise<unknown> {
		let authRefreshes = 0;
		for (;;) {
			assertRunBudget(this.deadline, operation);
			const token = await this.accessToken();
			const response = await fetchWithTransientRetries(operation, this.deadline, url, {
				...init,
				headers: {
					...init.headers,
					Authorization: `Bearer ${token}`,
				},
			});
			if (response.ok) return response.json();
			const category = await classifyError(response);
			if (category === 'auth' && authRefreshes === 0) {
				authRefreshes += 1;
				await this.redis.del(TOKEN_KEY);
				continue;
			}
			throw new GoogleApiError(operation, response.status, category);
		}
	}
}

export function parseReadableVerifiedDomain(value: unknown): PostmasterDomainWire | null {
	if (!isRecord(value)) return null;
	if (
		typeof value['name'] !== 'string' ||
		(value['permission'] !== 'OWNER' &&
			value['permission'] !== 'ADMIN' &&
			value['permission'] !== 'READER') ||
		value['verificationState'] !== 'VERIFIED'
	) {
		return null;
	}
	const domain = value['name'].replace(/^domains\//, '').toLowerCase();
	if (
		value['name'] !== `domains/${domain}` ||
		domain.length > 253 ||
		!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(domain)
	) {
		return null;
	}
	return {
		name: `domains/${domain}`,
		permission: value['permission'],
		verificationState: 'VERIFIED',
	};
}

/**
 * Fold the flat `(date, metric)` observations of one page into one event per
 * UTC day. `SPAM_RATE` is the one metric Convex requires, so a day Google has
 * not reported it for is skipped and picked up by a later sweep; every other
 * metric is attached only when present, because Google withholds a metric on
 * days a domain had too little traffic and that is normal operation.
 */
export function buildStatsEvents(
	domain: string,
	observations: DomainStatObservation[],
	timestamp: number
): GooglePostmasterStatsEvent[] {
	const ratiosByDate = new Map<string, Map<string, number>>();
	for (const observation of observations) {
		const ratios = ratiosByDate.get(observation.date) ?? new Map<string, number>();
		if (!ratios.has(observation.metric)) ratios.set(observation.metric, observation.ratio);
		ratiosByDate.set(observation.date, ratios);
	}
	const events: GooglePostmasterStatsEvent[] = [];
	for (const [date, ratios] of ratiosByDate) {
		const userReportedSpamRatio = ratios.get(GOOGLE_POSTMASTER_SPAM_RATE_METRIC_NAME);
		if (userReportedSpamRatio === undefined) continue;
		const spfSuccessRatio = ratios.get('spfSuccessRatio');
		const dkimSuccessRatio = ratios.get('dkimSuccessRatio');
		const dmarcSuccessRatio = ratios.get('dmarcSuccessRatio');
		const deliveryErrorRatio = ratios.get('deliveryErrorRatio');
		events.push({
			event: 'postmaster.stats',
			domain,
			date,
			userReportedSpamRatio,
			...(spfSuccessRatio !== undefined ? { spfSuccessRatio } : {}),
			...(dkimSuccessRatio !== undefined ? { dkimSuccessRatio } : {}),
			...(dmarcSuccessRatio !== undefined ? { dmarcSuccessRatio } : {}),
			...(deliveryErrorRatio !== undefined ? { deliveryErrorRatio } : {}),
			timestamp,
		});
	}
	return events;
}
