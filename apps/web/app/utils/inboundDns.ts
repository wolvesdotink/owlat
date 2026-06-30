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
 * True when any inbound feature flag is enabled in the resolved flag map. Drives
 * whether the Receiving DNS section is shown at all. Returns false for a
 * missing map (still loading) so the section never flashes before flags arrive.
 */
export function hasInboundFeature(
	resolved: Record<string, boolean> | null | undefined,
): boolean {
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
	mailHost: string | null | undefined,
): InboundMxRecord[] {
	const target = (mailHost ?? '')
		.trim()
		.toLowerCase()
		.replace(/\.$/, ''); // strip a trailing FQDN root dot
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
