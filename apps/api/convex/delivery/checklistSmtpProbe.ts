/**
 * Deployment checks judged from the MTA's live outbound SMTP probe
 * (`/health` → `smtpOutbound`, cached on the `mtaHealth` counter row).
 *
 * `deployment.port25` asks whether each source address reaches a recipient MX.
 * `deployment.source_ip` asks whether each address leaves from its own IP: the
 * MTA reports `shared_nat_egress` for two or more same-family pool IPs that it
 * cannot bind (a bridge-networked container behind NAT), because every one of
 * them then leaves from the host's single outbound address. Neither check
 * stops delivery; they only tell the operator what the MTA observed.
 */

import {
	checklistObservation,
	type ChecklistObservation,
	type ChecklistVerificationContext,
} from './checklistValidatorTypes';
import { MTA_HEALTH_MAX_AGE_MS } from './mtaHealthFreshness';

export const STALE_MTA_HEALTH =
	'The MTA health snapshot is missing or too old to verify this check.';

/**
 * The MTA probe's per-IP reason for sending IPs that NAT collapses onto one
 * egress address (apps/mta/src/routes/smtpReachability.ts). The MTA does not
 * open a port-25 connection for them.
 */
const SHARED_NAT_EGRESS = 'shared_nat_egress';

/** `observePort25`'s per-address value for an address the MTA did not probe. */
const NOT_PROBED = 'not-probed';

type ProbeEntry = { ip: string; reason?: string; sourceBinding?: 'bound' | 'nat' };

/**
 * The entries whose addresses leave through one NAT egress: those the MTA
 * reports as `shared_nat_egress`, plus every group of two or more same-family
 * addresses it reports as `nat`. The second half keeps the collapse visible
 * when a probe result lacks the reason code (e.g. an MTA whose MX lookup
 * failed before it grouped the addresses), so the check never records a pass
 * for exactly the condition it exists to flag.
 */
function sharedNatEntries<T extends ProbeEntry>(entries: readonly T[]): T[] {
	const natByFamily = new Map<string, number>();
	for (const entry of entries) {
		if (entry.sourceBinding !== 'nat') continue;
		const family = entry.ip.includes(':') ? 'ipv6' : 'ipv4';
		natByFamily.set(family, (natByFamily.get(family) ?? 0) + 1);
	}
	return entries.filter(
		(entry) =>
			entry.reason === SHARED_NAT_EGRESS ||
			(entry.sourceBinding === 'nat' &&
				(natByFamily.get(entry.ip.includes(':') ? 'ipv6' : 'ipv4') ?? 0) > 1)
	);
}

export function isMtaHealthFresh(context: ChecklistVerificationContext, now: number): boolean {
	const health = context.settings?.mtaHealth;
	return health !== undefined && now - health.observedAt <= MTA_HEALTH_MAX_AGE_MS;
}

function freshProbe(context: ChecklistVerificationContext, now: number) {
	const probe = context.settings?.mtaHealth?.smtpOutbound;
	return isMtaHealthFresh(context, now) &&
		probe !== undefined &&
		now - probe.checkedAt <= MTA_HEALTH_MAX_AGE_MS
		? probe
		: null;
}

export function observePort25(
	context: ChecklistVerificationContext,
	selectedIps: readonly string[],
	now: number
): ChecklistObservation {
	const probe = context.settings?.mtaHealth?.smtpOutbound;
	const probeFresh = freshProbe(context, now) !== null;
	const selectedIpSet = new Set(selectedIps);
	const probed =
		probe?.ips.filter((entry) => !entry.ip.includes(':') && selectedIpSet.has(entry.ip)) ?? [];
	const pass =
		probeFresh &&
		selectedIps.length > 0 &&
		probed.length === selectedIps.length &&
		probed.every((entry) => entry.status === 'ok');
	// An address sharing a NAT egress was never probed, so it says nothing about
	// port 25; `deployment.source_ip` reports the collapse. Only a real probe
	// failure fails this check.
	const realFailure = probed.some(
		(entry) => entry.status === 'failed' && entry.reason !== SHARED_NAT_EGRESS
	);
	const onlyUnprobed = !realFailure && probed.some((entry) => entry.reason === SHARED_NAT_EGRESS);
	return checklistObservation(
		'mta.smtp-reachability',
		pass ? 'pass' : probeFresh && !onlyUnprobed ? 'fail' : 'warn',
		pass
			? 'Every configured source address reached a recipient MX on port 25.'
			: !probeFresh
				? STALE_MTA_HEALTH
				: onlyUnprobed
					? 'Port 25 was not probed for sending addresses that share one NAT egress address. Fix the per-IP source address check first.'
					: 'The live port-25 probe failed for at least one source address.',
		probed.map(
			(entry) => `${entry.ip}=${entry.reason === SHARED_NAT_EGRESS ? NOT_PROBED : entry.status}`
		)
	);
}

export function observeSourceAddress(
	context: ChecklistVerificationContext,
	now: number
): ChecklistObservation {
	const probe = freshProbe(context, now);
	const addresses = probe?.ips ?? [];
	const shared = sharedNatEntries(addresses);
	const sharedIps = new Set(shared.map((entry) => entry.ip));
	// `sourceBinding` is absent when the MTA predates it; only `nat` is acted on.
	// Past `sharedNatEntries`, at most one address per family is NATed.
	const natted = addresses.find(
		(entry) => entry.sourceBinding === 'nat' && !sharedIps.has(entry.ip)
	);
	const observed = addresses.slice(0, 20).map((entry) => {
		const binding = sharedIps.has(entry.ip) ? 'shared-nat' : (entry.sourceBinding ?? 'unknown');
		return `${entry.ip}=${binding}`;
	});
	if (!probe) return checklistObservation('mta.source-address', 'warn', STALE_MTA_HEALTH);
	if (addresses.length === 0) {
		return checklistObservation(
			'mta.source-address',
			'warn',
			'The MTA reported no sending addresses.'
		);
	}
	if (shared.length > 0) {
		const sharedList = shared
			.slice(0, 20)
			.map((entry) => entry.ip)
			.join(', ');
		return checklistObservation(
			'mta.source-address',
			'fail',
			`${sharedList} share one NAT egress address. The MTA cannot bind them, so all of them leave from the host's one outbound address while each announces its own EHLO name, and warm-up and reputation are credited to addresses that did not send the mail. Delivery continues. Run the MTA with host networking or macvlan so it binds each IP, or send from one IP per install.`,
			observed
		);
	}
	return checklistObservation(
		'mta.source-address',
		'pass',
		natted
			? `${natted.ip} is sent through NAT without binding. Owlat cannot see the translated source address, so make sure the host's default outbound IPv4 address is this IP.`
			: addresses.every((entry) => entry.sourceBinding === 'bound')
				? 'Every sending address is bound to its own IP.'
				: 'No two sending addresses share a NAT egress address.',
		observed
	);
}

/**
 * The Center's next step for `deployment.port25` while its evidence says the
 * MTA skipped the probe because the addresses share a NAT egress. Port 25
 * cannot pass until `deployment.source_ip` does, and "request outbound TCP/25
 * access" is the wrong fix, so the Center locks port 25 behind the source
 * check and names that fix instead. Keyed on recorded evidence rather than a
 * static dependency so installs without the collapse, and every install
 * before its first sweep, keep the catalog's order.
 */
export const PORT25_AWAITS_SOURCE_IP_NEXT_STEP =
	'Fix "Send each address from its own IP" first: port 25 is not probed for addresses that share one NAT egress address.';

export function port25AwaitsSourceAddress(observed: readonly string[]): boolean {
	return observed.some((value) => value.endsWith(`=${NOT_PROBED}`));
}
