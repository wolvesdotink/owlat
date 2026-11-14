/**
 * Delivery health roll-up — the single "is sending healthy right now?" signal
 * that drives the sidebar's **Delivery** status dot.
 *
 * It composes the existing read surfaces into one cheap query so the nav can
 * subscribe once (no N+1):
 *  - org sending reputation risk (`summarize` → `riskLevel`)
 *  - sending-domain verification states (`domains` table); going live needs
 *    at least one verified domain, matching the Delivery page's readiness panel
 *  - whether a delivery provider is actually configured (`isDeliveryConfigured`),
 *    overall and for each enabled message type
 *  - the built-in MTA's posture, its sending IPs and a halted warm-up, when the
 *    MTA carries mail
 *  - the transactional default sender, which every transactional send uses
 *
 * The Delivery hub's readiness panel judges the same facts per message type
 * (`apps/web/app/utils/deliveryReadiness.ts`). Every condition that blocks a
 * stream there is an `error` here, so the header chip above the panel never
 * reads healthy while the panel says a stream is blocked. The panel's
 * attention-only gates (authentication records, DMARC, today's capacity) stay
 * out of this roll-up, which the sidebar subscribes to on every page.
 *
 * The worst-of logic lives in the pure `rollUpDeliveryHealth` so it is unit
 * testable without a DB. Levels map to the shared success/warning/error tokens
 * on the client; the `reasonCode` names the worst offender for the dot's
 * tooltip, and the client words it (`healthCopy.ts`).
 */

import { authedQuery } from '../lib/authedFunctions';
import { summarize } from '../analytics/sendingReputation';
import { isDeliveryConfigured, messageTypeTransportKinds } from '../lib/sendProviders/capability';
import { missingFeedbackVariablesFor } from '../lib/sendProviders/feedbackReadiness';
import { getOptional } from '../lib/env';
import { OWN_ARM_TRANSPORT_KIND } from '../lib/sendProviders/strategies/adaptive_mix';
import { MTA_HEALTH_MAX_AGE_MS } from './mtaHealthFreshness';
import { readInstanceCounter } from '../lib/instanceCounters';
import { resolveStoredFeatureFlags } from '../lib/featureFlags';
import { loadTransactionalSender } from '../transactional/senderResolution';
import { sendingIpPosture, type SendingIpPosture } from '@owlat/shared/ipReadiness';
import type { FeatureFlagState } from '@owlat/shared/featureFlags';
import type { Infer } from 'convex/values';
import type { QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import type { mtaHealthSnapshotValidator } from '../schema/instance';
import type { DeliveryHealthReason, DeliveryHealthReasonParams } from './healthCopy';

/** Traffic-light level for the Delivery status dot. */
export type DeliveryHealthLevel = 'ok' | 'warn' | 'error';

/** Reputation risk buckets produced by `calculateRiskLevel`. */
type ReputationRisk = 'low' | 'medium' | 'high' | 'critical';

/** Sending-domain verification states (`domains.status`). */
export type DomainStatus = 'registering' | 'pending' | 'verified' | 'failed';

export interface DeliveryHealthInputs {
	/** Rolling org reputation risk, or `null` when there's no in-window activity. */
	reputationRisk: ReputationRisk | null;
	/** Verification status of every configured sending domain. */
	domainStatuses: DomainStatus[];
	/** Whether the send path can actually dispatch (provider configured). */
	canSend: boolean;
	/** Live infrastructure posture when the built-in MTA is in the active route. */
	mtaInfrastructure: MtaInfrastructureState | null;
	/**
	 * Enabled message types whose own route resolves to no usable transport,
	 * although the instance as a whole can send. Optional: absent means none.
	 */
	streamsWithoutTransport?: readonly ('transactional' | 'campaign')[];
	/**
	 * The worst sending-IP posture over the pools the built-in MTA carries, or
	 * `null` when the MTA is not on any route or has synced no address yet.
	 */
	sendingIps?: SendingIpPosture | null;
	/** True when the MTA reports the campaign warm-up halted (`plateau`). */
	isWarmupHalted?: boolean;
	/**
	 * Enabled message types whose transport sends but cannot receive bounce
	 * and complaint reports (its webhook key is unset). Optional: absent means
	 * none.
	 */
	streamsWithoutFeedback?: readonly ('transactional' | 'campaign')[];
	/**
	 * The transactional default sender: `missing` when none is configured,
	 * `unverified` when its domain is not verified, `null` when it is fine or
	 * transactional sending is switched off.
	 */
	transactionalSender?: 'missing' | 'unverified' | null;
	/** The sending domains the MTA holds mail for, when `mtaInfrastructure` is `signing_held`. */
	heldSigningDomains?: readonly string[];
}

/** How the built-in MTA's last health snapshot reads right now. */
export type MtaInfrastructureState =
	| 'healthy'
	| 'degraded'
	| 'signing_held'
	| 'unreachable'
	| 'stale'
	| 'unchecked';

type MtaHealthSnapshot = Infer<typeof mtaHealthSnapshotValidator>;

/**
 * Classify the stored MTA health snapshot. A missing snapshot has not been
 * checked yet, and one older than `MTA_HEALTH_MAX_AGE_MS` means the sync
 * stopped, so neither is read as healthy.
 */
export function mtaInfrastructureState(
	snapshot: MtaHealthSnapshot | undefined | null,
	now: number
): MtaInfrastructureState {
	if (!snapshot) return 'unchecked';
	if (now - snapshot.observedAt > MTA_HEALTH_MAX_AGE_MS) return 'stale';
	// Before `degraded`, which the MTA also reports for it: the fix is a key or a
	// DNS record, not the host.
	if (snapshot.dkimSigningHeld?.length) return 'signing_held';
	if (snapshot.status === 'ok') return 'healthy';
	return snapshot.status;
}

interface DeliveryHealthRollup {
	level: DeliveryHealthLevel;
	/**
	 * The worst offender as a catalog reason (`healthCopy.ts`), worded by the
	 * client in the reader's language. Nothing outside the web app reads the
	 * roll-up, so it carries no English sentence of its own.
	 */
	reasonCode: DeliveryHealthReason;
	/** The values the reason's sentence interpolates, when it has any. */
	reasonParams?: DeliveryHealthReasonParams;
}

const SEVERITY: Record<DeliveryHealthLevel, number> = { ok: 0, warn: 1, error: 2 };

const HEALTHY: DeliveryHealthRollup = { level: 'ok', reasonCode: 'healthy' };

function verdict(
	level: DeliveryHealthLevel,
	reasonCode: DeliveryHealthReason
): DeliveryHealthRollup {
	return { level, reasonCode };
}

/** Provider dimension: no usable provider is a hard, send-blocking failure. */
function providerHealth(
	canSend: boolean,
	streamsWithoutTransport: readonly ('transactional' | 'campaign')[]
): DeliveryHealthRollup {
	if (!canSend) return verdict('error', 'no_provider');
	if (streamsWithoutTransport.includes('transactional')) {
		return verdict('error', 'no_provider_transactional');
	}
	if (streamsWithoutTransport.includes('campaign')) {
		return verdict('error', 'no_provider_campaign');
	}
	return HEALTHY;
}

/**
 * Feedback dimension: campaigns are refused while their bounce and complaint
 * reports cannot come back, so that blocks; transactional mail still goes out
 * and only warns, as the readiness panel's transport gate grades it.
 */
function feedbackHealth(streams: readonly ('transactional' | 'campaign')[]): DeliveryHealthRollup {
	if (streams.includes('campaign')) return verdict('error', 'feedback_missing_campaign');
	if (streams.includes('transactional')) return verdict('warn', 'feedback_missing_transactional');
	return HEALTHY;
}

/** Transactional sends always use the default sender; without a verified one they are refused. */
function senderHealth(sender: DeliveryHealthInputs['transactionalSender']): DeliveryHealthRollup {
	switch (sender) {
		case 'missing':
			return verdict('error', 'sender_missing');
		case 'unverified':
			return verdict('error', 'sender_unverified');
		default:
			return HEALTHY;
	}
}

/** Sending-IP dimension: every address held stops the MTA; some held is worth a look. */
function sendingIpHealth(posture: SendingIpPosture | null | undefined): DeliveryHealthRollup {
	switch (posture) {
		case 'all_held':
			return verdict('error', 'ips_all_held');
		case 'some_held':
			return verdict('warn', 'ips_some_held');
		default:
			return HEALTHY;
	}
}

/** A halted warm-up stops campaign volume from growing until it is cleared. */
function warmupHealth(isHalted: boolean): DeliveryHealthRollup {
	return isHalted ? verdict('warn', 'warmup_halted') : HEALTHY;
}

function mtaHealth(
	status: DeliveryHealthInputs['mtaInfrastructure'],
	heldSigningDomains: readonly string[] = []
): DeliveryHealthRollup {
	switch (status) {
		case 'signing_held':
			return heldSigningDomains.length > 0
				? {
						level: 'error',
						reasonCode: 'mta_signing_held',
						reasonParams: { domains: heldSigningDomains.join(', ') },
					}
				: verdict('error', 'mta_signing_held_unnamed');
		case 'degraded':
			return verdict('error', 'mta_degraded');
		case 'unreachable':
			return verdict('error', 'mta_unreachable');
		case 'stale':
			return verdict('warn', 'mta_stale');
		case 'unchecked':
			return verdict('warn', 'mta_unchecked');
		default:
			return HEALTHY;
	}
}

/**
 * Domain dimension. Going live needs at least one verified sending domain (the
 * Delivery page's readiness panel says "Not ready to send" without one), so no
 * verified domain is an error. A failed verification is an error too; with a
 * verified domain in place, anything still mid-flight only warns.
 */
function domainHealth(statuses: DomainStatus[]): DeliveryHealthRollup {
	if (statuses.some((s) => s === 'failed')) return verdict('error', 'domain_failed');
	if (statuses.length === 0) return verdict('error', 'no_domain');
	if (!statuses.some((s) => s === 'verified')) return verdict('error', 'no_verified_domain');
	if (statuses.some((s) => s === 'pending' || s === 'registering')) {
		return verdict('warn', 'domain_pending');
	}
	return HEALTHY;
}

/** Reputation dimension: critical blocks; high/medium warrant attention. */
function reputationHealth(risk: ReputationRisk | null): DeliveryHealthRollup {
	switch (risk) {
		case 'critical':
			return verdict('error', 'reputation_critical');
		case 'high':
			return verdict('warn', 'reputation_high');
		case 'medium':
			return verdict('warn', 'reputation_medium');
		default:
			return HEALTHY;
	}
}

/**
 * Roll the delivery-health dimensions into one worst-of verdict. Pure:
 * no DB, no ctx — the null-vs-populated and tie-break decisions are unit
 * testable. Ties at the same severity resolve in a fixed, most-actionable
 * order: provider → bounce feedback → infrastructure → sending IPs → domains → default sender →
 * warm-up → reputation (so a red provider dot names the provider, not a
 * coincidentally-red reputation).
 */
export function rollUpDeliveryHealth(inputs: DeliveryHealthInputs): DeliveryHealthRollup {
	const candidates: DeliveryHealthRollup[] = [
		providerHealth(inputs.canSend, inputs.streamsWithoutTransport ?? []),
		feedbackHealth(inputs.streamsWithoutFeedback ?? []),
		mtaHealth(inputs.mtaInfrastructure, inputs.heldSigningDomains),
		sendingIpHealth(inputs.sendingIps),
		domainHealth(inputs.domainStatuses),
		senderHealth(inputs.transactionalSender),
		warmupHealth(inputs.isWarmupHalted === true),
		reputationHealth(inputs.reputationRisk),
	];

	// Highest severity wins; first candidate at that severity supplies the reason.
	let worst = HEALTHY;
	for (const c of candidates) {
		if (SEVERITY[c.level] > SEVERITY[worst.level]) worst = c;
	}
	return worst;
}

/**
 * Live delivery-health roll-up for the sidebar dot. One query, three bounded
 * reads (rolling reputation buckets, sending domains, provider routes, and the
 * infrastructure singleton) — cheap enough to subscribe to from the nav. Member-level: it returns
 * only a level + a reason code, never a credential or a raw metric.
 */
// all-members: delivery health is org-wide operational status, member-visible — a coarse ok/warn/error level + reason code, no credentials or raw metrics.
export const getDeliveryHealth = authedQuery({
	args: {},
	handler: async (ctx): Promise<DeliveryHealthRollup> => {
		// Rolling 30-day org reputation, derived on read through the single
		// summarizer. No in-window activity summarizes to 'low' → treated as ok.
		const orgSummary = await summarize(ctx.db, { kind: 'org' });
		const hasActivity =
			orgSummary.totalSent > 0 ||
			orgSummary.totalDelivered > 0 ||
			orgSummary.totalBounced > 0 ||
			orgSummary.totalComplaints > 0;

		const domains = await ctx.db.query('domains').collect(); // bounded: org-curated sending domains, low-tens at most.

		const canSend = await isDeliveryConfigured(ctx);
		const routes = await ctx.db.query('providerRoutes').collect(); // bounded: one row per message type
		const usesMta =
			getOptional('EMAIL_PROVIDER') === OWN_ARM_TRANSPORT_KIND ||
			routes.some((route) =>
				route.providers.some(
					(provider) => provider.isEnabled && provider.providerType === OWN_ARM_TRANSPORT_KIND
				)
			);
		const { mtaHealth: snapshot } = await readInstanceCounter(ctx.db, 'mtaHealth');
		const mtaInfrastructure = usesMta ? mtaInfrastructureState(snapshot, Date.now()) : null;

		const streams = await streamHealthInputs(ctx, routes);
		return rollUpDeliveryHealth({
			reputationRisk: hasActivity ? orgSummary.riskLevel : null,
			domainStatuses: domains.map((d) => d.status),
			canSend,
			mtaInfrastructure,
			...streams,
			...(mtaInfrastructure === 'signing_held'
				? { heldSigningDomains: snapshot?.dkimSigningHeld?.map((held) => held.domain) ?? [] }
				: {}),
		});
	},
});

/**
 * The per-stream inputs, for the message types whose feature is on: which have
 * no transport of their own, the posture of the IPs and warm-up the built-in
 * MTA sends them from, and the transactional default sender.
 */
async function streamHealthInputs(
	ctx: QueryCtx,
	routes: readonly Doc<'providerRoutes'>[]
): Promise<
	Pick<
		DeliveryHealthInputs,
		| 'streamsWithoutTransport'
		| 'streamsWithoutFeedback'
		| 'sendingIps'
		| 'isWarmupHalted'
		| 'transactionalSender'
	>
> {
	const settings = await ctx.db.query('instanceSettings').first();
	const flags = resolveStoredFeatureFlags((settings?.featureFlags ?? {}) as FeatureFlagState);
	const streams = [
		...(flags.transactional ? (['transactional'] as const) : []),
		...(flags.campaigns ? (['campaign'] as const) : []),
	];

	const streamsWithoutTransport: ('transactional' | 'campaign')[] = [];
	const streamsWithoutFeedback: ('transactional' | 'campaign')[] = [];
	const mtaPools: ('transactional' | 'campaign')[] = [];
	for (const stream of streams) {
		if (!(await isDeliveryConfigured(ctx, stream))) streamsWithoutTransport.push(stream);
		const kinds = await messageTypeTransportKinds(ctx, routes, stream);
		if (kinds.includes(OWN_ARM_TRANSPORT_KIND)) mtaPools.push(stream);
		if (missingFeedbackVariablesFor(kinds).length > 0) streamsWithoutFeedback.push(stream);
	}

	const warming = mtaPools.length > 0 ? await ctx.db.query('warmingState').first() : null;
	const postures = new Set(
		mtaPools.map((pool) => sendingIpPosture(warming?.ips ?? [], pool, warming?.pools))
	);
	return {
		streamsWithoutTransport,
		streamsWithoutFeedback,
		sendingIps: postures.has('all_held')
			? 'all_held'
			: postures.has('some_held')
				? 'some_held'
				: null,
		isWarmupHalted: mtaPools.includes('campaign') && warming?.phase === 'plateau',
		transactionalSender: flags.transactional ? await transactionalSenderState(ctx, settings) : null,
	};
}

/** The transactional sender (`transactional/senderResolution.ts`) as the roll-up grades it. */
async function transactionalSenderState(
	ctx: QueryCtx,
	settings: Doc<'instanceSettings'> | null
): Promise<'missing' | 'unverified' | null> {
	const sender = await loadTransactionalSender(ctx, { settings });
	if (sender.address === null) return 'missing';
	return sender.isDomainVerified ? null : 'unverified';
}
