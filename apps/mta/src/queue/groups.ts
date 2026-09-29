/**
 * GroupMQ group key helpers and ISP classification
 */

import {
	destinationProviderForDomain,
	type DestinationProviderKey,
} from '@owlat/shared/deliverabilityRouting';
import type { IpPoolType, QueueLane } from '../types.js';

export { extractDomain } from '@owlat/shared';

/**
 * Build a GroupMQ group key: "{ipPool}:{recipientDomain}", or
 * "{lane}:{ipPool}:{recipientDomain}" for a job on a dedicated lane.
 *
 * GroupMQ runs one job at a time per group, so the key decides what a message
 * waits behind. The pool keeps IP pools apart; the lane keeps person-to-person
 * Postbox mail out of the queue that system, API and governed-fallback mail
 * share, so a transactional burst to gmail.com cannot hold back a reply to a
 * gmail.com address. The lane only splits the FIFO: the per-IP per-domain rate
 * throttle and the per-MX connection cap are keyed by IP, domain and host, so
 * both lanes still draw on the same politeness budget for a domain.
 */
export function buildGroupKey(
	ipPool: IpPoolType,
	recipientDomain: string,
	lane?: QueueLane
): string {
	const key = `${ipPool}:${recipientDomain.toLowerCase()}`;
	return lane ? `${lane}:${key}` : key;
}

/**
 * Classify a domain into a known ISP for metrics and profile lookups
 */
export function classifyIsp(domain: string): DestinationProviderKey {
	return destinationProviderForDomain(domain);
}
