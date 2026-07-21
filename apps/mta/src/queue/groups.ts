/**
 * GroupMQ group key helpers and ISP classification
 */

import type { DestinationProviderKey, IpPoolType } from '../types.js';

export { extractDomain } from '@owlat/shared';

/**
 * Build a GroupMQ group key: "{ipPool}:{recipientDomain}"
 * This ensures per-IP-pool isolation and per-domain sequential processing
 */
export function buildGroupKey(ipPool: IpPoolType, recipientDomain: string): string {
	return `${ipPool}:${recipientDomain.toLowerCase()}`;
}

/**
 * Classify a domain into a known ISP for metrics and profile lookups
 */
export function classifyIsp(domain: string): DestinationProviderKey {
	const d = domain.toLowerCase();

	if (d === 'gmail.com' || d === 'googlemail.com') return 'gmail';
	if (d === 'outlook.com' || d === 'hotmail.com' || d === 'live.com' || d === 'msn.com')
		return 'microsoft';
	if (d === 'yahoo.com' || d === 'aol.com' || d === 'ymail.com' || d === 'yahoo.co.uk')
		return 'yahoo';
	if (d === 'icloud.com' || d === 'me.com' || d === 'mac.com') return 'apple';

	return 'other';
}

/**
 * Map engagement score to GroupMQ priority (lower number = higher priority)
 */
export function engagementToPriority(score?: number): number {
	if (score === undefined || score === null) return 3;
	if (score >= 80) return 1;
	if (score >= 50) return 2;
	if (score >= 20) return 3;
	return 4;
}
