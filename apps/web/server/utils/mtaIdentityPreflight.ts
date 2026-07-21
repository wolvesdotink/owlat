import { isIPv4 } from 'node:net';
import { resolve4, reverse } from 'node:dns/promises';
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
	deps: FcrdnsDnsDeps = { reverse, resolve4 }
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
	const invalidIp = ips.find((ip) => !isIPv4(ip));
	if (invalidIp) {
		return {
			ok: false,
			message: `${invalidIp} is not a valid IPv4 sending address.`,
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
			perIpEhlo = Object.fromEntries(entries as Array<[string, string]>);
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
	const identities: MtaIdentityPreflightResult['identities'] = [];
	for (const ip of ips) {
		const ehlo = normalizeDnsName(perIpEhlo[ip] ?? defaultEhlo);
		if (!isFqdn(ehlo)) {
			return {
				ok: false,
				message: `No valid EHLO hostname is configured for ${ip}. Set EHLO_HOSTNAME or EHLO_HOSTNAMES to an FQDN.`,
				identities,
			};
		}
		const result = await verifyFcrdnsIdentity(ip, ehlo, deps, extraSuffixes);
		const hardFailure = result.verdict === 'fail' || result.verdict === 'error';
		identities.push({ ...result, overridden: hardFailure && allowOverride });
		if (hardFailure && !allowOverride) {
			const guidance = reverseDnsGuidance(result.ptrNames);
			return {
				ok: false,
				message:
					`Outbound IP ${ip} is quarantined: ${fcrdnsReasonMessage(result.reason)} ` +
					`Set its PTR exactly to ${ehlo}. ${guidance.instruction}`,
				identities,
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
	};
}
