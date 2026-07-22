/** Release authenticated warming and breaker reservations for a routed job. */

import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import type { EmailJob } from '../types.js';
import { releaseWarmingSlot } from '../intelligence/warming.js';
import { releaseHalfOpenProbe } from '../intelligence/circuitBreaker.js';

export async function releaseRoutingReservations(
	data: EmailJob,
	deps: { redis: Redis; config: MtaConfig }
): Promise<void> {
	const lease = data.routingLease;
	if (!lease) return;
	const releases: Array<Promise<unknown>> = [];
	if (lease.warmingReservation) {
		releases.push(releaseWarmingSlot(deps.redis, lease.warmingReservation));
	}
	if (lease.globalProbe && lease.globalBreakerGeneration !== undefined) {
		releases.push(
			releaseHalfOpenProbe(
				deps.redis,
				data.organizationId,
				undefined,
				data.messageId,
				lease.globalBreakerGeneration
			)
		);
	}
	if (lease.probe && lease.providerBreakerGeneration !== undefined) {
		releases.push(
			releaseHalfOpenProbe(
				deps.redis,
				data.organizationId,
				lease.destinationProvider,
				data.messageId,
				lease.providerBreakerGeneration
			)
		);
	}
	await Promise.all(releases);
}
