/**
 * DNSSEC-aware MX and address discovery for DANE SMTP delivery (RFC 7672 §2).
 *
 * The legacy MX resolver intentionally remains the normal non-DANE path. This
 * resolver is used only when a validating DoH endpoint is configured, and keeps
 * the DNSSEC state attached to each destination so later TLS policy cannot
 * accidentally describe an insecure MX redirection as authenticated delivery
 * to the recipient domain.
 */

import type Redis from 'ioredis';
import { queryDohJson, type DohResponse } from './dohResolver.js';

const MX_RRTYPE = 15;
const A_RRTYPE = 1;
const AAAA_RRTYPE = 28;
const DNS_RCODE_NOERROR = 0;
const DNS_RCODE_NXDOMAIN = 3;
const CACHE_PREFIX = 'mta:dane-mx:';
const CACHE_TTL_SECONDS = 300;

export type DnsSecurity = 'secure' | 'insecure' | 'indeterminate';

export interface DaneMxDestination {
	mxHostname: string;
	preference: number;
	mxSecurity: Exclude<DnsSecurity, 'indeterminate'>;
	addressSecurity: DnsSecurity;
	addresses: string[];
}

export type DaneMxLookupResult =
	| { status: 'destinations'; destinations: DaneMxDestination[] }
	| { status: 'not-found' }
	| { status: 'lookup-failed'; reason: string };

function normalizeHostname(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, '');
}

function dnsStatus(response: DohResponse): number {
	return response.Status ?? DNS_RCODE_NOERROR;
}

function isSuccessfulDnsResponse(response: DohResponse): boolean {
	const status = dnsStatus(response);
	return status === DNS_RCODE_NOERROR || status === DNS_RCODE_NXDOMAIN;
}

function parseMxData(data: string): { preference: number; mxHostname: string } | null {
	const match = data.trim().match(/^(\d+)\s+([^\s]+)$/);
	if (!match?.[1] || !match[2]) return null;
	const preference = Number(match[1]);
	const mxHostname = normalizeHostname(match[2]);
	if (!Number.isSafeInteger(preference) || preference < 0 || !mxHostname) return null;
	return { preference, mxHostname };
}

async function resolveAddresses(
	resolverUrl: string,
	mxHostname: string
): Promise<{ security: DnsSecurity; addresses: string[] }> {
	const [aQuery, aaaaQuery] = await Promise.all([
		queryDohJson(resolverUrl, mxHostname, A_RRTYPE),
		queryDohJson(resolverUrl, mxHostname, AAAA_RRTYPE),
	]);
	if (!aQuery.ok || !aaaaQuery.ok) return { security: 'indeterminate', addresses: [] };
	if (!isSuccessfulDnsResponse(aQuery.response) || !isSuccessfulDnsResponse(aaaaQuery.response)) {
		return { security: 'indeterminate', addresses: [] };
	}

	const addresses = [
		...(aQuery.response.Answer ?? []).filter((answer) => answer.type === A_RRTYPE),
		...(aaaaQuery.response.Answer ?? []).filter((answer) => answer.type === AAAA_RRTYPE),
	]
		.map((answer) => answer.data)
		.filter((address): address is string => typeof address === 'string');
	if (addresses.length === 0) return { security: 'indeterminate', addresses: [] };

	return {
		security: aQuery.response.AD === true && aaaaQuery.response.AD === true ? 'secure' : 'insecure',
		addresses,
	};
}

function isCachedDestination(value: unknown): value is DaneMxDestination {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const row = value as Partial<DaneMxDestination>;
	return (
		typeof row.mxHostname === 'string' &&
		typeof row.preference === 'number' &&
		(row.mxSecurity === 'secure' || row.mxSecurity === 'insecure') &&
		(row.addressSecurity === 'secure' ||
			row.addressSecurity === 'insecure' ||
			row.addressSecurity === 'indeterminate') &&
		Array.isArray(row.addresses) &&
		row.addresses.every((address) => typeof address === 'string')
	);
}

async function readCache(redis: Redis, key: string): Promise<DaneMxDestination[] | null> {
	try {
		const raw = await redis.get(key);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) && parsed.every(isCachedDestination) ? parsed : null;
	} catch {
		return null;
	}
}

/** Resolve ordered MX destinations and retain their DNSSEC security state. */
export async function resolveDaneMxDestinations(
	redis: Redis,
	domain: string,
	resolverUrl: string
): Promise<DaneMxLookupResult> {
	const normalizedDomain = normalizeHostname(domain);
	const cacheKey = `${CACHE_PREFIX}${normalizedDomain}`;
	const cached = await readCache(redis, cacheKey);
	if (cached) return { status: 'destinations', destinations: cached };

	const mxQuery = await queryDohJson(resolverUrl, normalizedDomain, MX_RRTYPE);
	if (!mxQuery.ok) return { status: 'lookup-failed', reason: mxQuery.reason };
	const mxStatus = dnsStatus(mxQuery.response);
	if (mxStatus === DNS_RCODE_NXDOMAIN) return { status: 'not-found' };
	if (mxStatus !== DNS_RCODE_NOERROR) {
		return { status: 'lookup-failed', reason: `MX DNS RCODE ${mxStatus}` };
	}

	const mxSecurity = mxQuery.response.AD === true ? 'secure' : 'insecure';
	let mxRecords = (mxQuery.response.Answer ?? [])
		.filter((answer) => answer.type === MX_RRTYPE && typeof answer.data === 'string')
		.map((answer) => parseMxData(answer.data as string))
		.filter((record): record is { preference: number; mxHostname: string } => record !== null);

	// RFC 5321 implicit MX: a domain with addresses but no MX is its own SMTP host.
	if (mxRecords.length === 0) {
		mxRecords = [{ preference: 0, mxHostname: normalizedDomain }];
	}
	mxRecords.sort((a, b) => a.preference - b.preference);

	const destinations = await Promise.all(
		mxRecords.map(async (record): Promise<DaneMxDestination> => {
			const addressResult = await resolveAddresses(resolverUrl, record.mxHostname);
			return {
				...record,
				mxSecurity,
				addressSecurity: addressResult.security,
				addresses: addressResult.addresses,
			};
		})
	);
	try {
		await redis.set(cacheKey, JSON.stringify(destinations), 'EX', CACHE_TTL_SECONDS);
	} catch {
		// DNS remains usable when the optional shared cache is unavailable.
	}
	return { status: 'destinations', destinations };
}
