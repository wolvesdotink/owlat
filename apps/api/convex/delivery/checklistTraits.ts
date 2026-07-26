import type { DeliverabilityCheckId } from '@owlat/shared';

export type ChecklistProviderGuidance =
	| 'vps_reverse_dns'
	| 'vps_port_25'
	| 'vps_ipv6'
	| 'dns'
	| null;

export type ChecklistItemTraits = {
	scope: 'deployment' | 'domain';
	addressFamily: 'ipv4' | 'ipv6' | null;
	providerGuidance: ChecklistProviderGuidance;
	needsDomainDnsBundle: boolean;
	needsDnsProvider: boolean;
};

const deployment = (
	addressFamily: ChecklistItemTraits['addressFamily'],
	providerGuidance: ChecklistProviderGuidance = null
): ChecklistItemTraits => ({
	scope: 'deployment',
	addressFamily,
	providerGuidance,
	needsDomainDnsBundle: false,
	needsDnsProvider: false,
});

const domain = (
	providerGuidance: ChecklistProviderGuidance = null,
	needsDomainDnsBundle = false,
	needsDnsProvider = false
): ChecklistItemTraits => ({
	scope: 'domain',
	addressFamily: null,
	providerGuidance,
	needsDomainDnsBundle,
	needsDnsProvider,
});

/**
 * Exhaustive operational traits for the canonical checklist taxonomy.
 * Validators, guidance, and record rendering consume this registry instead of
 * maintaining independent item-id lists and switches that can drift.
 */
export const CHECKLIST_ITEM_TRAITS = {
	'deployment.ptr': deployment('ipv4', 'vps_reverse_dns'),
	'deployment.fcrdns': deployment('ipv4', 'vps_reverse_dns'),
	'deployment.ptr_nongeneric': deployment('ipv4', 'vps_reverse_dns'),
	'deployment.ehlo_ptr': deployment('ipv4'),
	'deployment.port25': deployment('ipv4', 'vps_port_25'),
	'deployment.tls': deployment(null),
	'deployment.dnsbl': deployment('ipv4'),
	'deployment.warmup': deployment(null),
	'deployment.relay': deployment(null),
	'deployment.ipv6_address': deployment('ipv6', 'vps_ipv6'),
	'deployment.ipv6_source': deployment('ipv6'),
	'deployment.ipv6_ptr': deployment('ipv6', 'vps_reverse_dns'),
	'deployment.ipv6_aaaa': deployment('ipv6', 'dns'),
	'deployment.ipv6_spf': deployment('ipv6', 'dns'),
	'deployment.ipv6_pool': deployment('ipv6'),
	'domain.spf': domain('dns', true, true),
	'domain.dkim': domain('dns', true, true),
	'domain.dmarc': domain('dns', true, true),
	'domain.return_path': domain('dns', true, true),
	'domain.mta_sts': domain('dns', false, true),
	'domain.tls_rpt': domain('dns', true, true),
	'domain.tlsa': domain('dns', true, true),
	'domain.tracking': domain('dns', false, true),
	'domain.unsubscribe': domain(),
	'domain.postmaster': domain(),
	'domain.spam_rate': domain(),
} as const satisfies Record<DeliverabilityCheckId, ChecklistItemTraits>;

export function checklistTraits(itemId: DeliverabilityCheckId): ChecklistItemTraits {
	return CHECKLIST_ITEM_TRAITS[itemId];
}
