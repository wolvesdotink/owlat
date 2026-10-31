/**
 * One bucket of a page of the checkpointed campaign-send walker
 * (`send.ts:resolveCampaignPage`), planned for the page commit: each
 * recipient's personalized subject, and the recipients grouped by when they
 * go out (the send-time plan, the recipient's zone, or now).
 */

import type { CampaignRecipient } from './audienceCandidates';
import { resolveNextSendTime, isValidTimeZone } from '../lib/emailHelpers';
import { personalizeSubject } from '../delivery/sendComposition';
import type { PlannedSendTime } from './sendTimeOptimization';
import type { HopSendContext } from './pageDecision';
import type { PageBucket } from './walkerCommit';

// ─── Per-variant bucket plan ───────────────────────────────────────────

type PlanBucketArgs = HopSendContext & {
	recipients: ReadonlyArray<CampaignRecipient>;
	abVariant: 'A' | 'B' | undefined;
	subject: string;
	htmlContent: string;
	/** Pre-generated (or author-overridden) text/plain body; default language only. */
	plainTextContent?: string;
	// Send-time optimization: the instant and arm the planner chose per
	// contact id. Set only for an optimized campaign; replaces both the
	// timezone grouping and the immediate send.
	plannedSendTimes?: ReadonlyMap<string, PlannedSendTime>;
	now: number;
};

// One bucket (one variant, one language) of a page, as the page commit takes
// it: each recipient's personalized subject, and the recipients grouped by
// when they go out. The commit inserts the rows and schedules the enqueue
// chunks (`campaigns/walkerCommit.ts`); the orchestrator's only enqueue site.
export function planBucket(args: PlanBucketArgs): PageBucket {
	const { plannedSendTimes } = args;
	const fallbackZone = isValidTimeZone(args.defaultTimezone) ? args.defaultTimezone : 'UTC';
	// When a recipient goes out, keyed by the group it shares with others.
	const sendInstant = (r: CampaignRecipient): { key: string; sendAt?: number } => {
		if (plannedSendTimes) {
			// One group per proposed instant. The enqueue at that instant goes
			// through the same governed path as any other, so the MTA's pacing,
			// the ramp ceilings and the deliverability gates still own throughput.
			const sendAt = plannedSendTimes.get(r._id)?.at ?? args.now;
			return { key: String(sendAt), sendAt };
		}
		if (args.useTimezone) {
			// Group by the recipient's IANA zone, then resolve the next
			// `scheduledHour:scheduledMinute` local instant per zone — DST-correct,
			// unlike a static UTC-offset table. Recipients without a valid zone fall
			// back to the org-level timezone (General settings) when it is a valid
			// zone, otherwise to UTC.
			const zone = isValidTimeZone(r.timezone) ? r.timezone : fallbackZone;
			const sendAt = resolveNextSendTime(
				zone,
				args.scheduledHour!,
				args.scheduledMinute!,
				args.now
			);
			return { key: zone, sendAt };
		}
		return { key: 'now' };
	};

	const groups = new Map<string, PageBucket['groups'][number]>();
	for (const r of args.recipients) {
		const recipient = {
			contactId: r._id,
			email: r.email,
			firstName: r.firstName,
			lastName: r.lastName,
			// Projected by audience resolution from the already-loaded contact:
			// the engagement score rides the envelope to the MTA's priority
			// bands. Undefined for an unscored contact and simply omitted.
			engagementScore: r.engagementScore,
			personalizedSubject: personalizeSubject({
				kind: 'campaign',
				template: { subject: args.subject, htmlContent: '' },
				contactInfo: { email: r.email, firstName: r.firstName, lastName: r.lastName },
			}),
			...(plannedSendTimes?.has(r._id)
				? { sendTimeGroup: plannedSendTimes.get(r._id)!.group }
				: {}),
		};
		const { key, sendAt } = sendInstant(r);
		const group = groups.get(key);
		if (group) group.recipients.push(recipient);
		else groups.set(key, { ...(sendAt === undefined ? {} : { sendAt }), recipients: [recipient] });
	}

	return {
		envelope: {
			from: args.from,
			replyTo: args.replyTo,
			subject: args.subject,
			htmlContent: args.htmlContent,
			plainTextContent: args.plainTextContent,
			convexSiteUrl: args.convexSiteUrl,
			siteUrl: args.siteUrl,
			audienceType: args.audienceType,
			viewInBrowserUrl: args.viewInBrowserUrl,
			providerType: args.providerType,
			ipPool: args.ipPool,
			trackingBaseUrl: args.trackingBaseUrl,
			organizationId: args.organizationId,
			listId: args.listId,
			// Keys the deliverability seed-probe set: the two A/B arms are
			// different messages and each gets its own placement reading.
			abVariant: args.abVariant,
		},
		groups: [...groups.values()],
	};
}
