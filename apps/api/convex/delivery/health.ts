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
 * on the client; the `reason` names the worst offender for the dot's tooltip.
 */

import { authedQuery } from '../lib/authedFunctions';
import { summarize } from '../analytics/sendingReputation';
import { isDeliveryConfigured, messageTypeTransportKinds } from '../lib/sendProviders/capability';
import { getOptional } from '../lib/env';
import { OWN_ARM_TRANSPORT_KIND } from '../lib/sendProviders/strategies/adaptive_mix';
import { MTA_HEALTH_MAX_AGE_MS } from './mtaHealthFreshness';
import { readInstanceCounter } from '../lib/instanceCounters';
import { resolveStoredFeatureFlags } from '../lib/featureFlags';
import { configuredDefaultFromEmail } from '../transactional/dispatchDecision';
import { checkEmailDomainVerification } from '../domains/domains';
import { sendingIpPosture, type SendingIpPosture } from '@owlat/shared/ipReadiness';
import type { FeatureFlagState } from '@owlat/shared/featureFlags';
import type { Infer } from 'convex/values';
import type { QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import type { mtaHealthSnapshotValidator } from '../schema/instance';

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
	 * The transactional default sender: `missing` when none is configured,
	 * `unverified` when its domain is not verified, `null` when it is fine or
	 * transactional sending is switched off.
	 */
	transactionalSender?: 'missing' | 'unverified' | null;
}

/** How the built-in MTA's last health snapshot reads right now. */
export type MtaInfrastructureState = 'healthy' | 'degraded' | 'unreachable' | 'stale' | 'unchecked';

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
	if (snapshot.status === 'ok') return 'healthy';
	return snapshot.status;
}

interface DeliveryHealthRollup {
	level: DeliveryHealthLevel;
	/** One human line naming the worst offender, for the dot's title tooltip. */
	reason: string;
}

const SEVERITY: Record<DeliveryHealthLevel, number> = { ok: 0, warn: 1, error: 2 };

/** Provider dimension: no usable provider is a hard, send-blocking failure. */
function providerHealth(
	canSend: boolean,
	streamsWithoutTransport: readonly ('transactional' | 'campaign')[]
): DeliveryHealthRollup {
	if (!canSend) return { level: 'error', reason: 'No delivery provider is configured' };
	if (streamsWithoutTransport.includes('transactional')) {
		return { level: 'error', reason: 'No delivery provider is configured for transactional mail' };
	}
	if (streamsWithoutTransport.includes('campaign')) {
		return { level: 'error', reason: 'No delivery provider is configured for campaigns' };
	}
	return { level: 'ok', reason: 'Delivery provider is configured' };
}

/** Transactional sends always use the default sender; without a verified one they are refused. */
function senderHealth(sender: DeliveryHealthInputs['transactionalSender']): DeliveryHealthRollup {
	switch (sender) {
		case 'missing':
			return { level: 'error', reason: 'No default sender is set for transactional mail' };
		case 'unverified':
			return {
				level: 'error',
				reason: "The default sender's domain is not verified, so transactional mail is refused",
			};
		default:
			return { level: 'ok', reason: 'The default sender is verified' };
	}
}

/** Sending-IP dimension: every address held stops the MTA; some held is worth a look. */
function sendingIpHealth(posture: SendingIpPosture | null | undefined): DeliveryHealthRollup {
	switch (posture) {
		case 'all_held':
			return { level: 'error', reason: 'Every sending IP is held back' };
		case 'some_held':
			return { level: 'warn', reason: 'Some sending IPs are held back' };
		default:
			return { level: 'ok', reason: 'Sending IPs are in rotation' };
	}
}

/** A halted warm-up stops campaign volume from growing until it is cleared. */
function warmupHealth(isHalted: boolean): DeliveryHealthRollup {
	return isHalted
		? { level: 'warn', reason: 'IP warm-up is halted' }
		: { level: 'ok', reason: 'IP warm-up is on track' };
}

function mtaHealth(status: DeliveryHealthInputs['mtaInfrastructure']): DeliveryHealthRollup {
	switch (status) {
		case 'degraded':
			return { level: 'error', reason: 'Mail server infrastructure is degraded' };
		case 'unreachable':
			return { level: 'error', reason: 'Mail server health endpoint is unreachable' };
		case 'stale':
			return { level: 'warn', reason: 'Mail server health check is stale' };
		case 'unchecked':
			return { level: 'warn', reason: 'Mail server health has not been checked yet' };
		default:
			return { level: 'ok', reason: 'Mail server infrastructure is healthy' };
	}
}

/**
 * Domain dimension. Going live needs at least one verified sending domain (the
 * Delivery page's readiness panel says "Not ready to send" without one), so no
 * verified domain is an error. A failed verification is an error too; with a
 * verified domain in place, anything still mid-flight only warns.
 */
function domainHealth(statuses: DomainStatus[]): DeliveryHealthRollup {
	if (statuses.some((s) => s === 'failed')) {
		return { level: 'error', reason: 'A sending domain failed verification' };
	}
	if (statuses.length === 0) {
		return { level: 'error', reason: 'No sending domain is set up yet' };
	}
	if (!statuses.some((s) => s === 'verified')) {
		return { level: 'error', reason: 'No sending domain is verified yet' };
	}
	if (statuses.some((s) => s === 'pending' || s === 'registering')) {
		return { level: 'warn', reason: "A sending domain isn't verified yet" };
	}
	return { level: 'ok', reason: 'Sending domains are verified' };
}

/** Reputation dimension: critical blocks; high/medium warrant attention. */
function reputationHealth(risk: ReputationRisk | null): DeliveryHealthRollup {
	switch (risk) {
		case 'critical':
			return { level: 'error', reason: 'Sending reputation is critical' };
		case 'high':
			return { level: 'warn', reason: 'Sending reputation is at risk' };
		case 'medium':
			return { level: 'warn', reason: 'Sending reputation needs attention' };
		default:
			return { level: 'ok', reason: 'Sending reputation is healthy' };
	}
}

/**
 * Roll the delivery-health dimensions into one worst-of verdict. Pure:
 * no DB, no ctx — the null-vs-populated and tie-break decisions are unit
 * testable. Ties at the same severity resolve in a fixed, most-actionable
 * order: provider → infrastructure → sending IPs → domains → default sender →
 * warm-up → reputation (so a red provider dot names the provider, not a
 * coincidentally-red reputation).
 */
export function rollUpDeliveryHealth(inputs: DeliveryHealthInputs): DeliveryHealthRollup {
	const candidates: DeliveryHealthRollup[] = [
		providerHealth(inputs.canSend, inputs.streamsWithoutTransport ?? []),
		mtaHealth(inputs.mtaInfrastructure),
		sendingIpHealth(inputs.sendingIps),
		domainHealth(inputs.domainStatuses),
		senderHealth(inputs.transactionalSender),
		warmupHealth(inputs.isWarmupHalted === true),
		reputationHealth(inputs.reputationRisk),
	];

	// Highest severity wins; first candidate at that severity supplies the reason.
	let worst = candidates[0]!;
	for (const c of candidates) {
		if (SEVERITY[c.level] > SEVERITY[worst.level]) worst = c;
	}
	return worst;
}

/**
 * Live delivery-health roll-up for the sidebar dot. One query, three bounded
 * reads (rolling reputation buckets, sending domains, provider routes, and the
 * infrastructure singleton) — cheap enough to subscribe to from the nav. Member-level: it returns
 * only a level + a human reason string, never a credential or a raw metric.
 */
// all-members: delivery health is org-wide operational status, member-visible — a coarse ok/warn/error level + human reason string, no credentials or raw metrics.
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
		'streamsWithoutTransport' | 'sendingIps' | 'isWarmupHalted' | 'transactionalSender'
	>
> {
	const settings = await ctx.db.query('instanceSettings').first();
	const flags = resolveStoredFeatureFlags((settings?.featureFlags ?? {}) as FeatureFlagState);
	const streams = [
		...(flags.transactional ? (['transactional'] as const) : []),
		...(flags.campaigns ? (['campaign'] as const) : []),
	];

	const streamsWithoutTransport: ('transactional' | 'campaign')[] = [];
	const mtaPools: ('transactional' | 'campaign')[] = [];
	for (const stream of streams) {
		if (!(await isDeliveryConfigured(ctx, stream))) streamsWithoutTransport.push(stream);
		const kinds = await messageTypeTransportKinds(ctx, routes, stream);
		if (kinds.includes(OWN_ARM_TRANSPORT_KIND)) mtaPools.push(stream);
	}

	const warming = mtaPools.length > 0 ? await ctx.db.query('warmingState').first() : null;
	const postures = new Set(
		mtaPools.map((pool) => sendingIpPosture(warming?.ips ?? [], pool, warming?.pools))
	);
	return {
		streamsWithoutTransport,
		sendingIps: postures.has('all_held')
			? 'all_held'
			: postures.has('some_held')
				? 'some_held'
				: null,
		isWarmupHalted: mtaPools.includes('campaign') && warming?.phase === 'plateau',
		transactionalSender: flags.transactional ? await transactionalSenderState(ctx, settings) : null,
	};
}

/** The transactional default sender as the roll-up grades it. */
async function transactionalSenderState(
	ctx: QueryCtx,
	settings: { defaultFromEmail?: string } | null
): Promise<'missing' | 'unverified' | null> {
	const address = configuredDefaultFromEmail(settings, {
		defaultFromEmail: getOptional('DEFAULT_FROM_EMAIL'),
	});
	if (address === null) return 'missing';
	return (await checkEmailDomainVerification(ctx, address)).verified ? null : 'unverified';
}
