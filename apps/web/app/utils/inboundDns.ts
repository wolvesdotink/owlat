/**
 * Pure helpers for the Settings → Domains "Receiving" panel.
 *
 * The sending side of that page walks the user through SPF/DKIM/DMARC/MAIL FROM
 * DNS. This is the inbound mirror: the MX record(s) a domain must publish to
 * RECEIVE mail through this deployment's MTA, derived from the domain plus the
 * deployment's mail host (the MTA's EHLO hostname, surfaced by the admin-gated
 * `domains.domains.getInboundMailConfig` query). Kept pure + framework-free —
 * like `fromEmailDomain`/`ipPool` — so the derivation is unit-tested without a
 * component harness.
 */

import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import {
	MTA_STS_TXT_HOST,
	MTA_STS_POLICY_HOST,
	buildMtaStsTxtValue,
} from '@owlat/shared/mtaStsPolicy';

/**
 * Receiving-category flags that imply the user wants to receive mail for a
 * domain through this deployment. The Receiving DNS panel renders only when one
 * of these is active, mirroring how the sending panels gate on a domain being
 * present — so a send-only install never sees inbound noise.
 *
 * `mail.external` is included per the receiving-mx-page audit item: a user who
 * has turned on any inbound surface should be pointed at MX setup.
 */
export const INBOUND_FEATURE_FLAGS = [
	'inbox',
	'inbox.codeTasks',
	'postbox',
	'mail.external',
] as const satisfies readonly FeatureFlagKey[];

/** Standard MX preference for a single inbound host (lower = higher priority). */
export const INBOUND_MX_PRIORITY = 10;

export interface InboundMxRecord {
	type: 'MX';
	/** DNS host the record is published at — `@` (the domain apex). */
	host: '@';
	/** MX preference value. */
	priority: number;
	/** The MX target — this deployment's mail host (the MTA EHLO hostname). */
	value: string;
}

/**
 * True when any inbound feature flag is enabled in the resolved flag map. The
 * Receiving DNS section always renders (so MX setup isn't a chicken-and-egg);
 * this result drives its framing — enabled shows the live firewall/PTR detail,
 * while false shows the honest "receiving isn't turned on yet — here's how"
 * state. Returns false for a missing map (still loading); the caller additionally
 * waits on the flag subscription so the "not turned on yet" copy never flashes
 * on an inbound-enabled install before the live flags arrive.
 */
export function hasInboundFeature(resolved: Record<string, boolean> | null | undefined): boolean {
	if (!resolved) return false;
	return INBOUND_FEATURE_FLAGS.some((flag) => resolved[flag] === true);
}

/**
 * The MX record(s) a domain must publish to receive mail through this
 * deployment's MTA. The host is the domain apex (`@`) and the target is the
 * deployment's mail host. Returns `[]` when the domain is blank or the
 * deployment has no mail host configured (no EHLO hostname / send-only install),
 * so the caller renders nothing rather than a bogus record.
 */
export function buildInboundMxRecords(
	domain: string,
	mailHost: string | null | undefined
): InboundMxRecord[] {
	const target = (mailHost ?? '').trim().toLowerCase().replace(/\.$/, ''); // strip a trailing FQDN root dot
	if (!domain.trim() || !target) return [];
	return [
		{
			type: 'MX',
			host: '@',
			priority: INBOUND_MX_PRIORITY,
			value: target,
		},
	];
}

export interface MtaStsDnsRecord {
	type: 'TXT' | 'CNAME';
	/** DNS host RELATIVE to the domain (e.g. `_mta-sts`, `mta-sts`). */
	host: string;
	value: string;
}

/**
 * The two DNS records a domain must publish to advertise this deployment's
 * MTA-STS policy (RFC 8461 §3.1–3.2):
 *
 *   1. `_mta-sts` TXT = `v=STSv1; id=<policyId>` — announces a policy exists and
 *      its current id, so senders re-fetch when it changes.
 *   2. `mta-sts` CNAME → this Owlat instance's web host — where senders fetch
 *      `https://mta-sts.<domain>/.well-known/mta-sts.txt`.
 *
 * Returns `[]` when there is no policy id (nothing published) or no known web
 * host, so the caller renders nothing rather than a broken record. `webHost` is
 * lowercased and stripped of any port + trailing FQDN dot.
 */
export function buildMtaStsDnsRecords(
	policyId: string | null | undefined,
	webHost: string | null | undefined
): MtaStsDnsRecord[] {
	const id = (policyId ?? '').trim();
	const target = (webHost ?? '')
		.trim()
		.toLowerCase()
		.replace(/\.$/, '') // strip a trailing FQDN root dot first…
		.replace(/:\d+$/, ''); // …so the :port suffix is now at the end to drop
	if (!id || !target) return [];
	return [
		{ type: 'TXT', host: MTA_STS_TXT_HOST, value: buildMtaStsTxtValue(id) },
		{ type: 'CNAME', host: MTA_STS_POLICY_HOST, value: target },
	];
}
