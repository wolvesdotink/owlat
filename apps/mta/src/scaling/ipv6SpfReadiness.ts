/**
 * IPv6 return-path SPF readiness.
 *
 * FCrDNS proves address identity; this independent observation proves the
 * operator intentionally authorized the exact IPv6 source on the envelope
 * return-path domain before the pool may rotate it.
 */

import { resolveTxt } from 'node:dns/promises';
import { ipAddressFamily } from '@owlat/shared/ipAddress';
import {
	IPV6_SPF_FAILURE_REASONS,
	isIpv6SpfFailureReason,
	observeIpv6SpfReadiness,
	type Ipv6SpfFailureReason,
	type Ipv6SpfReadiness,
} from '@owlat/shared/ipReadiness';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { pool } from '../smtp/connectionPool.js';
import {
	applyIpPoolObservation,
	nextIpPoolObservationGeneration,
	type IpPoolObservationDecision,
} from './ipPool.js';

const IPV6_SPF_PREFIX = 'mta:ipv6-spf:';

export { IPV6_SPF_FAILURE_REASONS };
export type { Ipv6SpfFailureReason };

export type { Ipv6SpfReadiness };

export interface Ipv6SpfDeps {
	resolveTxt: (hostname: string) => Promise<string[][]>;
	now?: () => number;
}

const DEFAULT_DEPS: Ipv6SpfDeps = { resolveTxt };

export async function verifyIpv6SpfReadiness(
	ip: string,
	domain: string,
	deps: Ipv6SpfDeps = DEFAULT_DEPS
): Promise<Ipv6SpfReadiness> {
	return observeIpv6SpfReadiness(ip, domain, deps.resolveTxt, deps.now ?? Date.now);
}

export async function getIpv6SpfReadiness(
	redis: Redis,
	ip: string
): Promise<Ipv6SpfReadiness | null> {
	const data = await redis.hgetall(`${IPV6_SPF_PREFIX}${ip}`);
	if (!data['checkedAt'] || !data['domain']) return null;
	const reason = data['reason'];
	return {
		ip,
		domain: data['domain'],
		verdict: data['verdict'] === 'pass' || data['verdict'] === 'fail' ? data['verdict'] : 'error',
		...(reason && isIpv6SpfFailureReason(reason) ? { reason: reason as Ipv6SpfFailureReason } : {}),
		checkedAt: Number(data['checkedAt']),
	};
}

/** Reconcile the SPF quarantine reason for every configured IPv6 source. */
export async function runIpv6SpfReadinessCheck(
	redis: Redis,
	config: Pick<MtaConfig, 'ipPools' | 'returnPathDomain'>,
	deps: Ipv6SpfDeps = DEFAULT_DEPS
): Promise<Ipv6SpfReadiness[]> {
	const ips = [...new Set([...config.ipPools.transactional, ...config.ipPools.campaign])].filter(
		(ip) => ipAddressFamily(ip) === 'ipv6'
	);
	const observations = await Promise.all(
		ips.map(async (ip) => {
			const generation = await nextIpPoolObservationGeneration(redis, ip, 'spf');
			return {
				generation,
				readiness: await verifyIpv6SpfReadiness(ip, config.returnPathDomain, deps),
			};
		})
	);
	return Promise.all(
		observations.map(async ({ generation, readiness }) => {
			const decision: IpPoolObservationDecision =
				readiness.verdict === 'pass'
					? 'clear'
					: readiness.verdict === 'fail'
						? 'block'
						: 'preserve';
			const transition = await applyIpPoolObservation(redis, {
				ip: readiness.ip,
				reason: 'spf',
				generation,
				decision,
				stateKey: `${IPV6_SPF_PREFIX}${readiness.ip}`,
				stateFields: {
					domain: readiness.domain,
					verdict: readiness.verdict,
					reason: readiness.reason ?? '',
					checkedAt: String(readiness.checkedAt),
				},
				...(readiness.verdict === 'fail' && readiness.reason
					? {
							regressionAlert: {
								check: 'spf' as const,
								reason: readiness.reason,
								timestamp: readiness.checkedAt,
								message: `IPv6 source ${readiness.ip} was quarantined after return-path SPF regressed (${readiness.reason}).`,
							},
						}
					: {}),
			});
			if (transition.becameBlocked) pool.invalidateBindIp(readiness.ip);
			if (!transition.applied) {
				return (await getIpv6SpfReadiness(redis, readiness.ip)) ?? readiness;
			}
			return readiness;
		})
	);
}
