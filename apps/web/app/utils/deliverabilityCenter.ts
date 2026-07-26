import type { Id } from '@owlat/api/dataModel';
import type {
	DeliverabilityChecklistItem as CanonicalChecklistItem,
	DeliverabilityChecklistStatus,
	DeliverabilityGrade as CanonicalDeliverabilityGrade,
	DeliverabilitySeverity as CanonicalDeliverabilitySeverity,
	DeliverabilitySetupValue as CanonicalDeliverabilitySetupValue,
} from '@owlat/shared';

export type DeliverabilityGrade = CanonicalDeliverabilityGrade;
export type DeliverabilityItemStatus = DeliverabilityChecklistStatus;
export type DeliverabilitySeverity = CanonicalDeliverabilitySeverity;

export type DeliverabilitySetupValue = CanonicalDeliverabilitySetupValue;

export interface DeliverabilityInstructions {
	provider?: string;
	providerLabel?: string;
	summary?: string;
	steps: readonly string[];
	consoleHref?: string;
}

export type DeliverabilityScope =
	| { kind: 'deployment' }
	| { kind: 'domain'; domainId: Id<'domains'>; domain: string };

export interface DeliverabilityChecklistItem extends Omit<CanonicalChecklistItem, 'scope'> {
	scope: DeliverabilityScope;
	nextStep?: string;
	instructions?: DeliverabilityInstructions;
	setupValues?: DeliverabilitySetupValue[];
	verification?: {
		nextCheckAt?: number;
		attempt?: number;
	};
	lockedReason?: string;
}

export interface DeliverabilityChecklistGroup {
	key: DeliverabilitySeverity;
	label: string;
	description: string;
	items: DeliverabilityChecklistItem[];
}

export interface DeliverabilityRegressionAlert {
	id: Id<'deliverabilityRegressionAlerts'>;
	itemId: string;
	domainId?: Id<'domains'>;
	domain?: string;
	message: string;
	observedAt: number;
	acknowledgedAt: number | null;
	emailNotificationState: 'pending' | 'sent' | 'unavailable';
}

export interface DeliverabilityAlertOperation {
	alertId: Id<'deliverabilityRegressionAlerts'>;
	kind: 'acknowledge' | 'resolve';
}

export type LoopbackMechanismStatus = 'pass' | 'fail' | 'unknown';

export interface DeliverabilityLoopbackResult {
	status: 'sending' | 'awaiting_inbound' | 'passed' | 'failed' | 'timed_out';
	startedAt: number;
	completedAt?: number;
	domain: string;
	spf?: LoopbackMechanismStatus;
	dkim?: LoopbackMechanismStatus;
	dkimSelector?: string;
	dmarc?: LoopbackMechanismStatus;
	tlsVersion?: string;
	sendingIp?: string;
	ptr?: string;
	detail?: string;
}

export interface DeliverabilityCenter {
	grade: DeliverabilityGrade;
	summary: string;
	/** Latest validator evidence time. Null means no live check has completed. */
	checkedAt: number | null;
	/** Read-model refresh time; never present this as a verification time. */
	statusRefreshedAt: number;
	alerts: DeliverabilityRegressionAlert[];
	nextItem: DeliverabilityChecklistItem | null;
	groups: DeliverabilityChecklistGroup[];
	loopback: {
		domains: Array<{
			id: Id<'domains'>;
			domain: string;
			eligible: boolean;
			blockedReason?: string;
			latest?: DeliverabilityLoopbackResult;
		}>;
	};
}

export interface DeliverabilityCounts {
	passing: number;
	attention: number;
	pending: number;
	total: number;
}

export const DELIVERABILITY_GRADE_PRESENTATION = {
	ready: {
		label: 'Ready',
		icon: 'lucide:badge-check',
		className: 'border-success/30 bg-success/10 text-success',
	},
	needs_attention: {
		label: 'Needs attention',
		icon: 'lucide:circle-alert',
		className: 'border-warning/30 bg-warning/10 text-warning',
	},
	at_risk: {
		label: 'At risk',
		icon: 'lucide:shield-alert',
		className: 'border-error/30 bg-error/10 text-error',
	},
} as const satisfies Record<
	DeliverabilityGrade,
	{ label: string; icon: string; className: string }
>;

export const DELIVERABILITY_STATUS_PRESENTATION = {
	pass: {
		label: 'Verified',
		icon: 'lucide:check-circle-2',
		className: 'border-success/30 bg-success/10 text-success',
	},
	warn: {
		label: 'Needs attention',
		icon: 'lucide:circle-alert',
		className: 'border-warning/30 bg-warning/10 text-warning',
	},
	fail: {
		label: 'Not working',
		icon: 'lucide:x-circle',
		className: 'border-error/30 bg-error/10 text-error',
	},
	'pending-dns': {
		label: 'Checking…',
		icon: 'lucide:loader-2',
		className: 'border-brand/30 bg-brand/10 text-brand',
	},
} as const satisfies Record<
	DeliverabilityItemStatus,
	{ label: string; icon: string; className: string }
>;

export function countDeliverabilityItems(
	groups: readonly DeliverabilityChecklistGroup[]
): DeliverabilityCounts {
	const items = groups.flatMap((group) => group.items);
	return items.reduce<DeliverabilityCounts>(
		(counts, item) => {
			counts.total += 1;
			if (item.status === 'pass') counts.passing += 1;
			else if (item.status === 'pending-dns') counts.pending += 1;
			else counts.attention += 1;
			return counts;
		},
		{ passing: 0, attention: 0, pending: 0, total: 0 }
	);
}

/** Stable UI identity for a checklist item; ids repeat once per sending domain. */
export function itemKey(scope: DeliverabilityScope, id: DeliverabilityChecklistItem['id']): string {
	return scope.kind === 'deployment' ? `deployment:${id}` : `domain:${scope.domainId}:${id}`;
}

export function domainChoices(
	groups: readonly DeliverabilityChecklistGroup[]
): Array<{ id: Id<'domains'>; domain: string }> {
	const choices = new Map<Id<'domains'>, string>();
	for (const item of groups.flatMap((group) => group.items)) {
		if (item.scope.kind === 'domain') choices.set(item.scope.domainId, item.scope.domain);
	}
	return [...choices].map(([id, domain]) => ({ id, domain }));
}

export function findDeliverabilityItem(
	groups: readonly DeliverabilityChecklistGroup[],
	alert: Pick<DeliverabilityRegressionAlert, 'itemId' | 'domainId'>
): DeliverabilityChecklistItem | undefined {
	return groups
		.flatMap((group) => group.items)
		.find(
			(item) =>
				item.id === alert.itemId &&
				(alert.domainId
					? item.scope.kind === 'domain' && item.scope.domainId === alert.domainId
					: item.scope.kind === 'deployment')
		);
}

export function checklistItemDomId(item: DeliverabilityChecklistItem): string {
	return `deliverability-check:${itemKey(item.scope, item.id)}`;
}

export function formatVerificationAge(timestamp: number, now = Date.now()): string {
	const elapsedMs = Math.max(0, now - timestamp);
	const minutes = Math.floor(elapsedMs / 60_000);
	if (minutes < 1) return 'checked just now';
	if (minutes < 60) return `checked ${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `checked ${hours} h ago`;
	const days = Math.floor(hours / 24);
	return `checked ${days} d ago`;
}

export function formatRecheckCountdown(nextCheckAt: number, now = Date.now()): string {
	const remainingSeconds = Math.max(0, Math.ceil((nextCheckAt - now) / 1_000));
	const minutes = Math.floor(remainingSeconds / 60);
	const seconds = remainingSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function buildDeliverabilityReport(center: DeliverabilityCenter): string {
	const lines = [
		'Owlat deliverability report',
		`Generated: ${new Date().toISOString()}`,
		`Overall: ${DELIVERABILITY_GRADE_PRESENTATION[center.grade].label}`,
		`Summary: ${center.summary}`,
		`Latest validator evidence: ${
			center.checkedAt ? new Date(center.checkedAt).toISOString() : 'No validator evidence yet'
		}`,
		`Status view refreshed: ${new Date(center.statusRefreshedAt).toISOString()}`,
		'',
	];

	if (center.alerts.length > 0) {
		lines.push('Active regressions');
		for (const alert of center.alerts) {
			lines.push(`- ${alert.itemId}${alert.domain ? ` (${alert.domain})` : ''}: ${alert.message}`);
			lines.push(`  Detected: ${new Date(alert.observedAt).toISOString()}`);
		}
		lines.push('');
	}

	for (const group of center.groups) {
		lines.push(group.label);
		for (const item of group.items) {
			const scope = item.scope.kind === 'domain' ? item.scope.domain : 'Deployment';
			lines.push(
				`- [${DELIVERABILITY_STATUS_PRESENTATION[item.status].label}] ${item.title} (${item.protocol}; ${scope})`
			);
			if (item.observed.length > 0) lines.push(`  Observed: ${item.observed.join(' · ')}`);
			if (item.failureReason) lines.push(`  Reason: ${item.failureReason}`);
			if (item.lastCheckedAt) {
				lines.push(`  Checked: ${new Date(item.lastCheckedAt).toISOString()}`);
			}
		}
		lines.push('');
	}

	const loopback = center.loopback.domains
		.flatMap((domain) => (domain.latest ? [domain.latest] : []))
		.sort((left, right) => right.startedAt - left.startedAt)[0];
	if (loopback) {
		lines.push('Loopback proof');
		lines.push(`- Status: ${loopback.status}`);
		lines.push(`- Domain: ${loopback.domain}`);
		if (loopback.spf) lines.push(`- SPF: ${loopback.spf}`);
		if (loopback.dkim) {
			lines.push(
				`- DKIM: ${loopback.dkim}${loopback.dkimSelector ? ` (${loopback.dkimSelector})` : ''}`
			);
		}
		if (loopback.dmarc) lines.push(`- DMARC: ${loopback.dmarc}`);
		if (loopback.tlsVersion) lines.push(`- TLS: ${loopback.tlsVersion}`);
		if (loopback.sendingIp) lines.push(`- Sending IP: ${loopback.sendingIp}`);
		if (loopback.ptr) lines.push(`- Observed PTR: ${loopback.ptr}`);
	}

	return lines.join('\n').trim();
}
