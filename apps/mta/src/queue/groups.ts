/**
 * GroupMQ group key helpers and ISP classification
 */

import {
	destinationProviderForDomain,
	type DestinationProviderKey,
} from '@owlat/shared/deliverabilityRouting';
import type { IpPoolType } from '../types.js';

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
	return destinationProviderForDomain(domain);
}
