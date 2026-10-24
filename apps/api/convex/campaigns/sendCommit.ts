/**
 * Campaign send preparation commit (module) — the ONE write of
 * `startCampaignSend` (`campaigns/send.ts`).
 *
 * The orchestrator action reads the campaign and its template, runs the
 * content scan (with the Safe Browsing lookup, an external call) and composes
 * the archive copy. Everything it decided is then written here, in a single
 * transaction:
 *
 *   - `scheduled → sending` on the scheduler-tick path;
 *   - a blocked or suspicious verdict: the scan row and `→ draft` (with the
 *     block reason) or `→ pending_review`;
 *   - a clean verdict: the template version captured for the send, the archive
 *     snapshot, the frozen segment, the send job and the first walker hop.
 *
 * Either all of it lands or none of it does, so a failure part-way never
 * leaves a campaign in `sending` with no job, a version row for a send that
 * never started, or a job without its walker hop.
 *
 * The commit re-checks what the action read, because the scan can take long
 * enough for the campaign to move: the fire-time guards, the status the action
 * saw, the pre-flight, whether this send was already prepared by another hop,
 * and that the scanned subject and HTML are still the ones on the campaign. A
 * moved campaign is skipped. Changed content is never sent on a stale
 * verdict: the commit writes nothing and schedules a fresh start, which scans
 * the new content.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import { getLive } from '../lib/softDelete';
import { contentScanResultsFields } from '../schema/delivery';
import { assertTransitioned, transitionCampaign } from './lifecycle';
import { validateReadyToSend } from './preflight';
import { captureTemplateVersion } from '../emailTemplates/versions';
import { writeArchiveSnapshot } from './archiveQueries';
import { freezeAudience } from './sendQueries';
import { openSendJob, readSendJob } from './sendJob';
import { classifyStartSendSkip, isSendPrepared } from './sendPlanning';
import { resolveAbFanout, testFractionForSplit } from './sendVariantSplit';

const LIFECYCLE_USER_SCHEDULER_TICK = 'system:scheduler_tick';
const LIFECYCLE_USER_CONTENT_SCAN = 'system:content_scan';
const LIFECYCLE_USER_ORCHESTRATOR = 'system:orchestrator';

/** The subject the scan reads: the campaign's override, else the template's. */
export function scannedSubject(
	campaign: Pick<Doc<'campaigns'>, 'subject'>,
	template: Pick<Doc<'emailTemplates'>, 'subject'>
): string {
	return campaign.subject ?? template.subject;
}

/**
 * SHA-256 over the scanned subject and HTML. The action sends it with its
 * verdict and the commit recomputes it from the rows it reads, so a template
 * or subject edited during the scan is caught without shipping the HTML twice.
 */
export async function scannedContentDigest(subject: string, htmlContent: string): Promise<string> {
	// NUL separator so ('a', 'bc') and ('ab', 'c') cannot digest alike.
	const bytes = new TextEncoder().encode(`${subject}\u0000${htmlContent}`);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const scanVerdictValidator = v.object({
	score: contentScanResultsFields.score,
	level: contentScanResultsFields.level,
	flags: contentScanResultsFields.flags,
});

const archiveSnapshotValidator = v.object({
	archiveToken: v.string(),
	archiveHtmlContent: v.string(),
	archiveSubject: v.string(),
});

/** Outcome of one commit, mapped onto the orchestrator's result by the action. */
export type PreparationCommit =
	| { kind: 'committed'; outcome: 'prepared' | 'blocked' | 'held' }
	| { kind: 'skipped'; reason: string }
	| { kind: 'rescan'; reason: string };

export const commitPreparation = internalMutation({
	args: {
		campaignId: v.id('campaigns'),
		/** What the action read before its scan. */
		read: v.object({
			status: v.union(v.literal('scheduled'), v.literal('sending')),
			templateId: v.id('emailTemplates'),
			contentDigest: v.string(),
		}),
		verdict: v.union(
			v.object({
				kind: v.literal('proceed'),
				// Absent when the campaign does not archive or SITE_URL is unset.
				archive: v.optional(archiveSnapshotValidator),
			}),
			v.object({
				kind: v.literal('blocked'),
				contentBlockReason: v.string(),
				scan: scanVerdictValidator,
			}),
			v.object({ kind: v.literal('held'), scan: scanVerdictValidator })
		),
	},
	handler: async (ctx, args): Promise<PreparationCommit> => {
		const now = Date.now();
		const { campaignId, read, verdict } = args;

		const campaign = await getLive(ctx, campaignId);
		if (!campaign) return { kind: 'skipped', reason: 'Campaign was deleted' };
		const guardSkip = classifyStartSendSkip(campaign, now);
		if (guardSkip !== undefined) return { kind: 'skipped', reason: guardSkip };
		if (campaign.status !== read.status) {
			return { kind: 'skipped', reason: 'Campaign status changed during preparation' };
		}
		if (isSendPrepared(campaign, await readSendJob(ctx, campaignId))) {
			return { kind: 'skipped', reason: 'Campaign send is already prepared' };
		}
		const preflight = await validateReadyToSend(ctx, campaign, { checkCapacity: false });
		if (!preflight.ok) {
			return { kind: 'skipped', reason: `Pre-flight failed: ${preflight.message}` };
		}

		const template =
			campaign.emailTemplateId === read.templateId ? await getLive(ctx, read.templateId) : null;
		const htmlContent = template?.htmlContent;
		if (
			!template ||
			!htmlContent ||
			(await scannedContentDigest(scannedSubject(campaign, template), htmlContent)) !==
				read.contentDigest
		) {
			await ctx.scheduler.runAfter(0, internal.campaigns.send.startCampaignSend, { campaignId });
			return {
				kind: 'rescan',
				reason: 'Campaign content changed during the content scan; scanning again',
			};
		}

		if (campaign.status === 'scheduled') {
			const started = await transitionCampaign(
				ctx,
				campaignId,
				{ to: 'sending', at: now },
				LIFECYCLE_USER_SCHEDULER_TICK
			);
			assertTransitioned(started, 'start');
		}

		if (verdict.kind !== 'proceed') {
			await ctx.db.insert('contentScanResults', {
				resourceType: 'campaign',
				resourceId: campaignId,
				...verdict.scan,
				scannedAt: now,
			});
			const outcome = await transitionCampaign(
				ctx,
				campaignId,
				verdict.kind === 'blocked'
					? { to: 'draft', at: now, contentBlockReason: verdict.contentBlockReason }
					: { to: 'pending_review', at: now },
				LIFECYCLE_USER_CONTENT_SCAN
			);
			assertTransitioned(outcome, verdict.kind === 'blocked' ? 'block' : 'hold');
			return { kind: 'committed', outcome: verdict.kind };
		}

		// Past the content-scan gate only, so a blocked or held campaign leaves no
		// "sent" snapshot. Deduplicated and capped by the versions module.
		await captureTemplateVersion(ctx, {
			template,
			trigger: 'send',
			userId: LIFECYCLE_USER_ORCHESTRATOR,
		});
		if (verdict.archive) {
			await writeArchiveSnapshot(ctx, campaignId, verdict.archive, now);
		}
		// Freeze the segment so this send, and an A/B winner phase after it,
		// resolve the exact Segment it targeted even if the Segment is edited.
		const audience = await freezeAudience(ctx, campaignId);
		if (!audience) throw new Error('Campaign has no audience');

		// Read after `→ sending`: on the scheduler-tick path that transition is
		// what moves an A/B campaign's test into `testing`.
		const sending = await ctx.db.get(campaignId);
		const abFanout = sending ? resolveAbFanout(sending) : null;
		await openSendJob(ctx, {
			campaignId,
			audience,
			now,
			...(abFanout
				? {
						variantMode: 'ab_test' as const,
						testFraction: testFractionForSplit(abFanout.config.splitPercentage),
						splitPercentage: abFanout.config.splitPercentage,
					}
				: { variantMode: 'plain' as const }),
		});
		await ctx.scheduler.runAfter(0, internal.campaigns.send.resolveCampaignPage, { campaignId });
		return { kind: 'committed', outcome: 'prepared' };
	},
});
