/**
 * The DNS half of turning on outbound IPv6, run against an address the admin
 * has not configured yet.
 *
 * The MTA only proves an IPv6 identity once the address is in a pool, and it
 * refuses a pool entry until `MTA_IPV6_ENABLED=true`. So the Deliverability
 * Center's own IPv6 checks cannot help an operator who has not switched it on.
 * This runs the same three DNS facts the MTA later re-checks hourly (PTR to the
 * EHLO name, AAAA back to the address, an exact `ip6:` in the return-path SPF)
 * before the switch, and hands back the exact env lines to make it.
 *
 * Pure: the resolver is injected, so the Node action is a thin shell around it.
 */

import { hasIpv4FallbackForIpv6, ipv6HexNibbles, parseIpAddress } from '@owlat/shared/ipAddress';
import { isFqdn } from '@owlat/shared/fcrdns';
import { evaluateIpv6SpfRecords, type Ipv6SpfFailureReason } from '@owlat/shared/ipReadiness';
import { normalizeDomain } from '@owlat/shared';

export type Ipv6SetupRefusal =
	| 'invalid-address'
	| 'not-public'
	| 'no-ehlo-hostname'
	| 'no-return-path-domain'
	| 'no-ipv4-in-pool';

export type Ipv6SetupCheckId = 'ptr' | 'aaaa' | 'spf';

export type Ipv6SetupCheckReason = 'missing' | 'mismatch' | 'lookup-error' | Ipv6SpfFailureReason;

export interface Ipv6SetupCheck {
	id: Ipv6SetupCheckId;
	status: 'pass' | 'fail';
	reason?: Ipv6SetupCheckReason;
	/** What DNS answered instead (PTR names, AAAA addresses), when it answered. */
	found: string[];
}

export type Ipv6SetupEnv = {
	MTA_IPV6_ENABLED: 'true';
	IP_POOLS_TRANSACTIONAL?: string;
	IP_POOLS_CAMPAIGN?: string;
};

export type Ipv6SetupResult =
	| { ok: false; refusal: Ipv6SetupRefusal }
	| {
			ok: true;
			address: string;
			ehloHostname: string;
			returnPathDomain: string;
			/** Every check passed: the env lines are safe to apply. */
			ready: boolean;
			checks: Ipv6SetupCheck[];
			/** Pool lines are present only when the MTA has reported its pools. */
			env: Ipv6SetupEnv;
	  };

export interface Ipv6SetupInput {
	address: string;
	ehloHostname: string | undefined;
	returnPathDomain: string | undefined;
	pools: { transactional: string[]; campaign: string[] } | null;
}

export interface Ipv6SetupDnsDeps {
	reverse: (ip: string) => Promise<string[]>;
	resolve6: (hostname: string) => Promise<string[]>;
	resolveTxt: (hostname: string) => Promise<string[][]>;
	now: () => number;
}

const MISSING_RECORD_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

function isMissingRecord(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'string' && MISSING_RECORD_CODES.has(code);
}

/**
 * Global unicast (2000::/3) outside the documentation prefix 2001:db8::/32.
 * Link-local, unique-local, loopback, multicast and mapped addresses cannot be
 * a public sending identity.
 */
export function isPublicIpv6(address: string): boolean {
	const nibbles = ipv6HexNibbles(address);
	if (!nibbles) return false;
	if (nibbles[0] !== '2' && nibbles[0] !== '3') return false;
	return !nibbles.startsWith('20010db8');
}

/** Append the address to a pool, keeping the operator's order and spelling. */
export function withAddress(pool: readonly string[], address: string): string {
	const present = pool.some((entry) => parseIpAddress(entry)?.address === address);
	return (present ? pool : [...pool, address]).join(',');
}

async function checkPtr(
	address: string,
	ehloHostname: string,
	deps: Ipv6SetupDnsDeps
): Promise<Ipv6SetupCheck> {
	try {
		const names = (await deps.reverse(address)).map(normalizeDomain);
		if (names.includes(ehloHostname)) return { id: 'ptr', status: 'pass', found: names };
		return {
			id: 'ptr',
			status: 'fail',
			reason: names.length === 0 ? 'missing' : 'mismatch',
			found: names,
		};
	} catch (error) {
		return {
			id: 'ptr',
			status: 'fail',
			reason: isMissingRecord(error) ? 'missing' : 'lookup-error',
			found: [],
		};
	}
}

async function checkAaaa(
	address: string,
	ehloHostname: string,
	deps: Ipv6SetupDnsDeps
): Promise<Ipv6SetupCheck> {
	try {
		const addresses = (await deps.resolve6(ehloHostname)).map(
			(entry) => parseIpAddress(entry)?.address ?? entry
		);
		if (addresses.includes(address)) return { id: 'aaaa', status: 'pass', found: addresses };
		return {
			id: 'aaaa',
			status: 'fail',
			reason: addresses.length === 0 ? 'missing' : 'mismatch',
			found: addresses,
		};
	} catch (error) {
		return {
			id: 'aaaa',
			status: 'fail',
			reason: isMissingRecord(error) ? 'missing' : 'lookup-error',
			found: [],
		};
	}
}

async function checkSpf(
	address: string,
	returnPathDomain: string,
	deps: Ipv6SetupDnsDeps
): Promise<Ipv6SetupCheck> {
	let records: string[];
	try {
		records = (await deps.resolveTxt(returnPathDomain)).map((chunks) => chunks.join(''));
	} catch (error) {
		if (!isMissingRecord(error)) {
			return { id: 'spf', status: 'fail', reason: 'lookup-error', found: [] };
		}
		records = [];
	}
	const verdict = evaluateIpv6SpfRecords(address, returnPathDomain, records, deps.now());
	return verdict.verdict === 'pass'
		? { id: 'spf', status: 'pass', found: [] }
		: {
				id: 'spf',
				status: 'fail',
				...(verdict.reason ? { reason: verdict.reason } : {}),
				found: [],
			};
}

export async function checkIpv6SendingAddress(
	input: Ipv6SetupInput,
	deps: Ipv6SetupDnsDeps
): Promise<Ipv6SetupResult> {
	const parsed = parseIpAddress(input.address.trim());
	if (!parsed || parsed.family !== 'ipv6') return { ok: false, refusal: 'invalid-address' };
	const address = parsed.address;
	if (!isPublicIpv6(address)) return { ok: false, refusal: 'not-public' };

	const ehloHostname = normalizeDomain(input.ehloHostname ?? '');
	if (!isFqdn(ehloHostname)) return { ok: false, refusal: 'no-ehlo-hostname' };
	const returnPathDomain = normalizeDomain(input.returnPathDomain ?? '');
	if (!isFqdn(returnPathDomain)) return { ok: false, refusal: 'no-return-path-domain' };

	// The MTA refuses to boot when a pool holds IPv6 without IPv4 beside it.
	const transactional = input.pools ? withAddress(input.pools.transactional, address) : null;
	const campaign = input.pools ? withAddress(input.pools.campaign, address) : null;
	for (const pool of [transactional, campaign]) {
		if (pool !== null && !hasIpv4FallbackForIpv6(pool.split(','))) {
			return { ok: false, refusal: 'no-ipv4-in-pool' };
		}
	}

	const checks = await Promise.all([
		checkPtr(address, ehloHostname, deps),
		checkAaaa(address, ehloHostname, deps),
		checkSpf(address, returnPathDomain, deps),
	]);
	return {
		ok: true,
		address,
		ehloHostname,
		returnPathDomain,
		ready: checks.every((check) => check.status === 'pass'),
		checks,
		env: {
			MTA_IPV6_ENABLED: 'true',
			...(transactional !== null ? { IP_POOLS_TRANSACTIONAL: transactional } : {}),
			...(campaign !== null ? { IP_POOLS_CAMPAIGN: campaign } : {}),
		},
	};
}
