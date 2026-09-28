/**
 * Deliverability Center → "Set up IPv6". The checks run in
 * `api.delivery.ipv6Setup.checkAddress`; this module turns its result into the
 * copy the panel shows and the env lines it hands over.
 */
import type { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import { DELIVERABILITY_CHECKLIST } from '@owlat/shared';
import { parseIpAddress } from '@owlat/shared/ipAddress';
import type {
	DeliverabilityChecklistGroup,
	DeliverabilityChecklistItem,
} from './deliverabilityCenter';

export type Ipv6SetupResult = FunctionReturnType<typeof api.delivery.ipv6Setup.checkAddress>;
type Ipv6SetupReport = Extract<Ipv6SetupResult, { ok: true }>;
export type Ipv6SetupCheck = Ipv6SetupReport['checks'][number];
export type Ipv6SetupRefusal = Extract<Ipv6SetupResult, { ok: false }>['refusal'];

/** The variables that switch outbound IPv6 on, in the order to show them. */
export const IPV6_SETUP_ENV_NAMES = [
	'MTA_IPV6_ENABLED',
	'IP_POOLS_TRANSACTIONAL',
	'IP_POOLS_CAMPAIGN',
] as const;

/**
 * Enabling IPv6 also flips `enable_ipv6` on the stack's Docker network, which
 * Docker applies only by recreating it — so a container restart is not enough,
 * and `owlat down` has to come first. `owlat apply` (not `owlat up`) then brings
 * the stack back AND pushes the new pools into Convex's `MTA_IP_POOLS`; with a
 * bare `up`, Convex keeps the IPv4-only pools and new domains get a return-path
 * SPF without the `ip6:` mechanism.
 */
export const IPV6_APPLY_COMMANDS = ['owlat down', 'owlat apply'] as const;

const IPV4_PREREQUISITES: readonly string[] =
	DELIVERABILITY_CHECKLIST.find((definition) => definition.id === 'deployment.ipv6_address')
		?.dependencies ?? [];

/** The IPv4 checks that must pass before IPv6 is worth setting up. */
export function ipv4Blockers(
	groups: readonly DeliverabilityChecklistGroup[]
): DeliverabilityChecklistItem[] {
	return groups
		.flatMap((group) => group.items)
		.filter(
			(item) =>
				item.scope.kind === 'deployment' &&
				IPV4_PREREQUISITES.includes(item.id) &&
				item.status !== 'pass'
		);
}

/** Bare IPv6 syntax only; the server decides whether the address can send. */
export function looksLikeIpv6(value: string): boolean {
	return parseIpAddress(value)?.family === 'ipv6';
}

export const IPV6_SETUP_REFUSAL_KEYS: Record<Ipv6SetupRefusal, string> = {
	'invalid-address': 'components.delivery.deliverabilityIpv6Setup.refusals.invalidAddress',
	'not-public': 'components.delivery.deliverabilityIpv6Setup.refusals.notPublic',
	'no-ehlo-hostname': 'components.delivery.deliverabilityIpv6Setup.refusals.noEhloHostname',
	'no-return-path-domain':
		'components.delivery.deliverabilityIpv6Setup.refusals.noReturnPathDomain',
	'no-ipv4-in-pool': 'components.delivery.deliverabilityIpv6Setup.refusals.noIpv4InPool',
};

const FAILURE_KEYS: Record<Ipv6SetupCheck['id'], Record<string, string>> = {
	ptr: {
		missing: 'components.delivery.deliverabilityIpv6Setup.checks.ptr.missing',
		mismatch: 'components.delivery.deliverabilityIpv6Setup.checks.ptr.mismatch',
	},
	aaaa: {
		missing: 'components.delivery.deliverabilityIpv6Setup.checks.aaaa.missing',
		mismatch: 'components.delivery.deliverabilityIpv6Setup.checks.aaaa.mismatch',
	},
	spf: {
		'no-spf-record': 'components.delivery.deliverabilityIpv6Setup.checks.spf.noRecord',
		'multiple-spf-records':
			'components.delivery.deliverabilityIpv6Setup.checks.spf.multipleRecords',
		'missing-ip6-mechanism':
			'components.delivery.deliverabilityIpv6Setup.checks.spf.missingMechanism',
	},
};

/** The sentence for one check: an i18n key plus the values it interpolates. */
export function ipv6CheckCopy(
	check: Ipv6SetupCheck,
	report: Pick<Ipv6SetupReport, 'address' | 'ehloHostname' | 'returnPathDomain'>
): { key: string; params: Record<string, string> } {
	const params = {
		address: report.address,
		hostname: report.ehloHostname,
		domain: report.returnPathDomain,
		found: check.found.join(', '),
	};
	if (check.status === 'pass') {
		return { key: `components.delivery.deliverabilityIpv6Setup.checks.${check.id}.pass`, params };
	}
	const key =
		(check.reason && FAILURE_KEYS[check.id][check.reason]) ??
		'components.delivery.deliverabilityIpv6Setup.checks.lookupError';
	return { key, params };
}
