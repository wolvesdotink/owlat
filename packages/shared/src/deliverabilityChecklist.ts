/** Canonical Deliverability Center taxonomy and evidence-only reducer. */
import type { DeliverabilityChecklistDefinition } from './deliverabilityChecklistCatalog';

import { deliverabilityDiagnosticReport } from './deliverabilityDiagnostics';

export const DELIVERABILITY_CHECKLIST_STATUSES = ['pass', 'warn', 'fail', 'pending-dns'] as const;
export type DeliverabilityChecklistStatus = (typeof DELIVERABILITY_CHECKLIST_STATUSES)[number];

export const DELIVERABILITY_SEVERITIES = ['blocking', 'reputation', 'recommended'] as const;
export type DeliverabilitySeverity = (typeof DELIVERABILITY_SEVERITIES)[number];

export const DEPLOYMENT_CHECK_IDS = [
	'deployment.ptr',
	'deployment.fcrdns',
	'deployment.ptr_nongeneric',
	'deployment.ehlo_ptr',
	'deployment.port25',
	'deployment.tls',
	'deployment.dnsbl',
	'deployment.warmup',
	'deployment.relay',
	'deployment.ipv6_address',
	'deployment.ipv6_source',
	'deployment.ipv6_ptr',
	'deployment.ipv6_aaaa',
	'deployment.ipv6_spf',
	'deployment.ipv6_pool',
] as const;
export const DOMAIN_CHECK_IDS = [
	'domain.spf',
	'domain.dkim',
	'domain.dmarc',
	'domain.return_path',
	'domain.mta_sts',
	'domain.tls_rpt',
	'domain.tlsa',
	'domain.tracking',
	'domain.unsubscribe',
	'domain.postmaster',
	'domain.spam_rate',
] as const;

export type DeploymentCheckId = (typeof DEPLOYMENT_CHECK_IDS)[number];
export type DomainCheckId = (typeof DOMAIN_CHECK_IDS)[number];
export type DeliverabilityCheckId = DeploymentCheckId | DomainCheckId;

export const HOURLY_DELIVERABILITY_CHECK_IDS = [
	'deployment.ptr',
	'deployment.fcrdns',
	'deployment.ptr_nongeneric',
	'deployment.ehlo_ptr',
	'deployment.dnsbl',
	'deployment.ipv6_ptr',
	'deployment.ipv6_aaaa',
] as const satisfies readonly DeliverabilityCheckId[];

export const DELIVERABILITY_EVIDENCE_CADENCE_MS = {
	hourly: 60 * 60_000,
	daily: 24 * 60 * 60_000,
} as const;

// Scheduled work can start slightly after its nominal interval. This grace
// prevents a passing item from flickering stale while its next sweep is
// already queued, without allowing an old result to remain green indefinitely.
export const DELIVERABILITY_EVIDENCE_SWEEP_GRACE_MS = 15 * 60_000;

const HOURLY_DELIVERABILITY_CHECKS = new Set<DeliverabilityCheckId>(
	HOURLY_DELIVERABILITY_CHECK_IDS
);

export function deliverabilityEvidenceMaxAgeMs(itemId: DeliverabilityCheckId): number {
	const cadence = HOURLY_DELIVERABILITY_CHECKS.has(itemId)
		? DELIVERABILITY_EVIDENCE_CADENCE_MS.hourly
		: DELIVERABILITY_EVIDENCE_CADENCE_MS.daily;
	return cadence + DELIVERABILITY_EVIDENCE_SWEEP_GRACE_MS;
}

export function isDeliverabilityEvidenceFresh(
	itemId: DeliverabilityCheckId,
	observedAt: number,
	now: number
): boolean {
	return now - observedAt <= deliverabilityEvidenceMaxAgeMs(itemId);
}

export const DELIVERABILITY_NEXT_ACTIONS: Record<DeliverabilityCheckId, string> = {
	'deployment.ptr': 'Set the sending address PTR to the exact mail hostname Owlat shows.',
	'deployment.fcrdns': 'Publish the matching A record so the PTR hostname resolves back.',
	'deployment.ptr_nongeneric': 'Replace the provider-default PTR with a dedicated mail hostname.',
	'deployment.ehlo_ptr': 'Set the MTA EHLO hostname to the verified PTR hostname.',
	'deployment.port25': 'Request outbound TCP/25 access or configure a verified relay fallback.',
	'deployment.tls': 'Install a current TLS certificate covering the SMTP hostname.',
	'deployment.dnsbl': 'Follow the named blocklist delisting runbook before sending.',
	'deployment.warmup': 'Keep eligible campaign volume within the current warm-up cap.',
	'deployment.relay': 'Configure and verify a relay fallback route for urgent mail.',
	'deployment.ipv6_address': 'Allocate one stable, publicly routed IPv6 sending address.',
	'deployment.ipv6_source': 'Bind outbound SMTP explicitly to the verified IPv6 address.',
	'deployment.ipv6_ptr': 'Set the IPv6 PTR to the same dedicated mail hostname.',
	'deployment.ipv6_aaaa': 'Publish the exact AAAA record for the IPv6 PTR hostname.',
	'deployment.ipv6_spf': 'Add the exact sending address as an SPF ip6 mechanism.',
	'deployment.ipv6_pool': 'Enable IPv6 only after every preceding IPv6 proof passes.',
	'domain.spf': 'Publish the exact SPF TXT value shown, ending in -all.',
	'domain.dkim': 'Publish every DKIM selector exactly as shown by Owlat.',
	'domain.dmarc': 'Publish the shown DMARC policy after SPF and DKIM pass.',
	'domain.return_path': 'Publish the displayed return-path MX and SPF records.',
	'domain.mta_sts': 'Publish the MTA-STS TXT id and serve the matching HTTPS policy.',
	'domain.tls_rpt': 'Publish the displayed _smtp._tls TXT reporting address.',
	'domain.tlsa': 'Publish the displayed TLSA association in the DNSSEC-signed zone.',
	'domain.tracking': 'Publish the tracking CNAME to the exact Owlat endpoint.',
	'domain.unsubscribe': 'Send marketing mail through the production one-click signing path.',
	'domain.postmaster': 'Authorize this verified domain in Google Postmaster Tools.',
	'domain.spam_rate': 'Pause risky volume and reduce complaints below the 0.10% target.',
};
export type DeliverabilityScope =
	| { kind: 'deployment' }
	| { kind: 'domain'; domainId: string; domain: string };

export interface DeliverabilityValidatorEvidence {
	provenance: 'validator';
	validator: string;
	status: DeliverabilityChecklistStatus;
	observedAt: number;
	observedValues: readonly string[];
	diagnostic: string;
	attemptId: string;
}

export interface DeliverabilityChecklistItem extends DeliverabilityChecklistDefinition {
	scope: DeliverabilityScope;
	status: DeliverabilityChecklistStatus;
	lastCheckedAt?: number;
	observed: readonly string[];
	failureReason?: string;
	diagnosticReport: string;
}

export type DeliverabilityGrade = 'ready' | 'needs_attention' | 'at_risk';

export function materializeChecklistItem(
	definition: DeliverabilityChecklistDefinition,
	scope: DeliverabilityScope,
	evidence: DeliverabilityValidatorEvidence | null,
	now: number,
	fallbackStatus: Exclude<DeliverabilityChecklistStatus, 'pass'> = 'fail'
): DeliverabilityChecklistItem {
	const isStalePass =
		evidence?.status === 'pass' &&
		!isDeliverabilityEvidenceFresh(definition.id, evidence.observedAt, now);
	const status = isStalePass ? 'warn' : (evidence?.status ?? fallbackStatus);
	if (status === 'pass' && evidence?.provenance !== 'validator') {
		throw new Error(`Checklist pass for ${definition.id} requires validator evidence`);
	}
	const diagnostic = isStalePass
		? 'The last successful verification is older than this check’s sweep cadence. Verify again before relying on it.'
		: (evidence?.diagnostic ?? 'No validator evidence has been recorded yet.');
	return {
		...definition,
		scope,
		status,
		...(evidence ? { lastCheckedAt: evidence.observedAt } : {}),
		observed: evidence?.observedValues ?? [],
		...(status === 'fail' || status === 'warn' ? { failureReason: diagnostic } : {}),
		diagnosticReport: deliverabilityDiagnosticReport(
			definition,
			scope,
			status,
			evidence,
			diagnostic
		),
	};
}

export function deriveDeliverabilityGrade(
	items: readonly Pick<DeliverabilityChecklistItem, 'status' | 'severity'>[]
): DeliverabilityGrade {
	if (items.some((item) => item.severity === 'blocking' && item.status === 'fail')) {
		return 'at_risk';
	}
	return items.some((item) => item.severity !== 'recommended' && item.status !== 'pass')
		? 'needs_attention'
		: 'ready';
}

export function dependenciesPass(
	item: Pick<DeliverabilityChecklistItem, 'dependencies' | 'scope'>,
	items: readonly Pick<DeliverabilityChecklistItem, 'id' | 'status' | 'scope'>[]
): boolean {
	return item.dependencies.every(
		(dependency) =>
			items.find(
				(candidate) =>
					candidate.id === dependency &&
					(candidate.scope.kind === 'deployment'
						? item.scope.kind === 'deployment'
						: item.scope.kind === 'domain' && candidate.scope.domainId === item.scope.domainId)
			)?.status === 'pass'
	);
}

export function selectNextDeliverabilityItem(
	items: readonly DeliverabilityChecklistItem[]
): DeliverabilityChecklistItem | null {
	for (const severity of DELIVERABILITY_SEVERITIES) {
		const candidate = items.find(
			(item) =>
				item.severity === severity && item.status !== 'pass' && dependenciesPass(item, items)
		);
		if (candidate) return candidate;
	}
	return null;
}

export * from './deliverabilityChecklistCatalog';
