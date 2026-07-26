/**
 * Authorized Deliverability Center read model.
 *
 * This query assembles existing validator/readiness evidence; it never performs
 * network I/O and never mutates completion state. `pass` can only come from an
 * immutable `deliverabilityEvidence` row written by the validator orchestrator.
 */

import {
	DELIVERABILITY_CHECKLIST,
	DELIVERABILITY_NEXT_ACTIONS,
	deriveDeliverabilityGrade,
	dependenciesPass,
	materializeChecklistItem,
	selectNextDeliverabilityItem,
	type DeliverabilityChecklistItem,
	type DeliverabilityValidatorEvidence,
} from '@owlat/shared';
import { adminQuery } from '../lib/authedFunctions';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { v } from 'convex/values';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { deliverabilityCheckIdValidator, deliverabilityTargetKey } from './checklistEvidence';
import { guidanceForCheck, type DnsProvider, type VpsProvider } from './checklistGuidance';
import type { Doc, Id } from '../_generated/dataModel';
import {
	deploymentRecordsForItem,
	domainRecordsForItem,
	type CopyableRecord,
} from './checklistRecords';

export const CENTER_MATERIALIZATION_DOMAIN_LIMIT = 100;
const CENTER_MATERIALIZATION_TRACKING_LIMIT = 100;
const DEPLOYMENT_CHECK_COUNT = DELIVERABILITY_CHECKLIST.filter((item) =>
	item.id.startsWith('deployment.')
).length;
const DOMAIN_CHECK_COUNT = DELIVERABILITY_CHECKLIST.filter((item) =>
	item.id.startsWith('domain.')
).length;
export const CENTER_MATERIALIZATION_ACTIVE_ALERT_LIMIT =
	DEPLOYMENT_CHECK_COUNT + CENTER_MATERIALIZATION_DOMAIN_LIMIT * DOMAIN_CHECK_COUNT;

type CenterItem = Omit<DeliverabilityChecklistItem, 'scope'> & {
	scope: { kind: 'deployment' } | { kind: 'domain'; domainId: Id<'domains'>; domain: string };
	nextStep: string;
	records: CopyableRecord[];
	instructions: ReturnType<typeof guidanceForCheck>;
	verification?: { nextCheckAt?: number; attempt: number };
	lockedReason?: string;
};

export function completeRowsOrThrow<T>(rows: readonly T[], limit: number, resource: string): T[] {
	if (rows.length > limit) {
		throw new Error(
			`Deliverability Center cannot safely materialize more than ${limit} ${resource}; no partial readiness result was returned.`
		);
	}
	return [...rows];
}

async function loadCenterDomains(ctx: QueryCtx): Promise<Doc<'domains'>[]> {
	const rows = await ctx.db.query('domains').take(CENTER_MATERIALIZATION_DOMAIN_LIMIT + 1);
	return completeRowsOrThrow(rows, CENTER_MATERIALIZATION_DOMAIN_LIMIT, 'sending domains');
}

async function loadTrackingDomains(ctx: QueryCtx): Promise<Doc<'trackingDomains'>[]> {
	const rows = await ctx.db
		.query('trackingDomains')
		.take(CENTER_MATERIALIZATION_TRACKING_LIMIT + 1);
	return completeRowsOrThrow(rows, CENTER_MATERIALIZATION_TRACKING_LIMIT, 'tracking domains');
}

async function loadVerificationStatesForTarget(
	ctx: QueryCtx,
	organizationId: string,
	targetKey: string,
	itemLimit: number
): Promise<Doc<'deliverabilityVerificationState'>[]> {
	const rows = await ctx.db
		.query('deliverabilityVerificationState')
		.withIndex('by_org_target_item', (q) =>
			q.eq('organizationId', organizationId).eq('targetKey', targetKey)
		)
		.take(itemLimit + 1);
	return completeRowsOrThrow(rows, itemLimit, `verification states for ${targetKey}`);
}

async function loadRelayIdentities(
	ctx: QueryCtx,
	domain: Doc<'domains'> | null
): Promise<Doc<'sendingDomainSesIdentities'>[]> {
	const domains = domain ? [domain] : await loadCenterDomains(ctx);
	const identities = await Promise.all(
		domains.map(async (candidate) => {
			const rows = await ctx.db
				.query('sendingDomainSesIdentities')
				.withIndex('by_domain', (q) => q.eq('domainId', candidate._id))
				.take(2);
			return completeRowsOrThrow(rows, 1, `SES relay identities for ${candidate.domain}`)[0];
		})
	);
	return identities.filter(
		(identity): identity is Doc<'sendingDomainSesIdentities'> => identity !== undefined
	);
}

export function loopbackDomains(
	items: readonly Pick<CenterItem, 'scope' | 'severity' | 'status'>[],
	domains: readonly Pick<Doc<'domains'>, '_id' | 'domain' | 'providerType'>[],
	infrastructureHealthy: boolean
) {
	const deploymentReady = items
		.filter((item) => item.scope.kind === 'deployment' && item.severity === 'blocking')
		.every((item) => item.status === 'pass');
	return domains.map((domain) => {
		const domainReady = items
			.filter(
				(item) =>
					item.scope.kind === 'domain' &&
					item.scope.domainId === domain._id &&
					item.severity === 'blocking'
			)
			.every((item) => item.status === 'pass');
		const eligible =
			infrastructureHealthy && domain.providerType === 'mta' && deploymentReady && domainReady;
		return {
			id: domain._id,
			domain: domain.domain,
			eligible,
			...(!eligible
				? {
						blockedReason:
							!infrastructureHealthy || domain.providerType !== 'mta'
								? 'This proof requires a healthy built-in MTA domain.'
								: !deploymentReady
									? 'Verify every blocking server identity and delivery-path check first.'
									: 'Verify this domain’s blocking authentication checks first.',
					}
				: {}),
		};
	});
}

function loopbackResult(row: Doc<'deliverabilityLoopbackAttempts'>) {
	return {
		status: row.status,
		startedAt: row.startedAt,
		...(row.completedAt ? { completedAt: row.completedAt } : {}),
		domain: row.domain,
		...(row.spf ? { spf: row.spf } : {}),
		...(row.dkim ? { dkim: row.dkim } : {}),
		...(row.dmarc ? { dmarc: row.dmarc } : {}),
		...(row.dkimSelector ? { dkimSelector: row.dkimSelector } : {}),
		...(row.tlsVersion ? { tlsVersion: row.tlsVersion } : {}),
		...(row.sendingIp ? { sendingIp: row.sendingIp } : {}),
		...(row.ptr ? { ptr: row.ptr } : {}),
		...(row.detail ? { detail: row.detail } : {}),
	};
}

function providerFromEvidence(values: readonly string[]): {
	vps: VpsProvider | null;
	dns: DnsProvider | null;
} {
	let vps: VpsProvider | null = null;
	let dns: DnsProvider | null = null;
	for (const value of values) {
		if (
			value === 'vps-provider=hetzner' ||
			value === 'vps-provider=digitalocean' ||
			value === 'vps-provider=ovh'
		) {
			vps = value.slice('vps-provider='.length) as VpsProvider;
		}
		if (
			value === 'dns-provider=cloudflare' ||
			value === 'dns-provider=hetzner_dns' ||
			value === 'dns-provider=route53'
		) {
			dns = value.slice('dns-provider='.length) as DnsProvider;
		}
	}
	return { vps, dns };
}

function evidenceDto(
	row: Doc<'deliverabilityEvidence'> | undefined
): DeliverabilityValidatorEvidence | null {
	if (!row) return null;
	return {
		provenance: 'validator',
		validator: row.validator,
		status: row.status,
		observedAt: row.observedAt,
		observedValues: row.observedValues,
		diagnostic: row.diagnostic,
		attemptId: row.attemptId,
	};
}

function scopedItemKey(targetKey: string, itemId: string): string {
	return `${targetKey.length}:${targetKey}|${itemId}`;
}

function summaryFor(grade: 'ready' | 'needs_attention' | 'at_risk', recommended: number): string {
	if (grade === 'ready') {
		return recommended === 0
			? 'Your mail setup is verified and ready.'
			: `Your mail is deliverable. ${recommended} recommended improvement${
					recommended === 1 ? '' : 's'
				} available.`;
	}
	if (grade === 'at_risk') {
		return 'Your mail is at risk. Fix the blocking item below before sending.';
	}
	return 'Your mail needs attention. Follow the next verified setup step below.';
}

async function buildCenter(ctx: QueryCtx) {
	const session = await requireOrgPermission(ctx, 'organization:manage');
	const organizationId = session.activeOrganizationId;
	const domains = await loadCenterDomains(ctx);
	const targetKeys = [
		{ key: deliverabilityTargetKey(organizationId), itemLimit: DEPLOYMENT_CHECK_COUNT },
		...domains.map((domain) => ({
			key: deliverabilityTargetKey(organizationId, domain._id),
			itemLimit: DOMAIN_CHECK_COUNT,
		})),
	];
	const [statePages, trackingDomains, settings, warming, routes, activeAlertRows] =
		await Promise.all([
			Promise.all(
				targetKeys.map((target) =>
					loadVerificationStatesForTarget(ctx, organizationId, target.key, target.itemLimit)
				)
			),
			loadTrackingDomains(ctx),
			ctx.db.query('instanceSettings').first(), // bounded: singleton row
			ctx.db.query('warmingState').first(), // bounded: singleton row
			ctx.db.query('providerRoutes').take(10), // bounded: three message-type rows
			ctx.db
				.query('deliverabilityRegressionAlerts')
				.withIndex('by_org_resolved_observed', (q) =>
					q.eq('organizationId', organizationId).eq('resolvedAt', undefined)
				)
				.order('desc')
				.take(CENTER_MATERIALIZATION_ACTIVE_ALERT_LIMIT + 1),
		]);
	const activeAlerts = completeRowsOrThrow(
		activeAlertRows,
		CENTER_MATERIALIZATION_ACTIVE_ALERT_LIMIT,
		'active regression alerts'
	);
	const verificationStates = statePages.flat();

	const evidenceRows = await Promise.all(
		verificationStates.map((state) =>
			state.currentEvidenceId ? ctx.db.get(state.currentEvidenceId) : Promise.resolve(null)
		)
	);
	const latestEvidence = new Map<string, Doc<'deliverabilityEvidence'>>();
	for (const row of evidenceRows) {
		if (!row || row.organizationId !== organizationId) continue;
		const key = scopedItemKey(row.targetKey, row.itemId);
		latestEvidence.set(key, row);
	}
	const stateByItem = new Map(
		verificationStates.map((row) => [scopedItemKey(row.targetKey, row.itemId), row] as const)
	);

	const now = Date.now();
	const items: CenterItem[] = [];
	for (const definition of DELIVERABILITY_CHECKLIST) {
		const scopedDomains = definition.id.startsWith('domain.') ? domains : [null];
		for (const domain of scopedDomains) {
			const targetKey = deliverabilityTargetKey(organizationId, domain?._id);
			const evidence = latestEvidence.get(scopedItemKey(targetKey, definition.id));
			const materialized = materializeChecklistItem(
				definition,
				domain
					? { kind: 'domain', domainId: domain._id, domain: domain.domain }
					: { kind: 'deployment' },
				evidenceDto(evidence),
				now,
				definition.severity === 'blocking' ? 'fail' : 'warn'
			);
			const verification = stateByItem.get(scopedItemKey(targetKey, definition.id));
			items.push({
				...materialized,
				scope: domain
					? { kind: 'domain', domainId: domain._id, domain: domain.domain }
					: { kind: 'deployment' },
				nextStep:
					materialized.status === 'pending-dns'
						? 'Owlat will check again automatically; you can also verify now.'
						: DELIVERABILITY_NEXT_ACTIONS[definition.id],
				records: domain
					? domainRecordsForItem(definition.id, domain, trackingDomains, settings)
					: deploymentRecordsForItem(definition.id, warming),
				instructions: guidanceForCheck(
					definition.id,
					providerFromEvidence(evidence?.observedValues ?? [])
				),
				...(verification
					? {
							verification: {
								...(verification.nextCheckAt ? { nextCheckAt: verification.nextCheckAt } : {}),
								attempt: verification.retryIndex + 1,
							},
						}
					: {}),
			});
		}
	}

	const grade = deriveDeliverabilityGrade(items);
	for (const item of items) {
		if (item.status === 'pass' || dependenciesPass(item, items)) continue;
		const unmet = item.dependencies.filter(
			(dependency) =>
				!items.some(
					(candidate) =>
						candidate.id === dependency &&
						candidate.status === 'pass' &&
						(candidate.scope.kind === 'deployment'
							? item.scope.kind === 'deployment'
							: item.scope.kind === 'domain' && candidate.scope.domainId === item.scope.domainId)
				)
		);
		item.lockedReason = `Verify ${unmet.join(', ')} first.`;
	}
	const selectedNextItem = selectNextDeliverabilityItem(items);
	const nextItem = selectedNextItem
		? (items.find(
				(item) =>
					item.id === selectedNextItem.id &&
					(item.scope.kind === 'deployment'
						? selectedNextItem.scope.kind === 'deployment'
						: selectedNextItem.scope.kind === 'domain' &&
							item.scope.domainId === selectedNextItem.scope.domainId)
			) ?? null)
		: null;
	const groups = [
		{
			key: 'blocking' as const,
			label: 'Blocking delivery',
			description: 'These checks can stop or reject mail.',
			items: items.filter((item) => item.severity === 'blocking'),
		},
		{
			key: 'reputation' as const,
			label: 'Hurting reputation',
			description: 'These checks affect how receivers treat future mail.',
			items: items.filter((item) => item.severity === 'reputation'),
		},
		{
			key: 'recommended' as const,
			label: 'Recommended',
			description: 'Useful hardening after the blocking path is verified.',
			items: items.filter((item) => item.severity === 'recommended'),
		},
	];
	const latestLoopbacks = await Promise.all(
		domains.map((domain) =>
			ctx.db
				.query('deliverabilityLoopbackAttempts')
				.withIndex('by_org_domain_started', (q) =>
					q.eq('organizationId', organizationId).eq('domainId', domain._id)
				)
				.order('desc')
				.first()
		)
	);
	const loopbackInfrastructureReady = settings?.mtaHealth !== undefined;
	const recommended = items.filter(
		(item) => item.severity === 'recommended' && item.status !== 'pass'
	).length;

	return {
		grade,
		summary: summaryFor(grade, recommended),
		checkedAt:
			evidenceRows.reduce((latest, evidence) => Math.max(latest, evidence?.observedAt ?? 0), 0) ||
			null,
		statusRefreshedAt: now,
		alerts: activeAlerts.map((alert) => ({
			id: alert._id,
			itemId: alert.itemId,
			...(alert.domainId
				? {
						domainId: alert.domainId,
						domain:
							domains.find((domain) => domain._id === alert.domainId)?.domain ??
							'Deleted sending domain',
					}
				: {}),
			message: alert.message,
			observedAt: alert.observedAt,
			acknowledgedAt: alert.acknowledgedAt ?? null,
			emailNotificationState: alert.emailNotificationState,
		})),
		nextItem,
		groups,
		loopback: {
			domains: loopbackDomains(items, domains, loopbackInfrastructureReady).map(
				(option, index) => ({
					...option,
					...(latestLoopbacks[index] ? { latest: loopbackResult(latestLoopbacks[index]) } : {}),
				})
			),
		},
		state: {
			deployment: {
				mtaHealth: settings?.mtaHealth ?? null,
				warming: warming ?? null,
				isRelayFallbackConfigured: routes.some(
					(route) => route.deliverabilityFallback?.isEnabled === true
				),
			},
			domains: domains.map((domain) => ({
				id: domain._id,
				domain: domain.domain,
				status: domain.status,
				lastVerifiedAt: domain.lastVerifiedAt ?? null,
			})),
		},
	};
}

export const getCenter = adminQuery({
	args: {},
	handler: buildCenter,
});

/** Inherited-identity admin scope for Node actions. */
export const getAdminScope = internalQuery({
	args: {},
	handler: async (ctx) => {
		const session = await requireOrgPermission(ctx, 'organization:manage');
		return { organizationId: session.activeOrganizationId };
	},
});

/** Bounded state projection consumed by validator actions. */
export const getVerificationContext = internalQuery({
	args: {
		organizationId: v.string(),
		domainId: v.optional(v.id('domains')),
		itemId: deliverabilityCheckIdValidator,
	},
	handler: async (ctx, args) => {
		const domain = args.domainId ? await ctx.db.get(args.domainId) : null;
		const isDeploymentCheck = args.itemId.startsWith('deployment.');
		const needsRelay = args.itemId === 'deployment.relay';
		const needsTracking = args.itemId === 'domain.tracking';
		const needsPostmaster =
			args.itemId === 'domain.postmaster' || args.itemId === 'domain.spam_rate';
		const [settings, warming, routes, relayIdentities, tracking, postmaster] = await Promise.all([
			isDeploymentCheck ? ctx.db.query('instanceSettings').first() : Promise.resolve(null),
			isDeploymentCheck ? ctx.db.query('warmingState').first() : Promise.resolve(null),
			needsRelay ? ctx.db.query('providerRoutes').take(10) : Promise.resolve([]),
			needsRelay ? loadRelayIdentities(ctx, null) : Promise.resolve([]),
			needsTracking ? loadTrackingDomains(ctx) : Promise.resolve([]),
			domain && needsPostmaster
				? ctx.db
						.query('googlePostmasterStats')
						.withIndex('by_domain_period', (q) => q.eq('domain', domain.domain))
						.order('desc')
						.first()
				: Promise.resolve(null),
		]);
		return {
			domain,
			settings,
			warming,
			routes,
			relayIdentities,
			tracking,
			postmaster,
		};
	},
});
