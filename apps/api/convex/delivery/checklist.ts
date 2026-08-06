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
	type DeliverabilitySetupValue,
} from '@owlat/shared';
import { adminQuery } from '../lib/authedFunctions';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { v } from 'convex/values';
import { requireOrgPermission } from '../lib/sessionOrganization';
import {
	evidenceDto,
	loopbackResult,
	providerFromEvidence,
	scopedItemKey,
	summaryFor,
} from './checklistCenterView';
import { deliverabilityCheckIdValidator, deliverabilityTargetKey } from './checklistEvidence';
import { guidanceForCheck } from './checklistGuidance';
import type { Doc, Id } from '../_generated/dataModel';
import { deploymentSetupValuesForItem, domainSetupValuesForItem } from './checklistRecords';
import { checklistTraits, DEPLOYMENT_CHECK_IDS, DOMAIN_CHECK_IDS } from './checklistTraits';
import { OWN_SENDING_DOMAIN_PROVIDER_KIND } from '../domains/providers';
import { readyFallbackRelayKinds } from '../lib/sendProviders/fallbackRelays';

export const CENTER_MATERIALIZATION_DOMAIN_LIMIT = 100;
const CENTER_MATERIALIZATION_TRACKING_LIMIT = 100;
const DEPLOYMENT_CHECK_COUNT = DEPLOYMENT_CHECK_IDS.length;
const DOMAIN_CHECK_COUNT = DOMAIN_CHECK_IDS.length;
export const CENTER_MATERIALIZATION_ACTIVE_ALERT_LIMIT =
	DEPLOYMENT_CHECK_COUNT + CENTER_MATERIALIZATION_DOMAIN_LIMIT * DOMAIN_CHECK_COUNT;

type CenterItem = Omit<DeliverabilityChecklistItem, 'scope'> & {
	scope: { kind: 'deployment' } | { kind: 'domain'; domainId: Id<'domains'>; domain: string };
	nextStep: string;
	setupValues: DeliverabilitySetupValue[];
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

async function loadRelayIdentities(ctx: QueryCtx): Promise<Doc<'sendingDomainSesIdentities'>[]> {
	const domains = await loadCenterDomains(ctx);
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
			infrastructureHealthy &&
			domain.providerType === OWN_SENDING_DOMAIN_PROVIDER_KIND &&
			deploymentReady &&
			domainReady;
		return {
			id: domain._id,
			domain: domain.domain,
			eligible,
			...(!eligible
				? {
						blockedReason:
							!infrastructureHealthy || domain.providerType !== OWN_SENDING_DOMAIN_PROVIDER_KIND
								? 'This proof requires a healthy built-in MTA domain.'
								: !deploymentReady
									? 'Verify every blocking server identity and delivery-path check first.'
									: 'Verify this domain’s blocking authentication checks first.',
					}
				: {}),
		};
	});
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
		const scopedDomains = checklistTraits(definition.id).scope === 'domain' ? domains : [null];
		for (const domain of scopedDomains) {
			const targetKey = deliverabilityTargetKey(organizationId, domain?._id);
			const evidence = latestEvidence.get(scopedItemKey(targetKey, definition.id));
			const evidenceView = evidenceDto(evidence);
			const materialized = materializeChecklistItem(
				definition,
				domain
					? { kind: 'domain', domainId: domain._id, domain: domain.domain }
					: { kind: 'deployment' },
				evidenceView,
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
				setupValues: domain
					? domainSetupValuesForItem(definition.id, domain, trackingDomains, settings)
					: deploymentSetupValuesForItem(definition.id, warming),
				instructions: guidanceForCheck(
					definition.id,
					providerFromEvidence(evidenceView?.observedValues ?? [])
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
		const dependencies = checklistTraits(args.itemId).contextDependencies;
		const needsWarming = dependencies.includes('warming');
		const needsMtaHealth = dependencies.includes('mta_health');
		const needsRelay = dependencies.includes('relay');
		const needsTracking = dependencies.includes('tracking');
		const needsPostmaster = dependencies.includes('postmaster');
		const [settings, warming, routes, relayIdentities, tracking, postmaster] = await Promise.all([
			needsMtaHealth ? ctx.db.query('instanceSettings').first() : Promise.resolve(null),
			needsWarming ? ctx.db.query('warmingState').first() : Promise.resolve(null),
			needsRelay ? ctx.db.query('providerRoutes').take(10) : Promise.resolve([]),
			needsRelay ? loadRelayIdentities(ctx) : Promise.resolve([]),
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
			// THE READINESS HALF OF `deployment.relay`, resolved here because this is
			// where a `ctx` exists — and asked of the module that owns "which relays
			// is the fallback configured to use" rather than re-derived from the
			// `routes` above, which are read under a different bound for a different
			// question. See `lib/sendProviders/fallbackRelays.ts`.
			readyRelayKinds: needsRelay ? await readyFallbackRelayKinds(ctx) : [],
		};
	},
});
