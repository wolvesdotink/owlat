/**
 * IPv6 source-address ownership/routing readiness.
 *
 * A source-bound TCP/25 connection is the proof that the container can use the
 * configured address. Confirmed local ownership loss blocks; remote/DNS/network
 * uncertainty preserves the previous state and therefore fails closed at boot.
 */

import { ipAddressFamily } from '@owlat/shared/ipAddress';
import {
	isSourceAddressFailureReason,
	type SourceAddressFailureReason,
	type SourceAddressVerdict,
} from '@owlat/shared/ipReadiness';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { probeSmtpReachability, type SmtpReachabilityDeps } from '../routes/smtpReachability.js';
import { pool } from '../smtp/connectionPool.js';
import {
	applyIpPoolObservation,
	nextIpPoolObservationGeneration,
	type IpPoolObservationDecision,
} from './ipPool.js';

const SOURCE_ADDRESS_PREFIX = 'mta:source-address-readiness:';

export interface SourceAddressReadiness {
	ip: string;
	verdict: SourceAddressVerdict;
	reason?: SourceAddressFailureReason;
	target?: string;
	checkedAt: number;
}

export async function verifySourceAddressReadiness(
	ip: string,
	deps?: SmtpReachabilityDeps
): Promise<SourceAddressReadiness> {
	const result = await probeSmtpReachability(ip ? [ip] : [], deps);
	const observation = result.ips[0];
	if (observation?.status === 'ok') {
		return {
			ip,
			verdict: 'pass',
			...(result.targetMx ? { target: result.targetMx } : {}),
			checkedAt: result.checkedAt,
		};
	}
	return {
		ip,
		verdict: observation?.reason === 'source_ip_unavailable' ? 'fail' : 'error',
		reason:
			observation?.reason === 'source_ip_unavailable'
				? 'source-ip-unavailable'
				: 'probe-unavailable',
		...(result.targetMx ? { target: result.targetMx } : {}),
		checkedAt: result.checkedAt,
	};
}

export async function getSourceAddressReadiness(
	redis: Redis,
	ip: string
): Promise<SourceAddressReadiness | null> {
	const data = await redis.hgetall(`${SOURCE_ADDRESS_PREFIX}${ip}`);
	if (!data['checkedAt'] || !data['verdict']) return null;
	const reason = data['reason'];
	return {
		ip,
		verdict: data['verdict'] === 'pass' || data['verdict'] === 'fail' ? data['verdict'] : 'error',
		...(reason && isSourceAddressFailureReason(reason)
			? { reason: reason as SourceAddressFailureReason }
			: {}),
		...(data['target'] ? { target: data['target'] } : {}),
		checkedAt: Number(data['checkedAt']),
	};
}

export async function runSourceAddressReadinessCheck(
	redis: Redis,
	config: Pick<MtaConfig, 'ipPools'>,
	deps?: SmtpReachabilityDeps
): Promise<SourceAddressReadiness[]> {
	const ips = [...new Set([...config.ipPools.transactional, ...config.ipPools.campaign])].filter(
		(ip) => ipAddressFamily(ip) === 'ipv6'
	);
	const observations = await Promise.all(
		ips.map(async (ip) => {
			const generation = await nextIpPoolObservationGeneration(redis, ip, 'source-address');
			return { generation, readiness: await verifySourceAddressReadiness(ip, deps) };
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
				reason: 'source-address',
				generation,
				decision,
				stateKey: `${SOURCE_ADDRESS_PREFIX}${readiness.ip}`,
				stateFields: {
					verdict: readiness.verdict,
					reason: readiness.reason ?? '',
					target: readiness.target ?? '',
					checkedAt: String(readiness.checkedAt),
				},
			});
			if (transition.becameBlocked) pool.invalidateBindIp(readiness.ip);
			if (!transition.applied) {
				return (await getSourceAddressReadiness(redis, readiness.ip)) ?? readiness;
			}
			return readiness;
		})
	);
}
