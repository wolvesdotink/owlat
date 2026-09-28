/**
 * Deployment checks judged from the MTA's live outbound SMTP probe
 * (`/health` → `smtpOutbound`, cached on `instanceSettings.mtaHealth`).
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

/** How old the MTA health snapshot, and the probe inside it, may be. */
const MTA_HEALTH_MAX_AGE_MS = 5 * 60_000;

export const STALE_MTA_HEALTH =
	'The MTA health snapshot is missing or too old to verify this check.';

/**
 * The MTA probe's per-IP reason for sending IPs that NAT collapses onto one
 * egress address (apps/mta/src/routes/smtpReachability.ts). The MTA does not
 * open a port-25 connection for them.
 */
const SHARED_NAT_EGRESS = 'shared_nat_egress';

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
			(entry) => `${entry.ip}=${entry.reason === SHARED_NAT_EGRESS ? 'not-probed' : entry.status}`
		)
	);
}

export function observeSourceAddress(
	context: ChecklistVerificationContext,
	now: number
): ChecklistObservation {
	const probe = freshProbe(context, now);
	const addresses = probe?.ips ?? [];
	const shared = addresses.filter((entry) => entry.reason === SHARED_NAT_EGRESS);
	// `sourceBinding` is absent when the MTA predates it; only `nat` is acted on.
	const natted = addresses.find(
		(entry) => entry.sourceBinding === 'nat' && entry.reason !== SHARED_NAT_EGRESS
	);
	const observed = addresses.slice(0, 20).map((entry) => {
		const binding =
			entry.reason === SHARED_NAT_EGRESS ? 'shared-nat' : (entry.sourceBinding ?? 'unknown');
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
		const sharedIps = shared
			.slice(0, 20)
			.map((entry) => entry.ip)
			.join(', ');
		return checklistObservation(
			'mta.source-address',
			'fail',
			`${sharedIps} share one NAT egress address. The MTA cannot bind them, so all of them leave from the host's one outbound address while each announces its own EHLO name, and warm-up and reputation are credited to addresses that did not send the mail. Delivery continues. Run the MTA with host networking or macvlan so it binds each IP, or send from one IP per install.`,
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
