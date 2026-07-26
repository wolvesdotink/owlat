import { DELIVERABILITY_NEXT_ACTIONS, type DeliverabilityCheckId } from '@owlat/shared';
import {
	DELIVERABILITY_DNS_GUIDANCE,
	DELIVERABILITY_VPS_IPV6_GUIDANCE,
	DELIVERABILITY_VPS_PORT25_GUIDANCE,
	DELIVERABILITY_VPS_GUIDANCE,
	type DeliverabilityDnsProvider,
	type DeliverabilityProviderGuidance,
	type DeliverabilityVpsProvider,
} from '@owlat/shared/deliverabilityProviderGuidance';
import { checklistTraits } from './checklistTraits';

export type VpsProvider = DeliverabilityVpsProvider;
export type DnsProvider = DeliverabilityDnsProvider;

export interface ProviderGuidance extends Omit<
	DeliverabilityProviderGuidance,
	'provider' | 'consoleHref'
> {
	provider: VpsProvider | DnsProvider | 'generic';
	consoleHref?: string;
}

/** Provider classification uses authoritative RDAP organization text, never PTR guesses. */
export function detectVpsProvider(rdapOrganization: string | null): VpsProvider | null {
	if (!rdapOrganization) return null;
	const normalized = rdapOrganization.toLowerCase();
	if (normalized.includes('hetzner')) return 'hetzner';
	if (normalized.includes('digitalocean')) return 'digitalocean';
	if (normalized.includes('ovh')) return 'ovh';
	return null;
}

/** Nameserver suffixes are authoritative for the DNS host and bounded to three documented hosts. */
export function detectDnsProvider(nameservers: readonly string[]): DnsProvider | null {
	const normalized = nameservers.map((name) => name.toLowerCase().replace(/\.$/, ''));
	if (normalized.some((name) => name.endsWith('.cloudflare.com'))) return 'cloudflare';
	if (normalized.some((name) => name.endsWith('.hetzner.com'))) return 'hetzner_dns';
	if (normalized.some((name) => name.endsWith('.awsdns-') || name.includes('.awsdns-'))) {
		return 'route53';
	}
	return null;
}

export function guidanceForCheck(
	itemId: DeliverabilityCheckId,
	detected: { vps: VpsProvider | null; dns: DnsProvider | null }
): ProviderGuidance {
	const guidance = checklistTraits(itemId).providerGuidance;
	if (
		(guidance === 'vps_reverse_dns' || guidance === 'vps_port_25' || guidance === 'vps_ipv6') &&
		detected.vps
	) {
		if (guidance === 'vps_port_25') {
			return DELIVERABILITY_VPS_PORT25_GUIDANCE[detected.vps];
		}
		if (guidance === 'vps_ipv6') {
			return DELIVERABILITY_VPS_IPV6_GUIDANCE[detected.vps];
		}
		return DELIVERABILITY_VPS_GUIDANCE[detected.vps];
	}
	if (guidance === 'dns' && detected.dns) {
		return DELIVERABILITY_DNS_GUIDANCE[detected.dns];
	}
	return {
		provider: 'generic',
		providerLabel: 'Your provider',
		summary:
			guidance !== null
				? 'Owlat could not identify the provider from authoritative data.'
				: DELIVERABILITY_NEXT_ACTIONS[itemId],
		steps: [
			DELIVERABILITY_NEXT_ACTIONS[itemId],
			'Return here and choose Verify now.',
			'Owlat will mark the check complete only after its validator confirms the result.',
		],
	};
}
