/**
 * Pre-flight sending-IP audit (live probes).
 *
 * Runs at boot and daily: port-25 egress, the blocklists, forward-confirmed
 * reverse DNS, and the /24 neighbourhood — then hands the observations to the
 * pure verdict engine in @owlat/shared/ipAudit.
 *
 * Two deliberate properties:
 *   * it REUSES the shipped lookup paths (the DNSBL client in
 *     intelligence/dnsbl.ts, the FCrDNS verifier in scaling/fcrdns.ts, the
 *     reachability probe behind scaling/port25Probe.ts) rather than adding a
 *     second one, and
 *   * it is ADVISORY ONLY. It never touches the IP pool, never quarantines an
 *     address, and never blocks a send. Routing keeps reacting to the shipped
 *     DNSBL sweep exactly as before.
 */

import { resolve4, resolve6, reverse } from 'node:dns/promises';
import type Redis from 'ioredis';
import {
	decodeSpamhausAnswers,
	evaluateIpAudit,
	IP_AUDIT_ZONES,
	type IpAuditReport,
	type IpAuditZoneId,
	type IpAuditZoneObservation,
} from '@owlat/shared/ipAudit';
import { ipAddressFamily, type IpAddressFamily } from '@owlat/shared/ipAddress';
import type { MtaConfig } from '../config.js';
import { resolveEhloForIp } from '../config.js';
import { lookupDnsblZone } from '../intelligence/dnsbl.js';
import { logger } from '../monitoring/logger.js';
import { verifyFcrdns } from './fcrdns.js';
import { probePort25Egress, type Port25ProbeResult } from './port25Probe.js';

const IP_AUDIT_PREFIX = 'mta:ip-audit:';
const AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Cheap staleness poll so a fresh install is audited within the hour. */
const AUDIT_DUE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const ZONE_TIMEOUT_MS = 5_000;

/** Deterministic /24 sample: spread across the block, never the whole block. */
export const NEIGHBOUR_SAMPLE_OFFSETS = [
	1, 17, 33, 49, 65, 81, 97, 113, 129, 145, 161, 177, 193, 209, 225, 241,
] as const;

export type IpAuditConfig = Pick<
	MtaConfig,
	'ipPools' | 'ehloHostname' | 'ehloHostnames' | 'abusixDnsblApiKey'
> &
	Partial<Pick<MtaConfig, 'genericPtrSuffixes' | 'invaluementDnsblZone'>>;

export interface IpAuditDnsDeps {
	resolve4: (hostname: string) => Promise<string[]>;
	resolve6?: (hostname: string) => Promise<string[]>;
	reverse: (ip: string) => Promise<string[]>;
}

export interface IpAuditDeps {
	now: () => number;
	dns: IpAuditDnsDeps;
	port25: (ip: string) => Promise<Port25ProbeResult>;
	/** Sample size for the /24 neighbourhood; 0 disables the neighbour probe. */
	neighbourSampleSize?: number;
	zoneTimeoutMs?: number;
}

export interface IpAuditRecord extends IpAuditReport {
	/** Per-target port-25 detail, kept beside the verdict for the operator. */
	port25Detail: Port25ProbeResult;
}

export function defaultIpAuditDeps(): IpAuditDeps {
	return {
		now: Date.now,
		dns: { resolve4, resolve6, reverse },
		port25: (ip) => probePort25Egress(ip, { now: Date.now }),
	};
}

/**
 * Zones to query for one address family. Keyed feeds are additive-only: without
 * their credential the zone is SKIPPED, which is inert — it neither lowers the
 * verdict nor raises a warning.
 */
export function auditZonesFor(
	config: Pick<IpAuditConfig, 'abusixDnsblApiKey' | 'invaluementDnsblZone'>,
	family: IpAddressFamily
): { zoneId: IpAuditZoneId; zone: string | null }[] {
	return IP_AUDIT_ZONES.filter((zone) => zone.addressFamilies.includes(family)).map((zone) => {
		if (zone.id === 'abusix') {
			return {
				zoneId: zone.id,
				zone: config.abusixDnsblApiKey ? `${config.abusixDnsblApiKey}.${zone.zone}` : null,
			};
		}
		if (zone.id === 'invaluement') {
			return { zoneId: zone.id, zone: config.invaluementDnsblZone ?? null };
		}
		return { zoneId: zone.id, zone: zone.zone };
	});
}

/** Sample addresses from the same /24. IPv6 has no comparable neighbourhood. */
export function neighbourAddresses(ip: string, sampleSize: number): string[] {
	if (sampleSize <= 0 || ipAddressFamily(ip) !== 'ipv4') return [];
	const octets = ip.split('.');
	if (octets.length !== 4) return [];
	const prefix = octets.slice(0, 3).join('.');
	const own = Number(octets[3]);
	const neighbours: string[] = [];
	for (const offset of NEIGHBOUR_SAMPLE_OFFSETS) {
		if (neighbours.length >= sampleSize) break;
		if (offset === own) continue;
		neighbours.push(`${prefix}.${offset}`);
	}
	return neighbours;
}

async function observeZones(
	ip: string,
	config: IpAuditConfig,
	family: IpAddressFamily,
	timeoutMs: number,
	deps: IpAuditDeps
): Promise<IpAuditZoneObservation[]> {
	const zones = auditZonesFor(config, family);
	return Promise.all(
		zones.map(async (entry): Promise<IpAuditZoneObservation> => {
			if (!entry.zone) {
				return { zoneId: entry.zoneId, status: 'skipped', sublists: [], answers: [] };
			}
			const result = await lookupDnsblZone(ip, entry.zoneId, entry.zone, {
				resolve4: deps.dns.resolve4,
				timeoutMs,
			});
			return {
				zoneId: entry.zoneId,
				status: result.status,
				sublists: entry.zoneId === 'spamhaus' ? decodeSpamhausAnswers(result.answers) : [],
				answers: result.answers,
			};
		})
	);
}

async function observeNeighbourhood(
	ip: string,
	sampleSize: number,
	timeoutMs: number,
	deps: IpAuditDeps
): Promise<{ sampled: number; listed: number }> {
	const neighbours = neighbourAddresses(ip, sampleSize);
	if (neighbours.length === 0) return { sampled: 0, listed: 0 };
	const spamhaus = IP_AUDIT_ZONES.find((zone) => zone.id === 'spamhaus');
	if (!spamhaus) return { sampled: 0, listed: 0 };

	const results = await Promise.all(
		neighbours.map(async (neighbour) => {
			try {
				const result = await lookupDnsblZone(neighbour, 'spamhaus', spamhaus.zone, {
					resolve4: deps.dns.resolve4,
					timeoutMs,
				});
				if (result.status === 'unknown') return null;
				if (result.status === 'clean') return false;
				const sublists = decodeSpamhausAnswers(result.answers);
				// A whole /24 in the PBL is a policy statement about the range, not
				// evidence that the neighbours are spamming.
				return sublists.some((sublist) => sublist !== 'pbl');
			} catch {
				return null;
			}
		})
	);
	const definite = results.filter((result): result is boolean => result !== null);
	return { sampled: definite.length, listed: definite.filter(Boolean).length };
}

/** Audit one sending address end to end. Every probe is bounded. */
export async function auditIp(
	ip: string,
	config: IpAuditConfig,
	deps: IpAuditDeps
): Promise<IpAuditRecord> {
	const family = ipAddressFamily(ip);
	const timeoutMs = deps.zoneTimeoutMs ?? ZONE_TIMEOUT_MS;
	const sampleSize = deps.neighbourSampleSize ?? NEIGHBOUR_SAMPLE_OFFSETS.length;
	const ehlo = resolveEhloForIp(config, ip);

	const [port25Detail, zones, neighbourhood, fcrdns] = await Promise.all([
		deps.port25(ip).catch(
			(): Port25ProbeResult => ({
				ip,
				status: 'unknown',
				reason: 'inconclusive',
				checkedAt: deps.now(),
				targets: [],
			})
		),
		family
			? observeZones(ip, config, family, timeoutMs, deps)
			: Promise.resolve<IpAuditZoneObservation[]>([]),
		observeNeighbourhood(ip, sampleSize, timeoutMs, deps),
		verifyFcrdns(
			ip,
			[ehlo],
			{ ...deps.dns, now: deps.now, timeoutMs },
			config.genericPtrSuffixes ?? []
		).catch(() => null),
	]);

	const report = evaluateIpAudit({
		ip,
		checkedAt: deps.now(),
		port25: port25Detail.status,
		zones,
		fcrdns: fcrdns
			? { verdict: fcrdns.verdict, ...(fcrdns.reason ? { reason: fcrdns.reason } : {}) }
			: { verdict: 'error' },
		neighbourhood,
	});
	return { ...report, port25Detail };
}

export function ipAuditKey(ip: string): string {
	return `${IP_AUDIT_PREFIX}${ip}`;
}

export async function storeIpAuditRecord(redis: Redis, record: IpAuditRecord): Promise<void> {
	await redis.set(ipAuditKey(record.ip), JSON.stringify(record));
}

/** Read the last stored audit. A missing or corrupt record is simply absent. */
export async function getIpAuditRecord(redis: Redis, ip: string): Promise<IpAuditRecord | null> {
	const raw = await redis.get(ipAuditKey(ip));
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return null;
		return parsed as IpAuditRecord;
	} catch {
		return null;
	}
}

export function configuredAuditIps(config: Pick<IpAuditConfig, 'ipPools'>): string[] {
	return [...new Set([...config.ipPools.transactional, ...config.ipPools.campaign])];
}

/** Audit every configured address and persist the results. Never throws. */
export async function runIpAuditSweep(
	redis: Redis,
	config: IpAuditConfig,
	deps: IpAuditDeps
): Promise<IpAuditRecord[]> {
	const records: IpAuditRecord[] = [];
	for (const ip of configuredAuditIps(config)) {
		try {
			const record = await auditIp(ip, config, deps);
			await storeIpAuditRecord(redis, record);
			records.push(record);
			if (record.verdict !== 'clean') {
				logger.warn(
					{ ip, verdict: record.verdict, confidence: record.confidence },
					'Pre-flight IP audit found issues'
				);
			}
		} catch {
			// Advisory by design: a failed audit must never affect delivery.
			logger.warn({ ip, operation: 'ip_audit' }, 'Pre-flight IP audit failed');
		}
	}
	return records;
}

/** True when any configured address has no audit, or one older than a day. */
export async function ipAuditIsDue(
	redis: Redis,
	config: Pick<IpAuditConfig, 'ipPools'>,
	now: number
): Promise<boolean> {
	const ips = configuredAuditIps(config);
	if (ips.length === 0) return false;
	for (const ip of ips) {
		const record = await getIpAuditRecord(redis, ip);
		if (!record || typeof record.checkedAt !== 'number') return true;
		if (now - record.checkedAt >= AUDIT_INTERVAL_MS) return true;
	}
	return false;
}

/**
 * Start the auditor: audit at install (as soon as this process holds the cron
 * lease) and daily thereafter. Fire-and-forget by design — unlike the DNSBL
 * sweep it gates nothing, so it must never delay or fail startup.
 */
export function startIpAuditor(
	redis: Redis,
	config: IpAuditConfig,
	isLeader: () => boolean,
	deps: IpAuditDeps
): NodeJS.Timeout {
	const tick = async () => {
		if (!isLeader()) return;
		if (!(await ipAuditIsDue(redis, config, deps.now()))) return;
		await runIpAuditSweep(redis, config, deps);
	};
	const runSafely = () => {
		void tick().catch(() =>
			logger.warn({ operation: 'ip_audit_sweep' }, 'Pre-flight IP audit sweep failed')
		);
	};
	runSafely();
	return setInterval(runSafely, AUDIT_DUE_CHECK_INTERVAL_MS);
}
