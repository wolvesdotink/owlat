import type { GovernedMessageType } from '@owlat/shared';
import type { MtaIpPool } from '../types';

/**
 * The IP pool a send asks the MTA for: the route's pool when it names one,
 * else the one its stream belongs to. Campaign and automation mail is bulk
 * marketing traffic and goes to `campaign`, where the MTA paces it through
 * warm-up and holds back the transactional reserve; everything else (the
 * transactional API, replies, system and personal mail) goes to
 * `transactional`. `delivery/rampCapacityInputs.ts` measures campaign-pool
 * headroom against the same two streams, so the two must change together.
 *
 * Both the routing decision and the intake body take their pool from here: the
 * MTA binds a lease to the pool it was decided for and refuses an intake that
 * names another one. An empty pool name counts as no pool.
 */
export function mtaIpPoolFor(
	routePool: MtaIpPool | '' | undefined,
	messageType: GovernedMessageType | undefined
): MtaIpPool {
	if (routePool) return routePool;
	return messageType === 'campaign' || messageType === 'automation' ? 'campaign' : 'transactional';
}
