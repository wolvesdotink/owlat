/**
 * Continuous Forward-Confirmed Reverse DNS readiness.
 *
 * Every configured sending IP is observed at boot and hourly. The full
 * checklist is persisted in Redis, while hard failures feed the IP pool's
 * composed eligibility gate. Generic provider PTRs remain deliverable but warn.
 */

import { resolve4, resolve6, reverse } from 'dns/promises';
import {
	normalizeDnsName,
	isFcrdnsFailureReason,
	verifyFcrdnsIdentity,
	type FcrdnsDnsDeps,
	type FcrdnsFailureReason,
	type FcrdnsReadiness,
} from '@owlat/shared/fcrdns';
import { ipAddressFamily } from '@owlat/shared/ipAddress';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { resolveEhloForIp } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { pool } from '../smtp/connectionPool.js';
import {
	applyIpPoolObservation,
	nextIpPoolObservationGeneration,
	type IpPoolObservationDecision,
} from './ipPool.js';

const FCRDNS_PREFIX = 'mta:fcrdns:';
const IPV4_IDENTITY_PREFIX = 'mta:ipv4-identity:';

export type { FcrdnsFailureReason, FcrdnsReadiness } from '@owlat/shared/fcrdns';

export interface FcrdnsResult extends FcrdnsReadiness {
	/** Backwards-compatible convenience for send-readiness callers. */
	ok: boolean;
	/** Backwards-compatible list form; runtime config has one EHLO per bind IP. */
	expectedNames: string[];
}

export interface FcrdnsDeps extends FcrdnsDnsDeps {
	now?: () => number;
	timeoutMs?: number;
}

const DEFAULT_DEPS: FcrdnsDeps = { reverse, resolve4, resolve6 };

type FcrdnsConfig = Pick<MtaConfig, 'ipPools' | 'ehloHostname' | 'ehloHostnames'> &
	Partial<Pick<MtaConfig, 'genericPtrSuffixes' | 'allowUnverifiedFcrdns'>>;

function failedResult(
	ip: string,
	ehlo: string,
	ptrNames: string[],
	reason: FcrdnsFailureReason,
	checkedAt: number,
	checklist: FcrdnsReadiness['checklist']
): FcrdnsResult {
	return {
		ip,
		addressFamily: ipAddressFamily(ip) ?? 'ipv4',
		ehlo,
		ptrNames,
		checklist,
		verdict: reason === 'lookup-error' ? 'error' : 'fail',
		genericPtr: false,
		reason,
		checkedAt,
		overridden: false,
		ok: false,
		expectedNames: [ehlo],
	};
}

/** Verify one canonical IPv4 or IPv6 sending identity from live DNS observations. */
export async function verifyFcrdns(
	ip: string,
	expectedNames: string[],
	deps: FcrdnsDeps = DEFAULT_DEPS,
	genericPtrSuffixes: readonly string[] = []
): Promise<FcrdnsResult> {
	const expected = expectedNames.map(normalizeDnsName).filter(Boolean);
	const ehlo = expected[0] ?? '';
	const checkedAt = deps.now?.() ?? Date.now();
	const verification = await verifyFcrdnsIdentity(
		ip,
		ehlo,
		deps,
		genericPtrSuffixes,
		deps.timeoutMs
	);
	return {
		...verification,
		checkedAt,
		overridden: false,
		ok: verification.verdict === 'pass' || verification.verdict === 'warn',
		expectedNames: expected,
	};
}

function readinessHash(result: FcrdnsResult): Record<string, string> {
	return {
		ip: result.ip,
		addressFamily: result.addressFamily,
		ehlo: result.ehlo,
		ptrNames: JSON.stringify(result.ptrNames),
		ptrExists: String(result.checklist.ptrExists),
		ptrIsFqdn: String(result.checklist.ptrIsFqdn),
		forwardConfirmed: String(result.checklist.forwardConfirmed),
		ehloMatches: String(result.checklist.ehloMatches),
		verdict: result.verdict,
		genericPtr: String(result.genericPtr),
		reason: result.reason ?? '',
		checkedAt: String(result.checkedAt),
	};
}

export async function getFcrdnsReadiness(
	redis: Redis,
	ip: string
): Promise<FcrdnsReadiness | null> {
	const data = await redis.hgetall(`${FCRDNS_PREFIX}${ip}`);
	if (!data['checkedAt']) return null;
	let ptrNames: string[] = [];
	try {
		const parsed = JSON.parse(data['ptrNames'] ?? '[]');
		if (Array.isArray(parsed))
			ptrNames = parsed.filter((name): name is string => typeof name === 'string');
	} catch {
		// A malformed legacy/cache value is observation data, not authority. Keep
		// the verdict readable and expose no invented PTR name.
	}
	const reason = data['reason'];
	return {
		ip,
		addressFamily: data['addressFamily'] === 'ipv6' ? 'ipv6' : 'ipv4',
		ehlo: data['ehlo'] ?? '',
		ptrNames,
		checklist: {
			ptrExists: data['ptrExists'] === 'true',
			ptrIsFqdn: data['ptrIsFqdn'] === 'true',
			forwardConfirmed: data['forwardConfirmed'] === 'true',
			ehloMatches: data['ehloMatches'] === 'true',
		},
		verdict:
			data['verdict'] === 'pass' || data['verdict'] === 'warn' || data['verdict'] === 'fail'
				? data['verdict']
				: 'error',
		genericPtr: data['genericPtr'] === 'true',
		...(reason && isFcrdnsFailureReason(reason) ? { reason } : {}),
		checkedAt: Number(data['checkedAt']),
		overridden: data['overridden'] === 'true',
	};
}

async function observeFcrdnsIdentity(
	config: FcrdnsConfig,
	ip: string,
	deps: FcrdnsDeps
): Promise<FcrdnsResult> {
	const ehlo = resolveEhloForIp(config, ip);
	let result: FcrdnsResult;
	try {
		result = await verifyFcrdns(ip, [ehlo], deps, config.genericPtrSuffixes ?? []);
	} catch (err) {
		result = failedResult(
			ip,
			normalizeDnsName(ehlo),
			[],
			'lookup-error',
			deps.now?.() ?? Date.now(),
			{
				ptrExists: false,
				ptrIsFqdn: false,
				forwardConfirmed: false,
				ehloMatches: false,
			}
		);
		logger.warn({ ip, err }, 'FCrDNS readiness check threw unexpectedly');
	}
	if (!result.ok) {
		logger.warn(
			{ ip, reason: result.reason, ptrNames: result.ptrNames, expectedEhlo: result.ehlo },
			`FCrDNS readiness failed for sending IP ${ip} (${result.reason})`
		);
	} else if (result.genericPtr) {
		logger.warn({ ip, ptrNames: result.ptrNames }, 'Sending IP uses a generic provider PTR');
	}
	return result;
}

export async function runFcrdnsSelfCheck(
	config: FcrdnsConfig,
	deps: FcrdnsDeps = DEFAULT_DEPS
): Promise<FcrdnsResult[]> {
	const ips = [...new Set([...config.ipPools.transactional, ...config.ipPools.campaign])];
	const results = await Promise.all(ips.map((ip) => observeFcrdnsIdentity(config, ip, deps)));
	logger.info(
		{ total: results.length, ready: results.filter((result) => result.ok).length },
		'FCrDNS readiness check complete'
	);
	return results;
}

/** Persist a full sweep and reconcile each IP's FCrDNS exclusion reason. */
export async function runFcrdnsReadinessCheck(
	redis: Redis,
	config: FcrdnsConfig,
	deps: FcrdnsDeps = DEFAULT_DEPS
): Promise<FcrdnsResult[]> {
	const ips = [...new Set([...config.ipPools.transactional, ...config.ipPools.campaign])];
	const observations = await Promise.all(
		ips.map(async (ip) => {
			// Allocate before DNS starts: a later sweep always has a higher fencing
			// generation even if its resolver finishes first.
			const generation = await nextIpPoolObservationGeneration(redis, ip, 'fcrdns');
			const prerequisiteGeneration =
				ipAddressFamily(ip) === 'ipv6'
					? await nextIpPoolObservationGeneration(redis, ip, 'ipv4-identity')
					: undefined;
			return {
				generation,
				prerequisiteGeneration,
				observed: await observeFcrdnsIdentity(config, ip, deps),
			};
		})
	);
	const ipv4Observations = observations
		.map((observation) => observation.observed)
		.filter((result) => result.addressFamily === 'ipv4');
	const ipv4IdentityDecision: IpPoolObservationDecision = ipv4Observations.some(
		(result) => result.verdict === 'fail'
	)
		? 'block'
		: ipv4Observations.some((result) => result.verdict === 'error')
			? 'preserve'
			: ipv4Observations.length > 0
				? 'clear'
				: 'block';
	const applyIpv4IdentityPrerequisite = async () => {
		await Promise.all(
			observations.flatMap(({ prerequisiteGeneration, observed }) => {
				if (prerequisiteGeneration === undefined || observed.addressFamily !== 'ipv6') return [];
				return [
					applyIpPoolObservation(redis, {
						ip: observed.ip,
						reason: 'ipv4-identity',
						generation: prerequisiteGeneration,
						decision: ipv4IdentityDecision,
						stateKey: `${IPV4_IDENTITY_PREFIX}${observed.ip}`,
						stateFields: {
							ready: String(ipv4IdentityDecision === 'clear'),
							checkedAt: String(deps.now?.() ?? Date.now()),
						},
					}).then((transition) => {
						if (transition.becameBlocked) pool.invalidateBindIp(observed.ip);
					}),
				];
			})
		);
	};
	// Install/preserve a prerequisite block before an FCrDNS pass could admit
	// IPv6. A clear is applied afterward so a never-observed FCrDNS state cannot
	// be made active by clearing this independent reason.
	if (ipv4IdentityDecision !== 'clear') await applyIpv4IdentityPrerequisite();
	const results = await Promise.all(
		observations.map(async ({ generation, observed }) => {
			const decision: IpPoolObservationDecision =
				observed.verdict === 'fail' ? 'block' : observed.verdict === 'error' ? 'preserve' : 'clear';
			const allowIpv4LabOverride =
				observed.addressFamily === 'ipv4' && config.allowUnverifiedFcrdns === true;
			const confirmedIpv6RegressionReason =
				observed.addressFamily === 'ipv6' &&
				observed.verdict === 'fail' &&
				observed.reason !== 'lookup-error'
					? observed.reason
					: undefined;
			const transition = await applyIpPoolObservation(redis, {
				ip: observed.ip,
				reason: 'fcrdns',
				generation,
				decision,
				override: allowIpv4LabOverride,
				stateKey: `${FCRDNS_PREFIX}${observed.ip}`,
				stateFields: readinessHash(observed),
				...(confirmedIpv6RegressionReason
					? {
							regressionAlert: {
								check: 'fcrdns' as const,
								reason: confirmedIpv6RegressionReason,
								timestamp: observed.checkedAt,
								message: `IPv6 source ${observed.ip} was quarantined after FCrDNS regressed (${confirmedIpv6RegressionReason}).`,
							},
						}
					: {}),
			});
			if (transition.becameBlocked) pool.invalidateBindIp(observed.ip);
			if (!transition.applied) {
				const current = await getFcrdnsReadiness(redis, observed.ip);
				if (current) {
					return {
						...current,
						ok: current.verdict === 'pass' || current.verdict === 'warn',
						expectedNames: [current.ehlo],
					};
				}
			}
			return {
				...observed,
				overridden: transition.wouldBlockWithoutOverride && allowIpv4LabOverride,
			};
		})
	);

	// IPv6 is an earned upgrade: every configured IPv4 identity must remain
	// green. A transient IPv4 resolver failure preserves the previous decision;
	// a confirmed regression quarantines IPv6 while IPv4 delivery can continue.
	if (ipv4IdentityDecision === 'clear') await applyIpv4IdentityPrerequisite();
	return results;
}
