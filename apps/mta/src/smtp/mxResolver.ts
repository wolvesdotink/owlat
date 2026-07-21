/** DNS MX resolution with a Redis-backed, typed delivery outcome. */

import { resolveMx as dnsResolveMx } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import type Redis from 'ioredis';
import { logger } from '../monitoring/logger.js';

const MX_CACHE_TTL_SECONDS = 3600;
const MX_CACHE_PREFIX = 'mta:mx-cache:v2:';
const MAX_MX_HOSTS = 50;

export interface MxHost {
	exchange: string;
	priority: number;
}

export type MxResolution =
	| { status: 'deliverable'; source: 'mx' | 'implicit'; hosts: MxHost[] }
	| { status: 'null-mx' }
	| { status: 'domain-not-found'; reason: string }
	| { status: 'temporary-failure'; reason: string };

export interface DnsMxRecord {
	exchange: string;
	priority: number;
}

export type MxDnsLookup = (domain: string) => Promise<DnsMxRecord[]>;

function normalizeDomain(value: string): string {
	const normalized = value.trim().toLowerCase().replace(/\.$/, '');
	return domainToASCII(normalized) || normalized;
}

function normalizeExchange(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, '');
}

function isMxHost(value: unknown): value is MxHost {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const record = value as Partial<MxHost>;
	return (
		typeof record.exchange === 'string' &&
		record.exchange.length > 0 &&
		record.exchange.length <= 253 &&
		typeof record.priority === 'number' &&
		Number.isSafeInteger(record.priority) &&
		record.priority >= 0 &&
		record.priority <= 65_535
	);
}

function isCachedResolution(
	value: unknown
): value is Extract<MxResolution, { status: 'deliverable' | 'null-mx' }> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const resolution = value as Partial<MxResolution>;
	if (resolution.status === 'null-mx') return true;
	return (
		resolution.status === 'deliverable' &&
		(resolution.source === 'mx' || resolution.source === 'implicit') &&
		Array.isArray(resolution.hosts) &&
		resolution.hosts.length > 0 &&
		resolution.hosts.length <= MAX_MX_HOSTS &&
		resolution.hosts.every(isMxHost)
	);
}

function parseCachedResolution(
	raw: string
): Extract<MxResolution, { status: 'deliverable' | 'null-mx' }> | null {
	try {
		const value: unknown = JSON.parse(raw);
		return isCachedResolution(value) ? value : null;
	} catch {
		return null;
	}
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
	return typeof error.code === 'string' ? error.code.toUpperCase() : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function implicitResolution(domain: string): MxResolution {
	return {
		status: 'deliverable',
		source: 'implicit',
		hosts: [{ exchange: domain, priority: 0 }],
	};
}

function recordsToResolution(records: readonly DnsMxRecord[], domain: string): MxResolution {
	// RFC 7505 Null MX is the single preference-0 record whose exchange is '.'.
	const nullRecords = records.filter(
		(record) => record.priority === 0 && normalizeExchange(record.exchange) === ''
	);
	if (nullRecords.length > 0) {
		return records.length === 1
			? { status: 'null-mx' }
			: {
					status: 'temporary-failure',
					reason: `Invalid MX RRset for ${domain}: Null MX was combined with other records`,
				};
	}

	if (records.length === 0) return implicitResolution(domain);

	const hosts = records
		.slice(0, MAX_MX_HOSTS)
		.map((record) => ({
			exchange: normalizeExchange(record.exchange),
			priority: record.priority,
		}))
		.filter(isMxHost)
		.sort((left, right) => left.priority - right.priority);

	return hosts.length > 0
		? { status: 'deliverable', source: 'mx', hosts }
		: {
				status: 'temporary-failure',
				reason: `MX lookup for ${domain} returned no usable records`,
			};
}

/**
 * Resolve a recipient route without conflating authoritative absence,
 * non-existent domains, and temporary resolver failures.
 */
export async function resolveMxDestination(
	redis: Redis,
	recipientDomain: string,
	lookup: MxDnsLookup = dnsResolveMx
): Promise<MxResolution> {
	const domain = normalizeDomain(recipientDomain);
	const cacheKey = `${MX_CACHE_PREFIX}${domain}`;

	try {
		const cached = await redis.get(cacheKey);
		if (cached) {
			const parsed = parseCachedResolution(cached);
			if (parsed) return parsed;
			logger.warn({ domain }, 'Ignoring malformed MX cache entry');
		}
	} catch (err) {
		logger.warn({ domain, err }, 'MX cache read failed, falling back to DNS');
	}

	let resolution: MxResolution;
	try {
		resolution = recordsToResolution(await lookup(domain), domain);
	} catch (err) {
		const code = errorCode(err);
		if (code === 'ENODATA' || code === 'NODATA') {
			resolution = implicitResolution(domain);
		} else if (code === 'ENOTFOUND' || code === 'NXDOMAIN') {
			return {
				status: 'domain-not-found',
				reason: `Recipient domain ${domain} does not exist (${code})`,
			};
		} else {
			const reason = `Temporary MX lookup failure for ${domain}${code ? ` (${code})` : ''}: ${errorMessage(err)}`;
			logger.warn({ domain, code, err }, 'Temporary MX DNS resolution failure');
			return { status: 'temporary-failure', reason };
		}
	}

	// Only authoritative, stable answers are cached. Temporary failures and
	// NXDOMAIN stay uncached so a later retry observes DNS recovery promptly.
	if (resolution.status === 'deliverable' || resolution.status === 'null-mx') {
		try {
			await redis.set(cacheKey, JSON.stringify(resolution), 'EX', MX_CACHE_TTL_SECONDS);
		} catch (err) {
			logger.warn({ domain, err }, 'MX cache write failed');
		}
	}

	return resolution;
}
