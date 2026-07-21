/**
 * Recipient-domain to destination-provider resolution.
 *
 * Queue ordering remains recipient-domain scoped. Only shared receiver policy
 * (throttle/profile/TLS/connections) rolls up to the provider discovered from
 * MX hostnames. Unknown MX operators retain a per-domain throttle key so the
 * generic fallback never combines unrelated receivers into one traffic budget.
 */

import { domainToASCII } from 'node:url';
import type Redis from 'ioredis';
import type { DestinationProviderKey } from '../types.js';
import { resolveMxHosts, type MxHost } from './mxResolver.js';
import { logger } from '../monitoring/logger.js';

const CACHE_PREFIX = 'mta:destination-provider:v1:';
const KNOWN_PROVIDER_TTL_SECONDS = 600;
const UNKNOWN_PROVIDER_TTL_SECONDS = 300;

const PROVIDERS = ['gmail', 'microsoft', 'yahoo', 'apple', 'other'] as const;

export interface DestinationIdentity {
	recipientDomain: string;
	providerKey: DestinationProviderKey;
	/** Known providers share a budget; unknown operators remain domain scoped. */
	throttleKey: string;
}

type MxLookup = (redis: Redis, domain: string) => Promise<MxHost[]>;

function normalizeHostname(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, '');
}

function normalizeDomain(value: string): string {
	const normalized = normalizeHostname(value);
	return domainToASCII(normalized) || normalized;
}

function hasDnsSuffix(hostname: string, suffix: string): boolean {
	return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

/** Classify a receiver from validated MX hostnames, never recipient branding. */
export function providerFromMxHostnames(mxHostnames: readonly string[]): DestinationProviderKey {
	const providers = mxHostnames.map(providerFromMxHostname);
	const first = providers[0];
	// Mixed/unknown MX sets deliberately stay unrolled. A single injected MX must
	// not move traffic for the whole domain into another provider's shared budget.
	return first && first !== 'other' && providers.every((provider) => provider === first)
		? first
		: 'other';
}

function providerFromMxHostname(mxHostname: string): DestinationProviderKey {
	const host = normalizeHostname(mxHostname);
	if (hasDnsSuffix(host, 'google.com') || hasDnsSuffix(host, 'googlemail.com')) return 'gmail';
	if (hasDnsSuffix(host, 'protection.outlook.com')) return 'microsoft';
	if (hasDnsSuffix(host, 'yahoodns.net')) return 'yahoo';
	if (hasDnsSuffix(host, 'icloud.com')) return 'apple';
	return 'other';
}

function isProviderKey(value: string): value is DestinationProviderKey {
	return PROVIDERS.some((provider) => provider === value);
}

function identity(
	recipientDomain: string,
	providerKey: DestinationProviderKey
): DestinationIdentity {
	return {
		recipientDomain,
		providerKey,
		throttleKey: providerKey === 'other' ? recipientDomain : providerKey,
	};
}

/**
 * Resolve and cache provider identity. An empty MX result may be a transient
 * DNS failure, so it is deliberately not cached as `other`.
 */
export async function resolveDestinationIdentity(
	redis: Redis,
	recipientDomain: string,
	lookupMx: MxLookup = resolveMxHosts
): Promise<DestinationIdentity> {
	const domain = normalizeDomain(recipientDomain);
	const cacheKey = `${CACHE_PREFIX}${domain}`;

	try {
		const cached = await redis.get(cacheKey);
		if (cached && isProviderKey(cached)) return identity(domain, cached);
	} catch (err) {
		logger.warn({ err, recipientDomain: domain }, 'Destination provider cache read failed');
	}

	const mxHosts = await lookupMx(redis, domain);
	if (mxHosts.length === 0) return identity(domain, 'other');

	const providerKey = providerFromMxHostnames(mxHosts.map((record) => record.exchange));
	const ttl = providerKey === 'other' ? UNKNOWN_PROVIDER_TTL_SECONDS : KNOWN_PROVIDER_TTL_SECONDS;
	try {
		await redis.set(cacheKey, providerKey, 'EX', ttl);
	} catch (err) {
		logger.warn({ err, recipientDomain: domain }, 'Destination provider cache write failed');
	}
	return identity(domain, providerKey);
}
