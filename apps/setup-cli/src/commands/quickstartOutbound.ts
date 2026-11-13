/**
 * The outbound port-25 check quickstart runs once the stack is up.
 *
 * Most VPS providers block outbound TCP/25 on new accounts. The identity gate
 * cannot see that, so an install can pass it, print its summary, and then hold
 * every message in the queue. This reads the MTA's own TCP/25 probe (the one
 * `owlat doctor` reports) and turns a block into a warning in the summary. It
 * never fails the install: the operator can fix the port, or switch to a relay,
 * without reinstalling.
 */

import { isOwnSendProviderKind } from '@owlat/shared/sendProviderCatalog';
import { installerProviderNote } from '@owlat/shared/ipAuditProviders';
import type { EnvMap } from '../lib/env';
import { resolveLocalHost } from '../lib/localHost';
import {
	evaluateOutboundPort25,
	fetchMtaHealth,
	type MtaHealthBody,
	type OutboundPort25,
} from './doctor';

const SENDING_FROM_A_VPS_GUIDE = 'https://docs.owlat.app/guide/sending-from-a-vps';

/**
 * The MTA's `/health` opens a TCP/25 connection per sending IP, and a silently
 * dropped port only fails once its 5s connect timeout runs out. Doctor's 3s
 * budget is too short for that on a cold probe cache, so this check allows for
 * the MX lookup and the connect timeout together.
 */
const PORT25_PROBE_TIMEOUT_MS = 20_000;

/** The MTA's HTTP API as the installer reaches it on this box. */
export function localMtaUrl(env: EnvMap): string {
	return `http://${resolveLocalHost(process.env)}:${env['MTA_HTTP_PORT'] ?? '3100'}`;
}

/**
 * Probe outbound TCP/25 through the MTA. `unknown` when the built-in MTA is
 * not the delivery provider, or when the probe could not answer.
 */
export async function checkOutboundPort25(
	env: EnvMap,
	fetchHealth: (url: string) => Promise<MtaHealthBody> = (url) =>
		fetchMtaHealth(url, PORT25_PROBE_TIMEOUT_MS)
): Promise<OutboundPort25> {
	if (!isOwnSendProviderKind(env['EMAIL_PROVIDER'])) return { status: 'unknown' };
	const health = await fetchHealth(localMtaUrl(env));
	return health.ok ? evaluateOutboundPort25(health.body) : { status: 'unknown' };
}

/** The summary lines for a blocked port; nothing for any other result. */
export function outboundPort25Warning(result: OutboundPort25, env: EnvMap): string[] {
	if (result.status !== 'blocked') return [];
	// The generic note points at an audit section this summary does not have,
	// so only a named provider's own note is worth a line here.
	const provider = installerProviderNote(env['MTA_VPS_PROVIDER'] ?? '');
	return [
		`Outbound port 25 is blocked from ${result.ips.join(', ')}. Mail to other servers cannot leave this box and waits in the queue until the port opens.`,
		...(provider.provider === 'other' ? [] : [provider.note]),
		'To send mail, do one of these:',
		'  • ask your hosting provider to unblock outbound port 25 for this server, or',
		'  • send through an SMTP relay: set EMAIL_PROVIDER=smtp and the SMTP_RELAY_* settings, then run `owlat apply`.',
		`Guide: ${SENDING_FROM_A_VPS_GUIDE}`,
		'Run `owlat doctor` to check again.',
	];
}
