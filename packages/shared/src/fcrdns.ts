/**
 * Forward-confirmed reverse DNS (FCrDNS) domain vocabulary.
 *
 * This module is deliberately pure and browser-safe. The MTA supplies live DNS
 * observations; setup, health, and UI consumers interpret the resulting verdict
 * through these same types and labels instead of inventing parallel checks.
 */

export const FCRDNS_FAILURE_REASONS = [
	'no-ptr',
	'ptr-not-fqdn',
	'forward-mismatch',
	'ehlo-mismatch',
	'lookup-error',
] as const;

export type FcrdnsFailureReason = (typeof FCRDNS_FAILURE_REASONS)[number];
export type FcrdnsVerdict = 'pass' | 'warn' | 'fail' | 'error';

export interface FcrdnsChecklist {
	ptrExists: boolean;
	ptrIsFqdn: boolean;
	forwardConfirmed: boolean;
	ehloMatches: boolean;
}

export interface FcrdnsReadiness {
	ip: string;
	ehlo: string;
	ptrNames: string[];
	checklist: FcrdnsChecklist;
	verdict: FcrdnsVerdict;
	genericPtr: boolean;
	reason?: FcrdnsFailureReason;
	checkedAt: number;
	/** True only when the lab-only bypass, rather than DNS readiness, admits the IP. */
	overridden: boolean;
}

export interface FcrdnsDnsDeps {
	reverse: (ip: string) => Promise<string[]>;
	resolve4: (hostname: string) => Promise<string[]>;
}

export type FcrdnsVerification = Omit<FcrdnsReadiness, 'checkedAt' | 'overridden'>;

/**
 * Provider-owned reverse-DNS suffixes that identify their default/generated
 * hostnames. Kept as data so operators can add suffixes without changing code.
 */
export const DEFAULT_GENERIC_PTR_SUFFIXES = [
	'your-server.de',
	'clients.your-server.de',
	'compute.amazonaws.com',
	'compute.internal',
	'digitalocean.com',
	'digitaloceanspaces.com',
	'rev.poneytelecom.eu',
	'ip.linodeusercontent.com',
	'vultrusercontent.com',
] as const;

export function normalizeDnsName(name: string): string {
	return name.trim().replace(/\.$/, '').toLowerCase();
}

/** RFC-shaped, multi-label hostname check suitable for PTR/EHLO identity. */
export function isFqdn(name: string): boolean {
	const normalized = normalizeDnsName(name);
	if (normalized.length > 253 || !normalized.includes('.')) return false;
	return normalized.split('.').every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label));
}

/** Parse and validate the data-driven provider-PTR warning suffix list. */
export function parseGenericPtrSuffixes(value: string | undefined): string[] {
	const suffixes = (value ?? '').split(',').map(normalizeDnsName).filter(Boolean);
	for (const suffix of suffixes) {
		if (!isFqdn(suffix)) {
			throw new Error(`MTA_GENERIC_PTR_SUFFIXES contains an invalid DNS suffix: ${suffix}`);
		}
	}
	return [...new Set(suffixes)];
}

/** Parse the deliberately strict lab-only readiness bypass. */
export function parseUnverifiedFcrdnsOverride(value: string | undefined): boolean {
	const normalized = value?.trim() || 'false';
	if (normalized !== 'true' && normalized !== 'false') {
		throw new Error('MTA_ALLOW_UNVERIFIED_FCRDNS must be true or false');
	}
	return normalized === 'true';
}

function embedsIpv4(name: string): boolean {
	// Generated names commonly embed the address with dots or hyphens. Require
	// four octets so ordinary date/version fragments are not enough to warn.
	return /(?:^|[^0-9])(?:25[0-5]|2[0-4]\d|1?\d?\d)[.-](?:25[0-5]|2[0-4]\d|1?\d?\d)[.-](?:25[0-5]|2[0-4]\d|1?\d?\d)[.-](?:25[0-5]|2[0-4]\d|1?\d?\d)(?:[^0-9]|$)/.test(
		name
	);
}

export function isGenericPtrHostname(
	hostname: string,
	extraSuffixes: readonly string[] = []
): boolean {
	const name = normalizeDnsName(hostname);
	if (!name) return false;
	const suffixes = [...DEFAULT_GENERIC_PTR_SUFFIXES, ...extraSuffixes]
		.map(normalizeDnsName)
		.filter(Boolean);
	return (
		embedsIpv4(name) || suffixes.some((suffix) => name === suffix || name.endsWith(`.${suffix}`))
	);
}

function isMissingDnsRecord(err: unknown): boolean {
	const code = (err as { code?: string }).code;
	return code === 'ENOTFOUND' || code === 'ENODATA';
}

function failedVerification(
	ip: string,
	ehlo: string,
	ptrNames: string[],
	reason: FcrdnsFailureReason,
	checklist: FcrdnsChecklist
): FcrdnsVerification {
	return {
		ip,
		ehlo,
		ptrNames,
		checklist,
		verdict: reason === 'lookup-error' ? 'error' : 'fail',
		genericPtr: false,
		reason,
	};
}

/**
 * Canonical live validator used by runtime checks and setup preflight. DNS is
 * injected so the rule is testable and every caller classifies observations
 * identically.
 */
export async function verifyFcrdnsIdentity(
	ip: string,
	ehloHostname: string,
	deps: FcrdnsDnsDeps,
	extraGenericSuffixes: readonly string[] = []
): Promise<FcrdnsVerification> {
	const ehlo = normalizeDnsName(ehloHostname);
	const emptyChecklist: FcrdnsChecklist = {
		ptrExists: false,
		ptrIsFqdn: false,
		forwardConfirmed: false,
		ehloMatches: false,
	};

	let rawPtrNames: string[];
	try {
		rawPtrNames = await deps.reverse(ip);
	} catch (err) {
		return failedVerification(
			ip,
			ehlo,
			[],
			isMissingDnsRecord(err) ? 'no-ptr' : 'lookup-error',
			emptyChecklist
		);
	}

	const ptrNames = [...new Set(rawPtrNames.map(normalizeDnsName).filter(Boolean))];
	if (ptrNames.length === 0) {
		return failedVerification(ip, ehlo, ptrNames, 'no-ptr', emptyChecklist);
	}
	const fqdnPtrNames = ptrNames.filter(isFqdn);
	if (fqdnPtrNames.length === 0) {
		return failedVerification(ip, ehlo, ptrNames, 'ptr-not-fqdn', {
			...emptyChecklist,
			ptrExists: true,
		});
	}

	const confirmedPtrNames: string[] = [];
	let transientForwardError = false;
	for (const name of fqdnPtrNames) {
		try {
			const addresses = await deps.resolve4(name);
			if (addresses.includes(ip)) confirmedPtrNames.push(name);
		} catch (err) {
			if (!isMissingDnsRecord(err)) transientForwardError = true;
		}
	}
	if (confirmedPtrNames.length === 0) {
		return failedVerification(
			ip,
			ehlo,
			ptrNames,
			transientForwardError ? 'lookup-error' : 'forward-mismatch',
			{ ptrExists: true, ptrIsFqdn: true, forwardConfirmed: false, ehloMatches: false }
		);
	}

	const ehloMatches = confirmedPtrNames.includes(ehlo);
	if (!ehloMatches) {
		return failedVerification(ip, ehlo, ptrNames, 'ehlo-mismatch', {
			ptrExists: true,
			ptrIsFqdn: true,
			forwardConfirmed: true,
			ehloMatches: false,
		});
	}
	const genericPtr = confirmedPtrNames.some((name) =>
		isGenericPtrHostname(name, extraGenericSuffixes)
	);
	return {
		ip,
		ehlo,
		ptrNames,
		checklist: {
			ptrExists: true,
			ptrIsFqdn: true,
			forwardConfirmed: true,
			ehloMatches: true,
		},
		verdict: genericPtr ? 'warn' : 'pass',
		genericPtr,
	};
}

export type ReverseDnsProvider = 'hetzner' | 'digitalocean' | 'ovh' | 'generic';

export interface ReverseDnsGuidance {
	provider: ReverseDnsProvider;
	label: string;
	instruction: string;
}

/** Provider-specific setup copy inferred from the currently observed PTR. */
export function reverseDnsGuidance(ptrNames: readonly string[]): ReverseDnsGuidance {
	const joined = ptrNames.map(normalizeDnsName).join(' ');
	if (joined.includes('your-server.de')) {
		return {
			provider: 'hetzner',
			label: 'Hetzner',
			instruction:
				'In Hetzner Console, open Servers → your server → Networking → Primary IP → Edit reverse DNS.',
		};
	}
	if (joined.includes('digitalocean')) {
		return {
			provider: 'digitalocean',
			label: 'DigitalOcean',
			instruction:
				'In the DigitalOcean control panel, rename the Droplet to the EHLO hostname; DigitalOcean uses that name for reverse DNS.',
		};
	}
	if (joined.includes('ovh') || joined.includes('poneytelecom')) {
		return {
			provider: 'ovh',
			label: 'OVHcloud',
			instruction:
				'In OVHcloud Manager, open Network → Public IP Addresses → the IP menu → Modify reverse DNS.',
		};
	}
	return {
		provider: 'generic',
		label: 'your VPS provider',
		instruction: 'Open your VPS provider’s reverse-DNS/PTR settings for this public IP.',
	};
}

export function fcrdnsReasonMessage(reason: FcrdnsFailureReason | undefined): string {
	switch (reason) {
		case 'no-ptr':
			return 'No PTR record exists for this sending IP.';
		case 'ptr-not-fqdn':
			return 'The PTR record is not a valid fully qualified hostname.';
		case 'forward-mismatch':
			return 'The PTR hostname does not resolve back to this sending IP.';
		case 'ehlo-mismatch':
			return 'The PTR hostname does not match the EHLO hostname announced by the MTA.';
		case 'lookup-error':
			return 'DNS could not be verified right now.';
		default:
			return 'Forward-confirmed reverse DNS is ready.';
	}
}
