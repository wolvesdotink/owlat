/**
 * Google Postmaster Tools API Integration
 *
 * Pulls domain reputation, spam rate, authentication pass rates, and
 * delivery error data from Google's Postmaster Tools REST API.
 *
 * Requires a Google Cloud service account with Postmaster Tools API access.
 * Set GOOGLE_POSTMASTER_CREDENTIALS to the JSON key file content.
 *
 * Data is stored in Redis and exposed via Prometheus metrics.
 *
 * @see https://developers.google.com/gmail/postmaster/reference/rest
 */

import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { Gauge } from 'prom-client';
import { registry } from './collector.js';
import { logger } from './logger.js';

const POSTMASTER_PREFIX = 'mta:postmaster:';
const TOKEN_KEY = 'mta:postmaster:token';
const TOKEN_TTL = 3500; // ~58 minutes (tokens last 60 min)
const API_BASE = 'https://gmailpostmastertools.googleapis.com/v1';

// ─── Prometheus Metrics ─────────────────────────────────────────────

export const domainReputation = new Gauge({
	name: 'mta_postmaster_domain_reputation',
	help: 'Google Postmaster domain reputation (1=HIGH, 2=MEDIUM, 3=LOW, 4=BAD)',
	labelNames: ['domain'] as const,
	registers: [registry],
});

export const spamRate = new Gauge({
	name: 'mta_postmaster_spam_rate',
	help: 'Google Postmaster user-reported spam rate (0-1)',
	labelNames: ['domain'] as const,
	registers: [registry],
});

export const authenticationRate = new Gauge({
	name: 'mta_postmaster_auth_rate',
	help: 'Google Postmaster authentication pass rate (SPF/DKIM/DMARC)',
	labelNames: ['domain', 'type'] as const,
	registers: [registry],
});

export const deliveryErrors = new Gauge({
	name: 'mta_postmaster_delivery_errors',
	help: 'Google Postmaster delivery error rate by category',
	labelNames: ['domain', 'category'] as const,
	registers: [registry],
});

// ─── Types ──────────────────────────────────────────────────────────

interface ServiceAccountCredentials {
	client_email: string;
	private_key: string;
	token_uri: string;
}

interface PostmasterDomain {
	name: string;
	permission: string;
}

interface TrafficStats {
	name?: string;
	userReportedSpamRatio?: number;
	domainReputation?: 'REPUTATION_UNSPECIFIED' | 'HIGH' | 'MEDIUM' | 'LOW' | 'BAD';
	spfSuccessRatio?: number;
	dkimSuccessRatio?: number;
	dmarcSuccessRatio?: number;
	deliveryErrors?: Array<{
		errorClass?: string;
		errorType?: string;
		errorRatio?: number;
	}>;
}

// ─── Token Management ───────────────────────────────────────────────

/**
 * Create a JWT and exchange it for a Google OAuth2 access token.
 * Uses the service account private key to sign the JWT.
 */
async function getAccessToken(
	redis: Redis,
	credentials: ServiceAccountCredentials
): Promise<string> {
	// Check Redis cache first
	const cached = await redis.get(TOKEN_KEY);
	if (cached) return cached;

	// Build JWT
	const now = Math.floor(Date.now() / 1000);
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
	const payload = Buffer.from(JSON.stringify({
		iss: credentials.client_email,
		scope: 'https://www.googleapis.com/auth/postmaster.readonly',
		aud: credentials.token_uri || 'https://oauth2.googleapis.com/token',
		iat: now,
		exp: now + 3600,
	})).toString('base64url');

	// Sign with the private key
	const { createSign } = await import('crypto');
	const sign = createSign('RSA-SHA256');
	sign.update(`${header}.${payload}`);
	const signature = sign.sign(credentials.private_key, 'base64url');

	const jwt = `${header}.${payload}.${signature}`;

	// Exchange JWT for access token
	const tokenUrl = credentials.token_uri || 'https://oauth2.googleapis.com/token';
	const response = await fetch(tokenUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			assertion: jwt,
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
	}

	const data = await response.json() as { access_token: string };
	const token = data.access_token;

	// Cache in Redis
	await redis.set(TOKEN_KEY, token, 'EX', TOKEN_TTL);

	return token;
}

// ─── API Calls ──────────────────────────────────────────────────────

/**
 * List all verified domains in Postmaster Tools
 */
async function listDomains(token: string): Promise<PostmasterDomain[]> {
	const response = await fetch(`${API_BASE}/domains`, {
		headers: { Authorization: `Bearer ${token}` },
	});

	if (!response.ok) {
		throw new Error(`List domains failed: ${response.status}`);
	}

	const data = await response.json() as { domains?: PostmasterDomain[] };
	return data.domains ?? [];
}

/**
 * Get traffic stats for a domain on a given date
 *
 * @param domainResource - e.g., "domains/example.com"
 * @param date - YYYY-MM-DD format
 */
async function getTrafficStats(
	token: string,
	domainResource: string,
	date: string
): Promise<TrafficStats | null> {
	// API expects date in yyyymmdd format for the resource name
	const dateCompact = date.replace(/-/g, '');
	const url = `${API_BASE}/${domainResource}/trafficStats/${dateCompact}`;

	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${token}` },
	});

	if (response.status === 404) {
		return null; // No data for this date
	}

	if (!response.ok) {
		throw new Error(`Get traffic stats failed: ${response.status}`);
	}

	return await response.json() as TrafficStats;
}

// ─── Reputation Score Mapping ───────────────────────────────────────

function reputationToNumber(rep?: string): number {
	switch (rep) {
		case 'HIGH': return 1;
		case 'MEDIUM': return 2;
		case 'LOW': return 3;
		case 'BAD': return 4;
		default: return 0;
	}
}

// ─── Main Cron Function ─────────────────────────────────────────────

/**
 * Fetch Postmaster data for all verified domains.
 * Called periodically (e.g., every hour) by the leader instance.
 *
 * Stores data in Redis and updates Prometheus gauges.
 */
export async function fetchPostmasterData(
	redis: Redis,
	config: MtaConfig
): Promise<void> {
	if (!config.googlePostmasterCredentials) {
		return; // Not configured
	}

	let credentials: ServiceAccountCredentials;
	try {
		credentials = JSON.parse(config.googlePostmasterCredentials);
	} catch {
		logger.error('Invalid GOOGLE_POSTMASTER_CREDENTIALS JSON');
		return;
	}

	try {
		const token = await getAccessToken(redis, credentials);
		const domains = await listDomains(token);

		if (domains.length === 0) {
			logger.debug('No verified domains in Postmaster Tools');
			return;
		}

		// Fetch stats for yesterday (today's data is rarely available)
		const yesterday = new Date(Date.now() - 86400_000).toISOString().split('T')[0]!;

		for (const domain of domains) {
			const domainName = domain.name.replace('domains/', '');

			try {
				const stats = await getTrafficStats(token, domain.name, yesterday);
				if (!stats) {
					logger.debug({ domain: domainName, date: yesterday }, 'No Postmaster data for date');
					continue;
				}

				// Store in Redis
				const redisKey = `${POSTMASTER_PREFIX}${domainName}:${yesterday}`;
				await redis.hset(redisKey, {
					reputation: stats.domainReputation ?? 'unknown',
					spamRate: String(stats.userReportedSpamRatio ?? 0),
					spfRate: String(stats.spfSuccessRatio ?? 0),
					dkimRate: String(stats.dkimSuccessRatio ?? 0),
					dmarcRate: String(stats.dmarcSuccessRatio ?? 0),
					fetchedAt: String(Date.now()),
				});
				await redis.expire(redisKey, 30 * 86400); // Keep 30 days

				// Update Prometheus gauges
				domainReputation.set({ domain: domainName }, reputationToNumber(stats.domainReputation));

				if (stats.userReportedSpamRatio !== undefined) {
					spamRate.set({ domain: domainName }, stats.userReportedSpamRatio);
				}

				if (stats.spfSuccessRatio !== undefined) {
					authenticationRate.set({ domain: domainName, type: 'spf' }, stats.spfSuccessRatio);
				}
				if (stats.dkimSuccessRatio !== undefined) {
					authenticationRate.set({ domain: domainName, type: 'dkim' }, stats.dkimSuccessRatio);
				}
				if (stats.dmarcSuccessRatio !== undefined) {
					authenticationRate.set({ domain: domainName, type: 'dmarc' }, stats.dmarcSuccessRatio);
				}

				if (stats.deliveryErrors) {
					for (const err of stats.deliveryErrors) {
						if (err.errorClass && err.errorRatio !== undefined) {
							deliveryErrors.set(
								{ domain: domainName, category: err.errorClass },
								err.errorRatio
							);
						}
					}
				}

				logger.info(
					{
						domain: domainName,
						reputation: stats.domainReputation,
						spamRate: stats.userReportedSpamRatio,
						date: yesterday,
					},
					'Postmaster data fetched'
				);
			} catch (err) {
				logger.warn({ err, domain: domainName }, 'Failed to fetch Postmaster stats for domain');
			}
		}
	} catch (err) {
		logger.error({ err }, 'Postmaster API fetch failed');
	}
}

/**
 * Get stored Postmaster data for a domain and date
 */
export async function getStoredPostmasterData(
	redis: Redis,
	domain: string,
	date: string
): Promise<Record<string, string> | null> {
	const key = `${POSTMASTER_PREFIX}${domain}:${date}`;
	const data = await redis.hgetall(key);
	return Object.keys(data).length > 0 ? data : null;
}
