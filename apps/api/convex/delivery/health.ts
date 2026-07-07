/**
 * Delivery health roll-up — the single "is sending healthy right now?" signal
 * that drives the sidebar's **Delivery** status dot.
 *
 * It composes three EXISTING read surfaces into one cheap query so the nav can
 * subscribe once (no N+1):
 *  - org sending reputation risk (`summarize` → `riskLevel`)
 *  - sending-domain verification states (`domains` table)
 *  - whether a delivery provider is actually configured (`isDeliveryConfigured`)
 *
 * The worst-of logic lives in the pure `rollUpDeliveryHealth` so it is unit
 * testable without a DB. Levels map to the shared success/warning/error tokens
 * on the client; the `reason` names the worst offender for the dot's tooltip.
 */

import { authedQuery } from '../lib/authedFunctions';
import { getUserIdFromSession } from '../lib/sessionOrganization';
import { summarize } from '../analytics/sendingReputation';
import { isDeliveryConfigured } from '../lib/sendProviders/capability';

/** Traffic-light level for the Delivery status dot. */
export type DeliveryHealthLevel = 'ok' | 'warn' | 'error';

/** Reputation risk buckets produced by `calculateRiskLevel`. */
export type ReputationRisk = 'low' | 'medium' | 'high' | 'critical';

/** Sending-domain verification states (`domains.status`). */
export type DomainStatus = 'registering' | 'pending' | 'verified' | 'failed';

export interface DeliveryHealthInputs {
	/** Rolling org reputation risk, or `null` when there's no in-window activity. */
	reputationRisk: ReputationRisk | null;
	/** Verification status of every configured sending domain. */
	domainStatuses: DomainStatus[];
	/** Whether the send path can actually dispatch (provider configured). */
	canSend: boolean;
}

export interface DeliveryHealthRollup {
	level: DeliveryHealthLevel;
	/** One human line naming the worst offender, for the dot's title tooltip. */
	reason: string;
}

const SEVERITY: Record<DeliveryHealthLevel, number> = { ok: 0, warn: 1, error: 2 };

/** Provider dimension: no usable provider is a hard, send-blocking failure. */
function providerHealth(canSend: boolean): DeliveryHealthRollup {
	return canSend
		? { level: 'ok', reason: 'Delivery provider is configured' }
		: { level: 'error', reason: 'No delivery provider is configured' };
}

/** Domain dimension: a failed verification is an error; anything mid-flight warns. */
function domainHealth(statuses: DomainStatus[]): DeliveryHealthRollup {
	if (statuses.some((s) => s === 'failed')) {
		return { level: 'error', reason: 'A sending domain failed verification' };
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
 * Roll the three delivery-health dimensions into one worst-of verdict. Pure:
 * no DB, no ctx — the null-vs-populated and tie-break decisions are unit
 * testable. Ties at the same severity resolve in a fixed, most-actionable
 * order: provider → domains → reputation (so a red provider dot names the
 * provider, not a coincidentally-red reputation).
 */
export function rollUpDeliveryHealth(inputs: DeliveryHealthInputs): DeliveryHealthRollup {
	const candidates: DeliveryHealthRollup[] = [
		providerHealth(inputs.canSend),
		domainHealth(inputs.domainStatuses),
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
 * reads (rolling reputation buckets, the org's sending domains, the provider
 * routes) — cheap enough to subscribe to from the nav. Member-level: it returns
 * only a level + a human reason string, never a credential or a raw metric.
 */
export const getDeliveryHealth = authedQuery({
	args: {},
	handler: async (ctx): Promise<DeliveryHealthRollup> => {
		await getUserIdFromSession(ctx);

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

		return rollUpDeliveryHealth({
			reputationRisk: hasActivity ? orgSummary.riskLevel : null,
			domainStatuses: domains.map((d) => d.status),
			canSend,
		});
	},
});
