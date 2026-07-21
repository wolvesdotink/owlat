/** OAuth transport and wire validation for Google Postmaster Tools API v2. */

import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import type { GooglePostmasterStatsEvent } from '../types.js';

const TOKEN_KEY = 'mta:postmaster:oauth-access-token';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MAX_TRANSIENT_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

export const GOOGLE_POSTMASTER_API_BASE = 'https://gmailpostmastertools.googleapis.com/v2';
export const GOOGLE_POSTMASTER_SPAM_RATE_METRIC_NAME = 'userReportedSpamRatio';

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

/** Normalize one v2 `DomainStat` for the requested SPAM_RATE metric. */
export function normalizeDomainStat(
	domain: string,
	raw: DomainStatWire
): GooglePostmasterStatsEvent | null {
	if (raw.metric !== GOOGLE_POSTMASTER_SPAM_RATE_METRIC_NAME || !isRecord(raw.value)) return null;
	const date = parseGoogleDate(raw.date);
	const ratio = raw.value['doubleValue'] ?? raw.value['floatValue'];
	if (!date || !isRatio(ratio)) return null;
	return {
		event: 'postmaster.stats',
		domain,
		date,
		userReportedSpamRatio: ratio,
		timestamp: Date.now(),
	};
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
