import { resolve4, resolve6, resolveTxt, reverse } from 'node:dns/promises';
import {
	fcrdnsReasonMessage,
	isFqdn,
	normalizeDnsName,
	parseGenericPtrSuffixes,
	parseUnverifiedFcrdnsOverride,
	reverseDnsGuidance,
	verifyFcrdnsIdentity,
	type FcrdnsDnsDeps,
	type FcrdnsVerification,
} from '@owlat/shared/fcrdns';
import {
	hasIpv4FallbackForIpv6,
	isIpv4MappedIpv6,
	parseIpAddress,
	parseIpv6Enabled,
} from '@owlat/shared/ipAddress';
import { parseCanonicalEhloHostnames } from '@owlat/shared/outboundIdentity';
import { evaluateIpv6SpfRecords, type Ipv6SpfReadiness } from '@owlat/shared/ipReadiness';

export interface MtaIdentityPreflightResult {
	ok: boolean;
	message: string;
	identities: Array<FcrdnsVerification & { overridden: boolean }>;
	ipv6Spf?: Ipv6SpfReadiness[];
}

export interface MtaIdentityPreflightDeps extends FcrdnsDnsDeps {
	resolveTxt?: (hostname: string) => Promise<string[][]>;
	now?: () => number;
}

function commaList(value: string | undefined): string[] {
	return (value ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

/**
 * Run setup against the same canonical FCrDNS validator the MTA calls hourly.
 * The env map is the not-yet-persisted wizard result, so a failure leaves setup
 * mode active and no send profile can be declared complete.
 */
export async function preflightMtaIdentities(
	env: Record<string, string>,
	deps: MtaIdentityPreflightDeps = { reverse, resolve4, resolve6, resolveTxt }
): Promise<MtaIdentityPreflightResult> {
	const ips = [
		...new Set([
			...commaList(env['IP_POOLS_TRANSACTIONAL']),
			...commaList(env['IP_POOLS_CAMPAIGN']),
		]),
	];
	if (ips.length === 0) {
		return {
			ok: false,
			message: 'No sending IPs are configured in IP_POOLS_TRANSACTIONAL or IP_POOLS_CAMPAIGN.',
			identities: [],
		};
	}
	let ipv6Enabled: boolean;
	try {
		ipv6Enabled = parseIpv6Enabled(env['MTA_IPV6_ENABLED']);
	} catch (err) {
		return { ok: false, message: (err as Error).message, identities: [] };
	}
	const parsedIps = ips.map((ip) => ({ raw: ip, parsed: parseIpAddress(ip) }));
	const invalidIp = parsedIps.find(({ parsed }) => !parsed);
	if (invalidIp?.parsed === null) {
		return {
			ok: false,
			message: `${invalidIp.raw} is not a valid bare sending IP address.`,
			identities: [],
		};
	}
	const normalizedIps = parsedIps.map(({ parsed }) => parsed!);
	const invalidIpv6 = normalizedIps.find(
		(ip) => ip.family === 'ipv6' && (ip.address === '::' || isIpv4MappedIpv6(ip.address))
	);
	if (invalidIpv6) {
		return {
			ok: false,
			message: `${invalidIpv6.address} is not a stable native IPv6 source address.`,
			identities: [],
		};
	}
	if (normalizedIps.some((ip) => ip.family === 'ipv6') && !ipv6Enabled) {
		return {
			ok: false,
			message: 'IPv6 pool entries require the explicit MTA_IPV6_ENABLED=true opt-in.',
			identities: [],
		};
	}
	for (const [name, rawPool] of [
		['transactional', commaList(env['IP_POOLS_TRANSACTIONAL'])],
		['campaign', commaList(env['IP_POOLS_CAMPAIGN'])],
	] as const) {
		const addresses = rawPool.flatMap((ip) => {
			const parsed = parseIpAddress(ip);
			return parsed ? [parsed.address] : [];
		});
		if (!hasIpv4FallbackForIpv6(addresses)) {
			return {
				ok: false,
				message: `Outbound IPv6 in the ${name} pool requires an IPv4 fallback in that same pool.`,
				identities: [],
			};
		}
	}

	const defaultEhlo = normalizeDnsName(env['EHLO_HOSTNAME'] ?? '');
	let perIpEhlo: Record<string, string> = {};
	try {
		perIpEhlo = parseCanonicalEhloHostnames(env['EHLO_HOSTNAMES']);
	} catch (error) {
		return { ok: false, message: (error as Error).message, identities: [] };
	}
	let extraSuffixes: string[];
	let allowOverride: boolean;
	try {
		extraSuffixes = parseGenericPtrSuffixes(env['MTA_GENERIC_PTR_SUFFIXES']);
		allowOverride = parseUnverifiedFcrdnsOverride(env['MTA_ALLOW_UNVERIFIED_FCRDNS']);
	} catch (err) {
		return { ok: false, message: (err as Error).message, identities: [] };
	}
	const findings = await Promise.all(
		normalizedIps.map(async ({ address: ip, family }) => {
			const ehlo = normalizeDnsName(perIpEhlo[ip] ?? defaultEhlo);
			if (!isFqdn(ehlo)) {
				return {
					failure: `Outbound IP ${ip}: set EHLO_HOSTNAME or EHLO_HOSTNAMES to a valid FQDN.`,
				};
			}
			const result = await verifyFcrdnsIdentity(ip, ehlo, deps, extraSuffixes);
			const hardFailure = result.verdict === 'fail' || result.verdict === 'error';
			const overridden = family === 'ipv4' && hardFailure && allowOverride;
			const identity = { ...result, overridden };
			if (hardFailure && !overridden) {
				const guidance = reverseDnsGuidance(result.ptrNames);
				return {
					identity,
					failure:
						`Outbound IP ${ip} is quarantined: ${fcrdnsReasonMessage(result.reason)} ` +
						`Set its PTR exactly to ${ehlo}. ${guidance.instruction}`,
				};
			}
			return { identity };
		})
	);
	const identities = findings.flatMap((finding) => (finding.identity ? [finding.identity] : []));
	const failures = findings.flatMap((finding) => (finding.failure ? [finding.failure] : []));
	if (
		normalizedIps.some((ip) => ip.family === 'ipv6') &&
		identities.some(
			(identity) =>
				identity.addressFamily === 'ipv4' &&
				(identity.verdict === 'fail' || identity.verdict === 'error')
		)
	) {
		failures.push(
			'Outbound IPv6 stays locked until every configured IPv4 identity passes FCrDNS without a lab override.'
		);
	}
	if (failures.length > 0) {
		return { ok: false, message: failures.join('\n'), identities };
	}
	let ipv6Spf: Ipv6SpfReadiness[] | undefined;
	const ipv6Ips = normalizedIps.filter((ip) => ip.family === 'ipv6').map((ip) => ip.address);
	if (ipv6Ips.length > 0) {
		const returnPathDomain = normalizeDnsName(env['RETURN_PATH_DOMAIN'] ?? '');
		if (!isFqdn(returnPathDomain)) {
			return {
				ok: false,
				message: 'RETURN_PATH_DOMAIN must be a valid FQDN before outbound IPv6 can be enabled.',
				identities,
			};
		}
		if (!deps.resolveTxt) {
			return {
				ok: false,
				message: 'Live return-path SPF validation is unavailable.',
				identities,
			};
		}
		try {
			const checkedAt = deps.now?.() ?? Date.now();
			const records = (await deps.resolveTxt(returnPathDomain)).map((chunks) => chunks.join(''));
			ipv6Spf = ipv6Ips.map((ip) =>
				evaluateIpv6SpfRecords(ip, returnPathDomain, records, checkedAt)
			);
		} catch {
			return {
				ok: false,
				message: `Could not resolve the live SPF TXT record for ${returnPathDomain}.`,
				identities,
			};
		}
		const spfFailures = ipv6Spf.filter((readiness) => readiness.verdict !== 'pass');
		if (spfFailures.length > 0) {
			return {
				ok: false,
				message: spfFailures
					.map(
						(readiness) =>
							`Outbound IP ${readiness.ip}: return-path SPF on ${returnPathDomain} failed (${readiness.reason}).`
					)
					.join('\n'),
				identities,
				ipv6Spf,
			};
		}
	}
	return {
		ok: true,
		message:
			allowOverride && identities.some((identity) => identity.overridden)
				? 'Outbound IP identity failures are bypassed by MTA_ALLOW_UNVERIFIED_FCRDNS (lab use only).'
				: 'Every outbound IP passed the live FCrDNS preflight.',
		identities,
		...(ipv6Spf ? { ipv6Spf } : {}),
	};
}
