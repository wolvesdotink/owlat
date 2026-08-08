/**
 * Governed `/send` intake: revalidate the routing lease the caller presents.
 *
 * The decision endpoint (`routingDecision.ts`) granted the lease; this is the
 * check that it is still the SAME decision at enqueue time — the same binding,
 * the same breaker generations, the same owned IP. It lives beside the route
 * rather than in it because the answer is a small vocabulary of 409 codes and
 * each one means something different downstream: Convex turns them into a
 * deferral and decides from the code whether that deferral is evidence about
 * this sending identity (`governed`) or about our own infrastructure (`local`).
 */

import type Redis from 'ioredis';
import { ROUTING_LEASE_UNREADABLE_CODE, type GovernedRoutingContext } from '@owlat/shared';
import type { EmailJob } from '../types.js';
import { canSend, canSendScope } from '../intelligence/circuitBreaker.js';
import { isIpEligibilityLeaseValid } from '../scaling/ipPool.js';
import { isRoutingLeaseBoundTo, readRoutingLease } from './routingDecision.js';

/** The 409 codes this check may answer. Every one of them is a deferral. */
export type RoutingLeaseRejectionCode =
	| typeof ROUTING_LEASE_UNREADABLE_CODE
	| 'ROUTING_DECISION_EXPIRED'
	| 'ROUTING_DECISION_CHANGED'
	| 'GLOBAL_SAFETY_DEFER';

export type RoutingLeaseRevalidation =
	| { ok: true; routingLease: NonNullable<EmailJob['routingLease']> }
	| { ok: false; error: string; code: RoutingLeaseRejectionCode };

function rejected(error: string, code: RoutingLeaseRejectionCode): RoutingLeaseRevalidation {
	return { ok: false, error, code };
}

export async function revalidateRoutingLease(
	redis: Redis,
	token: string,
	request: GovernedRoutingContext
): Promise<RoutingLeaseRevalidation> {
	const read = await readRoutingLease(redis, token);
	// OUR OWN STORAGE FAILED, AND IT SAYS SO. A lease value we cannot parse (a
	// truncated write, a corrupt or foreign record) is not the MTA declining this
	// identity — no receiver was involved and nothing about the send was refused.
	// It gets its own code so Convex can answer `deferralOrigin: 'local'` and keep
	// a lease-store fault out of gate 2's `governed` budget, which halts a cell at
	// 25%. Everything else below — aged out, no longer binding, a breaker or IP
	// generation that moved — is governance and keeps the shipped codes.
	if (read.status === 'unreadable') {
		return rejected(
			'Routing lease could not be read; resolve again',
			ROUTING_LEASE_UNREADABLE_CODE
		);
	}
	// An `absent` key is a lease that aged out in the ordinary case and one Redis
	// dropped in the rare one; a `GET` cannot tell those apart (see
	// `readRoutingLease`), so both keep the stale-decision answer.
	const lease = read.status === 'ok' ? read.lease : null;
	if (!isRoutingLeaseBoundTo(lease, request)) {
		return rejected('Routing decision expired; resolve again', 'ROUTING_DECISION_EXPIRED');
	}
	const global = await canSend(redis, request.organizationId);
	if (!global.allowed || global.generation !== lease.globalBreakerGeneration) {
		return rejected('Delivery temporarily deferred by safety policy', 'GLOBAL_SAFETY_DEFER');
	}
	const provider = await canSendScope(redis, request.organizationId, lease.destinationProvider);
	if (!provider.allowed || provider.generation !== lease.providerBreakerGeneration) {
		return rejected(
			'Destination provider route changed; resolve again',
			'ROUTING_DECISION_CHANGED'
		);
	}
	if (
		lease.ip &&
		lease.eligibilityGeneration !== undefined &&
		!(await isIpEligibilityLeaseValid(redis, {
			ip: lease.ip,
			eligibilityGeneration: lease.eligibilityGeneration,
		}))
	) {
		return rejected('Owned IP eligibility changed; resolve again', 'ROUTING_DECISION_CHANGED');
	}
	return {
		ok: true,
		routingLease: {
			token: lease.token,
			destinationProvider: lease.destinationProvider,
			probe: lease.probe,
			globalProbe: lease.globalProbe,
			ip: lease.ip,
			eligibilityGeneration: lease.eligibilityGeneration,
			globalBreakerGeneration: lease.globalBreakerGeneration,
			providerBreakerGeneration: lease.providerBreakerGeneration,
			warmingReservation: lease.warmingReservation,
		},
	};
}
