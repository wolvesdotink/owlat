import type { DeliverabilityCheckId } from '@owlat/shared';

export type ChecklistProviderGuidance =
	| 'vps_reverse_dns'
	| 'vps_port_25'
	| 'vps_ipv6'
	| 'dns'
	| null;

export type ChecklistContextDependency =
	| 'warming'
	| 'mta_health'
	| 'relay'
	| 'tracking'
	| 'postmaster';

export type ChecklistItemTraits = {
	scope: 'deployment' | 'domain';
	addressFamily: 'ipv4' | 'ipv6' | null;
	providerGuidance: ChecklistProviderGuidance;
	needsDomainDnsBundle: boolean;
	needsDnsProvider: boolean;
	contextDependencies: readonly ChecklistContextDependency[];
};

const deployment = (
	addressFamily: ChecklistItemTraits['addressFamily'],
	providerGuidance: ChecklistProviderGuidance = null,
	contextDependencies: readonly ChecklistContextDependency[] = []
): ChecklistItemTraits => ({
	scope: 'deployment',
	addressFamily,
	providerGuidance,
	needsDomainDnsBundle: false,
	needsDnsProvider: false,
	contextDependencies,
});

const domain = (
	providerGuidance: ChecklistProviderGuidance = null,
	needsDomainDnsBundle = false,
	needsDnsProvider = false,
	contextDependencies: readonly ChecklistContextDependency[] = []
): ChecklistItemTraits => ({
	scope: 'domain',
	addressFamily: null,
	providerGuidance,
	needsDomainDnsBundle,
	needsDnsProvider,
	contextDependencies,
});

/**
 * Exhaustive operational traits for the canonical checklist taxonomy.
 * Validators, guidance, and record rendering consume this registry instead of
 * maintaining independent item-id lists and switches that can drift.
 */
export const CHECKLIST_ITEM_TRAITS = {
	'deployment.ptr': deployment('ipv4', 'vps_reverse_dns', ['warming']),
	'deployment.fcrdns': deployment('ipv4', 'vps_reverse_dns', ['warming']),
	'deployment.ptr_nongeneric': deployment('ipv4', 'vps_reverse_dns', ['warming']),
	'deployment.ehlo_ptr': deployment('ipv4', null, ['warming']),
	'deployment.port25': deployment('ipv4', 'vps_port_25', ['warming', 'mta_health']),
	'deployment.tls': deployment(null, null, ['mta_health']),
	'deployment.dnsbl': deployment('ipv4', null, ['warming']),
	'deployment.warmup': deployment(null, null, ['warming']),
	'deployment.relay': deployment(null, null, ['relay']),
	'deployment.ipv6_address': deployment('ipv6', 'vps_ipv6', ['warming']),
	'deployment.ipv6_source': deployment('ipv6', null, ['warming']),
	'deployment.ipv6_ptr': deployment('ipv6', 'vps_reverse_dns', ['warming']),
	'deployment.ipv6_aaaa': deployment('ipv6', 'dns', ['warming']),
	'deployment.ipv6_spf': deployment('ipv6', 'dns', ['warming']),
	'deployment.ipv6_pool': deployment('ipv6', null, ['warming']),
	'domain.spf': domain('dns', true, true),
	'domain.dkim': domain('dns', true, true),
	'domain.dmarc': domain('dns', true, true),
	'domain.return_path': domain('dns', true, true),
	'domain.mta_sts': domain('dns', false, true),
	'domain.tls_rpt': domain('dns', true, true),
	'domain.tlsa': domain('dns', true, true),
	'domain.tracking': domain('dns', false, true, ['tracking']),
	'domain.unsubscribe': domain(),
	'domain.postmaster': domain(null, false, false, ['postmaster']),
	'domain.spam_rate': domain(null, false, false, ['postmaster']),
} as const satisfies Record<DeliverabilityCheckId, ChecklistItemTraits>;

const CHECKLIST_ITEM_IDS = Object.keys(CHECKLIST_ITEM_TRAITS) as DeliverabilityCheckId[];

export const DEPLOYMENT_CHECK_IDS = CHECKLIST_ITEM_IDS.filter(
	(itemId) => CHECKLIST_ITEM_TRAITS[itemId].scope === 'deployment'
);

export const DOMAIN_CHECK_IDS = CHECKLIST_ITEM_IDS.filter(
	(itemId) => CHECKLIST_ITEM_TRAITS[itemId].scope === 'domain'
);

export function checklistTraits(itemId: DeliverabilityCheckId): ChecklistItemTraits {
	return CHECKLIST_ITEM_TRAITS[itemId];
}
