/**
 * The delivery-health roll-up explained, with the member-visible facts behind
 * it: each sending domain's verification status, the org's rolling bounce and
 * complaint rates against the limits the delivery hub shows, and the sending
 * hold. The assistant's `getDeliveryHealth` tool and `GET /api/v1/status` both
 * read this, so a caller of either gets the verdict the sidebar dot shows.
 *
 * Nothing here may be admin-only: every member reads these facts in the web
 * app, and a `status:read` key or the assistant reads them for anyone. The
 * Deliverability Center's checks (`delivery/checklist.ts`), DNS records,
 * provider settings and raw provider errors stay out.
 */

import { REPUTATION_THRESHOLDS } from '@owlat/shared/reputation';
import type { DatabaseReader, QueryCtx } from '../_generated/server';
import type { SendingHoldLift } from '@owlat/public-contract';
import { readSuspensionLift } from '../analytics/reputationEvidence';
import { readOrgReputation } from '../analytics/reputationQueries';
import { loadDeliveryHealth, type DeliveryHealthLevel, type DomainStatus } from './health';
import { publicSendingHoldLift } from './sendingHoldLift';
import {
	DELIVERY_HEALTH_EXPLANATIONS,
	type DeliveryHealthFixAudience,
	type DeliveryHealthReason,
} from './healthCopy';

/** A rate (0–1) as a percentage to three decimals, next to its limit. */
function rateAgainstLimit(rate: number, limit: number) {
	const asPct = (value: number) => Math.round(value * 100_000) / 1000;
	return { ratePct: asPct(rate), limitPct: asPct(limit), isOver: rate >= limit };
}

/**
 * The suspension or ban in force, with the reason and time the status was
 * recorded and how it lifts, or `null` while sending is allowed. A lift keeps
 * the old reason on the row, so it is read only while the status still holds.
 * `reason` is the stored text as is; a reader that hands it to a model clamps
 * it. `lift` is what the delivery hub banner tells every member.
 */
export async function readSendingHoldRecord(db: DatabaseReader): Promise<{
	status: 'suspended' | 'banned';
	reason: string | null;
	since: number | null;
	lift: SendingHoldLift;
} | null> {
	const settings = await db.query('instanceSettings').first();
	const status = settings?.abuseStatus;
	if (status !== 'suspended' && status !== 'banned') return null;
	const lift = await readSuspensionLift(db, settings, Date.now());
	return {
		status,
		reason: settings?.abuseStatusReason || null,
		since: settings?.abuseStatusChangedAt ?? null,
		lift: publicSendingHoldLift(lift ?? { mode: 'admin' }),
	};
}

export interface DeliveryHealthReport {
	level: DeliveryHealthLevel;
	reasonCode: DeliveryHealthReason;
	/** The reason's English sentence, its values filled in. */
	explanation: string;
	fix: { route: string; who: DeliveryHealthFixAudience } | null;
	domains: { domain: string; status: DomainStatus }[];
	rates: {
		windowDays: number;
		sent: number;
		bounce: ReturnType<typeof rateAgainstLimit>;
		complaint: ReturnType<typeof rateAgainstLimit>;
	} | null;
	hold: Awaited<ReturnType<typeof readSendingHoldRecord>>;
}

export async function loadDeliveryHealthReport(ctx: QueryCtx): Promise<DeliveryHealthReport> {
	const verdict = await loadDeliveryHealth(ctx);
	const { sentence, fix } = DELIVERY_HEALTH_EXPLANATIONS[verdict.reasonCode];
	const explanation = Object.entries(verdict.reasonParams ?? {}).reduce(
		(text, [name, value]) => text.replaceAll(`{${name}}`, value),
		sentence as string
	);

	const domainRows = await ctx.db.query('domains').collect(); // bounded: org-curated sending domains, low-tens at most
	const reputation = await readOrgReputation(ctx.db);
	return {
		level: verdict.level,
		reasonCode: verdict.reasonCode,
		explanation,
		fix,
		domains: domainRows.map((row) => ({ domain: row.domain, status: row.status })),
		// The limit is the one the delivery hub's tiles and the marketing
		// overview quote; past it the reputation verdict starts to warn.
		rates: reputation
			? {
					// The summarizer's rolling window (`analytics/sendingReputation.ts`).
					windowDays: 30,
					sent: reputation.totalSent,
					bounce: rateAgainstLimit(reputation.bounceRate, REPUTATION_THRESHOLDS.bounce.medium),
					complaint: rateAgainstLimit(
						reputation.complaintRate,
						REPUTATION_THRESHOLDS.complaint.medium
					),
				}
			: null,
		hold: await readSendingHoldRecord(ctx.db),
	};
}
