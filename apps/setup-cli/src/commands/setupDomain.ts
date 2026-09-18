/**
 * Terminal-wizard section: the sending identity (EHLO + Return-Path domain) and
 * the reverse-DNS record that identity is worthless without.
 *
 * Split out of `setup.ts` so the PTR step has room to explain itself. Choosing
 * an EHLO hostname is only half the decision: the other half is a PTR record on
 * the sending IP, set in the hosting provider's console — something only the
 * operator can do, and something the installer's identity gate will later refuse
 * to bring the stack up without. Asking for it at the moment the hostname is
 * chosen is the only point where it is still cheap.
 */

import { group, text } from '@clack/prompts';
import type { EnvMap } from '../lib/env';
import { detectPrimaryIpv4 } from '../lib/outboundIp';
import { announceReverseDns, plannedOutboundIdentities } from '../lib/reverseDns';

export async function collectDomain(): Promise<EnvMap | null> {
	const result = await group({
		ehlo: () =>
			text({
				message: "EHLO hostname (must match this server's reverse DNS / PTR record)",
				placeholder: 'mail.example.com',
			}),
		bounceDomain: () =>
			text({ message: 'Bounce / Return-Path domain', placeholder: 'bounces.example.com' }),
	});
	const env: EnvMap = {
		EHLO_HOSTNAME: result.ehlo,
		RETURN_PATH_DOMAIN: result.bounceDomain,
	};
	// The sending pools are not configured yet — `quickstart` defaults them to
	// this box's primary IPv4 — so check the PTR of the address they will get.
	const ip = detectPrimaryIpv4();
	if (ip) {
		const identities = plannedOutboundIdentities({ ...env, IP_POOLS_TRANSACTIONAL: ip });
		await announceReverseDns(identities, env, { interactive: true });
	}
	return env;
}
