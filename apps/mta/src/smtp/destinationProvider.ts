/** One coherent MX route and provider-policy snapshot for a recipient domain. */

import { domainToASCII } from 'node:url';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import type { DestinationProviderKey } from '../types.js';
import { resolveDaneMxDestinations, type DaneMxDestination } from './daneMxResolver.js';
import { resolveMxDestination, type MxDnsLookup, type MxResolution } from './mxResolver.js';

export interface DestinationSnapshot {
	recipientDomain: string;
	mx: MxResolution;
	providerKey: DestinationProviderKey;
	/** Known providers share a budget; unknown operators remain domain scoped. */
	throttleKey: string;
	/** DNSSEC-aware destinations from the same discovery, when DANE is enabled. */
	daneDestinations?: DaneMxDestination[];
	/** False only when report-only DANE discovery failed and normal DNS was used. */
	daneDiscoveryAuthenticated: boolean;
}

export interface DestinationResolutionOptions {
	config?: Pick<MtaConfig, 'daneMode' | 'daneResolverUrl'>;
	normalMxLookup?: MxDnsLookup;
}

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

export function destinationFromMx(
	recipientDomain: string,
	mx: MxResolution,
	options: Pick<DestinationSnapshot, 'daneDestinations' | 'daneDiscoveryAuthenticated'> = {
		daneDiscoveryAuthenticated: true,
	}
): DestinationSnapshot {
	const domain = normalizeDomain(recipientDomain);
	const providerKey =
		mx.status === 'deliverable'
			? providerFromMxHostnames(mx.hosts.map((record) => record.exchange))
			: 'other';
	return {
		recipientDomain: domain,
		mx,
		providerKey,
		throttleKey: providerKey === 'other' ? domain : providerKey,
		...options,
	};
}

/** Resolve MX and derive provider identity from that exact cached DNS snapshot. */
export async function resolveDestinationSnapshot(
	redis: Redis,
	recipientDomain: string,
	options: DestinationResolutionOptions = {}
): Promise<DestinationSnapshot> {
	const domain = normalizeDomain(recipientDomain);
	const daneMode = options.config?.daneMode ?? 'off';
	const daneResolverUrl = options.config?.daneResolverUrl;
	if (daneMode !== 'off' && daneResolverUrl) {
		const discovery = await resolveDaneMxDestinations(redis, domain, daneResolverUrl);
		if (discovery.status === 'destinations') {
			return destinationFromMx(
				domain,
				{
					status: 'deliverable',
					source: 'mx',
					hosts: discovery.destinations.map((destination) => ({
						exchange: destination.mxHostname,
						priority: destination.preference,
					})),
				},
				{
					daneDestinations: discovery.destinations,
					daneDiscoveryAuthenticated: true,
				}
			);
		}
		if (discovery.status === 'null-mx') {
			return destinationFromMx(domain, { status: 'null-mx' });
		}
		if (discovery.status === 'not-found') {
			return destinationFromMx(domain, {
				status: 'domain-not-found',
				reason: `Recipient domain ${domain} does not exist (DNSSEC-aware NXDOMAIN)`,
			});
		}
		if (daneMode === 'enforce') {
			return destinationFromMx(domain, {
				status: 'temporary-failure',
				reason: `DANE MX discovery failed for ${domain}: ${discovery.reason}`,
			});
		}

		const fallbackMx = await resolveMxDestination(redis, domain, options.normalMxLookup);
		return destinationFromMx(domain, fallbackMx, { daneDiscoveryAuthenticated: false });
	}

	const mx = await resolveMxDestination(redis, domain, options.normalMxLookup);
	return destinationFromMx(domain, mx);
}
