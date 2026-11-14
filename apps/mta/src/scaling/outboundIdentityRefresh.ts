/**
 * One re-observation of every outbound identity, and the stored result of it.
 *
 * The three DNS readiness sweeps (source address, FCrDNS, IPv6 SPF) always run
 * as a set and always in this order — a source address must exist before its
 * PTR means anything, and IPv6 stays gated on the IPv4 identity the FCrDNS
 * sweep decides. The egress-address sweep asks receivers instead of DNS and
 * runs alongside them. Boot and the hourly cron both ran that sequence inline; this module
 * names it once so the on-demand refresh route cannot drift from them.
 *
 * `/health` reports what the LAST sweep stored, which is right for polling and
 * wrong for the moment it matters most: an operator who has just corrected a PTR
 * record. Until the next hourly sweep, the stored verdict still says `fail` —
 * and `docker compose up -d` does not restart an unchanged container, so there
 * is no boot sweep to force either. `refreshOutboundIdentity` is what "check
 * again now" calls.
 */

import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import type { FcrdnsReadiness } from '@owlat/shared/fcrdns';
import {
	getEgressAddressReadiness,
	runEgressAddressReadinessCheck,
} from './egressAddressReadiness.js';
import { getFcrdnsReadiness, runFcrdnsReadinessCheck } from './fcrdns.js';
import { getIpv6SpfReadiness, runIpv6SpfReadinessCheck } from './ipv6SpfReadiness.js';
import {
	getSourceAddressReadiness,
	runSourceAddressReadinessCheck,
} from './sourceAddressReadiness.js';

export interface OutboundIdentityStatus {
	ip: string;
	fcrdns: FcrdnsReadiness | null;
	ipv6Spf: Awaited<ReturnType<typeof getIpv6SpfReadiness>>;
	sourceAddress: Awaited<ReturnType<typeof getSourceAddressReadiness>>;
	egressAddress: Awaited<ReturnType<typeof getEgressAddressReadiness>>;
}

type IdentityConfig = Parameters<typeof runFcrdnsReadinessCheck>[1] &
	Parameters<typeof runIpv6SpfReadinessCheck>[1] &
	Pick<MtaConfig, 'ipPools' | 'ehloHostname' | 'ehloHostnames'>;

function configuredIps(config: Pick<MtaConfig, 'ipPools'>): string[] {
	return [...new Set([...config.ipPools.transactional, ...config.ipPools.campaign])];
}

/**
 * Re-observe every configured sending address from live DNS and persist the
 * verdicts. Each sweep fences its own writes with a generation CAS, so calling
 * this while the hourly cron is mid-sweep is safe.
 */
export async function refreshOutboundIdentity(redis: Redis, config: IdentityConfig): Promise<void> {
	// The egress sweep depends on none of the DNS sweeps, so it runs beside them
	// rather than adding its EHLO round trips to the boot and re-check wait.
	await Promise.all([
		runEgressAddressReadinessCheck(redis, config),
		(async () => {
			await runSourceAddressReadinessCheck(redis, config);
			await runFcrdnsReadinessCheck(redis, config);
			await runIpv6SpfReadinessCheck(redis, config);
		})(),
	]);
}

/** The stored readiness of every configured address, as `/health` reports it. */
export async function outboundIdentityStatus(
	redis: Redis,
	config: Pick<MtaConfig, 'ipPools'>
): Promise<OutboundIdentityStatus[]> {
	return await Promise.all(
		configuredIps(config).map(async (ip) => ({
			ip,
			fcrdns: await getFcrdnsReadiness(redis, ip),
			ipv6Spf: await getIpv6SpfReadiness(redis, ip),
			sourceAddress: await getSourceAddressReadiness(redis, ip),
			egressAddress: await getEgressAddressReadiness(redis, ip),
		}))
	);
}
