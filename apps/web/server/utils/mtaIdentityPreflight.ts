import { resolve4, resolve6, reverse } from 'node:dns/promises';
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
import { isIpv4MappedIpv6, parseIpAddress, parseIpv6Enabled } from '@owlat/shared/ipAddress';

export interface MtaIdentityPreflightResult {
	ok: boolean;
	message: string;
	identities: Array<FcrdnsVerification & { overridden: boolean }>;
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
	deps: FcrdnsDnsDeps = { reverse, resolve4, resolve6 }
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
	if (
		normalizedIps.some((ip) => ip.family === 'ipv6') &&
		!normalizedIps.some((ip) => ip.family === 'ipv4')
	) {
		return {
			ok: false,
			message: 'Outbound IPv6 requires at least one configured IPv4 address as a safe fallback.',
			identities: [],
		};
	}

	const defaultEhlo = normalizeDnsName(env['EHLO_HOSTNAME'] ?? '');
	let perIpEhlo: Record<string, string> = {};
	if (env['EHLO_HOSTNAMES']?.trim()) {
		try {
			const parsed: unknown = JSON.parse(env['EHLO_HOSTNAMES']);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
			const entries = Object.entries(parsed as Record<string, unknown>);
			if (entries.some(([, hostname]) => typeof hostname !== 'string')) throw new Error();
			perIpEhlo = Object.fromEntries(
				(entries as Array<[string, string]>).map(([ip, hostname]) => [
					parseIpAddress(ip)?.address ?? ip,
					hostname,
				])
			);
		} catch {
			return {
				ok: false,
				message: 'EHLO_HOSTNAMES must be a JSON object mapping IP addresses to hostnames.',
				identities: [],
			};
		}
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
	return {
		ok: true,
		message:
			allowOverride && identities.some((identity) => identity.overridden)
				? 'Outbound IP identity failures are bypassed by MTA_ALLOW_UNVERIFIED_FCRDNS (lab use only).'
				: 'Every outbound IP passed the live FCrDNS preflight.',
		identities,
	};
}
