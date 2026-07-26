/**
 * IPv6 return-path SPF readiness.
 *
 * FCrDNS proves address identity; this independent observation proves the
 * operator intentionally authorized the exact IPv6 source on the envelope
 * return-path domain before the pool may rotate it.
 */

import { resolveTxt } from 'node:dns/promises';
import { isSpfRecord, spfRecordHasExactIpMechanism } from '@owlat/shared/spf';
import { ipAddressFamily } from '@owlat/shared/ipAddress';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { pool } from '../smtp/connectionPool.js';
import {
	applyIpPoolObservation,
	nextIpPoolObservationGeneration,
	type IpPoolObservationDecision,
} from './ipPool.js';

const IPV6_SPF_PREFIX = 'mta:ipv6-spf:';

export const IPV6_SPF_FAILURE_REASONS = [
	'no-spf-record',
	'multiple-spf-records',
	'missing-ip6-mechanism',
	'lookup-error',
] as const;
export type Ipv6SpfFailureReason = (typeof IPV6_SPF_FAILURE_REASONS)[number];

export interface Ipv6SpfReadiness {
	ip: string;
	domain: string;
	verdict: 'pass' | 'fail' | 'error';
	reason?: Ipv6SpfFailureReason;
	checkedAt: number;
}

export interface Ipv6SpfDeps {
	resolveTxt: (hostname: string) => Promise<string[][]>;
	now?: () => number;
}

const DEFAULT_DEPS: Ipv6SpfDeps = { resolveTxt };

function isMissingRecord(error: unknown): boolean {
	const code = (error as { code?: string }).code;
	return code === 'ENOTFOUND' || code === 'ENODATA';
}

export async function verifyIpv6SpfReadiness(
	ip: string,
	domain: string,
	deps: Ipv6SpfDeps = DEFAULT_DEPS
): Promise<Ipv6SpfReadiness> {
	const checkedAt = deps.now?.() ?? Date.now();
	try {
		const records = (await deps.resolveTxt(domain)).map((chunks) => chunks.join(''));
		const spfRecords = records.filter(isSpfRecord);
		if (spfRecords.length === 0) {
			return { ip, domain, verdict: 'fail', reason: 'no-spf-record', checkedAt };
		}
		if (spfRecords.length > 1) {
			return { ip, domain, verdict: 'fail', reason: 'multiple-spf-records', checkedAt };
		}
		if (!spfRecordHasExactIpMechanism(spfRecords[0]!, ip)) {
			return { ip, domain, verdict: 'fail', reason: 'missing-ip6-mechanism', checkedAt };
		}
		return { ip, domain, verdict: 'pass', checkedAt };
	} catch (error) {
		return {
			ip,
			domain,
			verdict: isMissingRecord(error) ? 'fail' : 'error',
			reason: isMissingRecord(error) ? 'no-spf-record' : 'lookup-error',
			checkedAt,
		};
	}
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
		...(reason && IPV6_SPF_FAILURE_REASONS.includes(reason as Ipv6SpfFailureReason)
			? { reason: reason as Ipv6SpfFailureReason }
			: {}),
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
			});
			if (transition.becameBlocked) pool.invalidateBindIp(readiness.ip);
			if (!transition.applied) {
				return (await getIpv6SpfReadiness(redis, readiness.ip)) ?? readiness;
			}
			return readiness;
		})
	);
}
