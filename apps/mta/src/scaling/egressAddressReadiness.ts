/**
 * Whether mail from a configured sending IP really leaves from that address.
 *
 * Behind a Docker bridge the MTA cannot bind its public IP, so the host's NAT
 * picks the source (smtp/sourceAddress.ts). On a host with a second or
 * floating IPv4 that source can be another address than the one configured,
 * and every PTR, SPF and blocklist verdict the MTA holds is then about an
 * address that is not sending. The receivers themselves are the only witness:
 * this sweep EHLOs the same independent MX hosts the port-25 probe uses and
 * reads the client address each one names in its greeting (smtp/ehloProbe.ts).
 *
 * Verdicts are deliberately asymmetric. A consistent observation of another
 * address blocks the IP, because every message sent from it would be judged on
 * the wrong identity. An observation that matches clears it. Anything less
 * (no receiver named an address, receivers disagree, port 25 is closed, the
 * address is not public) is `unverified`: it never blocks, and it keeps a
 * mismatch an earlier sweep confirmed instead of releasing it on one bad probe.
 */

import { resolve4, resolve6, resolveMx } from 'node:dns/promises';
import type Redis from 'ioredis';
import { ipAddressFamily, normalizeIpAddress } from '@owlat/shared/ipAddress';
import type { MtaConfig } from '../config.js';
import { resolveEhloForIp } from '../ehloConfig.js';
import { logger } from '../monitoring/logger.js';
import { pool } from '../smtp/connectionPool.js';
import { ehloExchange, parseEhloClientAddress, type EhloExchange } from '../smtp/ehloProbe.js';
import { isGlobalAddress, resolveSourceAddress } from '../smtp/sourceAddress.js';
import {
	applyIpPoolObservation,
	nextIpPoolObservationGeneration,
	type IpPoolObservationDecision,
} from './ipPool.js';
import { PORT25_PROBE_DOMAINS } from './port25Probe.js';

const EGRESS_ADDRESS_PREFIX = 'mta:egress-address:';
const SMTP_PORT = 25;
const EXCHANGE_TIMEOUT_MS = 10_000;

export type EgressAddressVerdict = 'pass' | 'fail' | 'unverified';

export type EgressAddressReason =
	/** Receivers agree the mail arrives from another address. */
	| 'address-mismatch'
	/** No receiver named a client address (port 25 closed, DNS failed, no echo). */
	| 'not-observed'
	/** Receivers named different addresses. */
	| 'inconsistent'
	/** The configured IP is not a public address, so no receiver can confirm it. */
	| 'not-public';

const EGRESS_ADDRESS_VERDICTS: readonly EgressAddressVerdict[] = ['pass', 'fail', 'unverified'];
const EGRESS_ADDRESS_REASONS: readonly EgressAddressReason[] = [
	'address-mismatch',
	'not-observed',
	'inconsistent',
	'not-public',
];

export interface EgressAddressReadiness {
	ip: string;
	verdict: EgressAddressVerdict;
	reason?: EgressAddressReason;
	/** The last address the receivers agreed on (kept across unverified sweeps). */
	observed?: string;
	/** The MX that reported `observed`. */
	target?: string;
	checkedAt: number;
}

export interface EgressObservation {
	domain: string;
	mx?: string;
	/** The client address the MX named, or null when it named none. */
	observed: string | null;
}

export interface EgressAddressDeps {
	resolveMx: typeof resolveMx;
	resolve4: typeof resolve4;
	resolve6: typeof resolve6;
	exchange: EhloExchange;
	now: () => number;
	domains?: readonly string[];
	/** Defaults to the sender's own rule, `resolveSourceAddress`. */
	sourceAddressFor?: (ip: string) => string | undefined;
	/** Defaults to `isGlobalAddress`; tests use documentation ranges. */
	isPublicAddress?: (ip: string) => boolean;
}

const defaultDeps: EgressAddressDeps = {
	resolveMx,
	resolve4,
	resolve6,
	exchange: ehloExchange,
	now: Date.now,
};

/** Judge one configured IP from what the receivers reported. Pure. */
export function classifyEgressAddress(
	ip: string,
	observations: readonly EgressObservation[],
	checkedAt: number,
	isPublicAddress: (ip: string) => boolean = isGlobalAddress
): EgressAddressReadiness {
	const configured = normalizeIpAddress(ip);
	if (!configured || !isPublicAddress(configured)) {
		return { ip, verdict: 'unverified', reason: 'not-public', checkedAt };
	}
	const family = ipAddressFamily(configured);
	// Only a public address of the probed family testifies: a receiver behind
	// its own proxy that names a private hop says nothing about this host.
	const usable = observations.flatMap((observation) => {
		const address = observation.observed ? normalizeIpAddress(observation.observed) : null;
		return address && ipAddressFamily(address) === family && isPublicAddress(address)
			? [{ address, mx: observation.mx }]
			: [];
	});
	const distinct = new Set(usable.map((entry) => entry.address));
	if (distinct.size === 0) {
		return { ip, verdict: 'unverified', reason: 'not-observed', checkedAt };
	}
	if (distinct.size > 1) {
		return { ip, verdict: 'unverified', reason: 'inconsistent', checkedAt };
	}
	const [{ address, mx }] = usable as [{ address: string; mx?: string }];
	const located = { observed: address, ...(mx ? { target: mx } : {}), checkedAt };
	return address === configured
		? { ip, verdict: 'pass', ...located }
		: { ip, verdict: 'fail', reason: 'address-mismatch', ...located };
}

async function observeAt(
	ip: string,
	domain: string,
	ehloName: string,
	deps: EgressAddressDeps
): Promise<EgressObservation> {
	let mx: string | undefined;
	try {
		const records = await deps.resolveMx(domain);
		mx = [...records].sort((a, b) => a.priority - b.priority)[0]?.exchange;
		if (!mx) return { domain, observed: null };
		// Dial the MX over the configured IP's own family, as the sender does, so
		// the receiver reports the translated address of that family.
		const addresses =
			ipAddressFamily(ip) === 'ipv6' ? await deps.resolve6(mx) : await deps.resolve4(mx);
		const host = addresses[0];
		if (!host) return { domain, mx, observed: null };
		const localAddress = (deps.sourceAddressFor ?? ((value) => resolveSourceAddress(value)))(ip);
		const reply = await deps.exchange({
			host,
			port: SMTP_PORT,
			...(localAddress !== undefined ? { localAddress } : {}),
			ehloName,
			timeoutMs: EXCHANGE_TIMEOUT_MS,
		});
		return { domain, mx, observed: parseEhloClientAddress(reply) };
	} catch {
		return { domain, ...(mx ? { mx } : {}), observed: null };
	}
}

/** Ask every probe receiver which address mail from `ip` arrives from. */
export async function observeEgressAddress(
	ip: string,
	ehloName: string,
	deps: EgressAddressDeps = defaultDeps
): Promise<EgressAddressReadiness> {
	const isPublicAddress = deps.isPublicAddress ?? isGlobalAddress;
	if (!isPublicAddress(ip)) {
		return { ip, verdict: 'unverified', reason: 'not-public', checkedAt: deps.now() };
	}
	const observations = await Promise.all(
		(deps.domains ?? PORT25_PROBE_DOMAINS).map((domain) => observeAt(ip, domain, ehloName, deps))
	);
	return classifyEgressAddress(ip, observations, deps.now(), isPublicAddress);
}

function decisionFor(verdict: EgressAddressVerdict): IpPoolObservationDecision {
	return verdict === 'pass' ? 'clear' : verdict === 'fail' ? 'block' : 'preserve';
}

export async function getEgressAddressReadiness(
	redis: Redis,
	ip: string
): Promise<EgressAddressReadiness | null> {
	const data = await redis.hgetall(`${EGRESS_ADDRESS_PREFIX}${ip}`);
	if (!data['checkedAt'] || !data['verdict']) return null;
	const verdict = EGRESS_ADDRESS_VERDICTS.find((value) => value === data['verdict']);
	const reason = EGRESS_ADDRESS_REASONS.find((value) => value === data['reason']);
	return {
		ip,
		verdict: verdict ?? 'unverified',
		...(reason ? { reason } : {}),
		...(data['observed'] ? { observed: data['observed'] } : {}),
		...(data['target'] ? { target: data['target'] } : {}),
		checkedAt: Number(data['checkedAt']),
	};
}

export async function runEgressAddressReadinessCheck(
	redis: Redis,
	config: Pick<MtaConfig, 'ipPools' | 'ehloHostname' | 'ehloHostnames'>,
	deps: EgressAddressDeps = defaultDeps
): Promise<EgressAddressReadiness[]> {
	const ips = [...new Set([...config.ipPools.transactional, ...config.ipPools.campaign])];
	const observations = await Promise.all(
		ips.map(async (ip) => {
			const generation = await nextIpPoolObservationGeneration(redis, ip, 'egress-address');
			return {
				generation,
				readiness: await observeEgressAddress(ip, resolveEhloForIp(config, ip), deps),
			};
		})
	);
	return Promise.all(
		observations.map(async ({ generation, readiness }) => {
			const transition = await applyIpPoolObservation(redis, {
				ip: readiness.ip,
				reason: 'egress-address',
				generation,
				decision: decisionFor(readiness.verdict),
				stateKey: `${EGRESS_ADDRESS_PREFIX}${readiness.ip}`,
				// An unverified sweep leaves `observed` and `target` alone: they stay
				// the last address the receivers agreed on, which is what explains a
				// mismatch block that the sweep preserved.
				stateFields: {
					verdict: readiness.verdict,
					reason: readiness.reason ?? '',
					...(readiness.verdict === 'unverified'
						? {}
						: { observed: readiness.observed ?? '', target: readiness.target ?? '' }),
					checkedAt: String(readiness.checkedAt),
				},
			});
			if (transition.becameBlocked) {
				pool.invalidateBindIp(readiness.ip);
				logger.error(
					{ ip: readiness.ip, observed: readiness.observed, target: readiness.target },
					'Mail from this sending IP leaves from another address; the IP is held until it does not. ' +
						"Make the configured IP the host's outbound address, or configure the observed address instead."
				);
			}
			if (!transition.applied) {
				return (await getEgressAddressReadiness(redis, readiness.ip)) ?? readiness;
			}
			return readiness;
		})
	);
}
