/**
 * Campaign send enqueue — the bulk producer.
 *
 * Per ADR-0006, the workpool `onComplete` callback is owned by the Send
 * completion (module) at `delivery/sendCompletion.ts` — the enqueue below
 * wires it directly via `internal.delivery.sendCompletion.completeSend`. The
 * legacy `onEmailComplete` that previously lived in this file (per-kind
 * branching, inline `transactionalSends.createInternal` on success, inline
 * contact-activity insert, attachment-cleanup loop, provider health tracking)
 * is gone; every concern moved to the lifecycle effect list or to the Send
 * completion module.
 *
 * The two NON-campaign producers — automation email steps and agent
 * approved-replies — live in the sibling **Non-campaign send intake (module)**
 * at `delivery/nonCampaignIntake.ts`. They are an intake, not a bulk enqueue:
 * they run the shared pre-row gate sequence and return a discriminated
 * outcome to a single caller, where a campaign page is fanned out from an
 * already-gated orchestrator. The member-only TEST PREVIEW producer and its
 * retention callback live in `delivery/enqueueTestSend.ts` — a preview has no
 * contact, so it has none of the contact-shaped concerns (suppression,
 * engagement score, experiment assignment, seed probe) and carries a retention
 * concern of its own.
 */

import { type Infer, v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { campaignEmailPool } from './workpool';
import { recordSendAssignments } from './sendAssignments';
import { normalizeEngagementScore } from './workerEnvelope';
import { enqueueSeedShadowCopies, type CampaignEnvelopeInput } from './seedShadowCopy';
import { logError } from '../lib/runtimeLog';

/**
 * One element of `enqueueCampaignEmails.emails` — the per-recipient slice of a
 * campaign enqueue. THE VALIDATOR IS THE SINGLE DEFINITION: producers
 * (`campaigns/send.ts`) build their batches against `CampaignEnqueueEmail`
 * rather than hand-duplicating the shape, so adding a field here is one edit
 * and a drift is a type error rather than a silently dropped value.
 */
export const campaignEnqueueEmailValidator = v.object({
	emailSendId: v.id('emailSends'),
	contactId: v.id('contacts'),
	email: v.string(),
	firstName: v.optional(v.string()),
	lastName: v.optional(v.string()),
	// `contacts.engagementScore` (0-100) as projected by audience
	// resolution. Absent for an unscored contact; carried on the
	// envelope so dispatch never re-reads the contact row.
	engagementScore: v.optional(v.number()),
});

export type CampaignEnqueueEmail = Infer<typeof campaignEnqueueEmailValidator>;

/**
 * Internal mutation to enqueue campaign emails to workpool (used for
 * timezone-delayed sending). Lives in a non-node file because mutations
 * cannot run in Node.js runtime.
 *
 * Each enqueue carries a typed `sendRef` in the workpool context so the
 * Send completion module can translate worker outcomes into Send lifecycle
 * transitions uniformly across kinds.
 */
export const enqueueCampaignEmails = internalMutation({
	args: {
		campaignId: v.id('campaigns'),
		emails: v.array(campaignEnqueueEmailValidator),
		from: v.string(),
		replyTo: v.optional(v.string()),
		subject: v.string(),
		htmlContent: v.string(),
		// Pre-generated (or author-overridden) text/plain body from the template
		// row. Absent → the composer strips the untracked html instead.
		plainTextContent: v.optional(v.string()),
		convexSiteUrl: v.optional(v.string()),
		siteUrl: v.optional(v.string()),
		audienceType: v.optional(v.union(v.literal('topic'), v.literal('segment'))),
		viewInBrowserUrl: v.optional(v.string()),
		providerType: v.optional(v.string()),
		ipPool: v.optional(v.string()),
		trackingBaseUrl: v.optional(v.string()),
		// Singleton org id — anchors the Gmail FBL Feedback-ID SenderId.
		organizationId: v.optional(v.string()),
		// RFC 2919 List-Id header value for a TOPIC campaign, pre-built by the
		// orchestrator via `getListIdHeader`. Absent for segment campaigns.
		listId: v.optional(v.string()),
		// A/B arm this page belongs to. Only used to key the seed-probe set: the
		// two arms are different messages and each deserves its own reading.
		abVariant: v.optional(v.union(v.literal('A'), v.literal('B'))),
	},
	handler: async (ctx, args) => {
		// The experiment record (plan D7): one assignment row per recipient,
		// written BEFORE any dispatch and inside THIS transaction, so the record
		// and the sends commit or roll back together. Never throws: an
		// unresolvable org or route degrades to no row, never a failed send.
		//
		// `args.providerType` is deliberately NOT used as the recorded
		// transport: the orchestrator resolves it once per page from the first
		// recipient and labels it an advisory snapshot, while the deliverability
		// fallback is keyed per destination provider. The writer re-resolves
		// in-transaction, memoized per destination provider.
		await recordSendAssignments(ctx, {
			organizationId: args.organizationId,
			stream: 'campaign',
			sendKind: 'campaign',
			// THE anti-cohort salt (plan D7): without it a contact would sit in
			// the same arm for every campaign forever and the two arms would be
			// two fixed cohorts, so every ratio the ramp controller reads would
			// compare cohort quality rather than transport quality.
			campaignId: args.campaignId,
			routing: { messageType: 'campaign', from: args.from },
			recipients: args.emails.map((recipient) => ({
				sendId: recipient.emailSendId,
				email: recipient.email,
				contactId: recipient.contactId,
				// Already projected onto the envelope by audience resolution, so
				// stratified assignment costs no additional read. Handed over RAW:
				// every reader applies `normalizeEngagementScore` itself — the ranker
				// here, the envelope below, the walker's day-slice ordering — so one
				// number cannot be a top-of-cell engagement signal here and an
				// upstream defect three lines later.
				...(recipient.engagementScore !== undefined
					? { engagementScore: recipient.engagementScore }
					: {}),
			})),
		});

		// The envelope the seed shadow copies are CLONED from. Every recipient on
		// this page produces a byte-identical envelope apart from the per-contact
		// fields the clone strips anyway, so any one of them is a faithful base —
		// but it is pinned to the FIRST recipient so the probe's base cannot
		// silently depend on iteration order.
		let probeBaseEnvelope: CampaignEnvelopeInput | undefined;
		for (const recipient of args.emails) {
			// Narrow at the WRITE boundary, not only where dispatch reads it: a
			// degenerate stored score (NaN / out-of-range, i.e. an upstream
			// scorer defect) must never reach the DURABLE envelope. It would be
			// persisted into `routingReentry.envelopeInput`, round-trip through
			// the MTA's JSON (NaN → null), and be rejected by
			// `envelopeInputValidator` on re-entry — dropping the deferred send.
			const engagementScore = normalizeEngagementScore(recipient.engagementScore);
			const envelopeInput: CampaignEnvelopeInput = {
				kind: 'campaign' as const,
				deliveryDomain: 'production' as const,
				to: recipient.email,
				from: args.from,
				replyTo: args.replyTo,
				providerType: args.providerType,
				ipPool: args.ipPool,
				template: {
					subject: args.subject,
					htmlContent: args.htmlContent,
					plainTextContent: args.plainTextContent,
				},
				contactInfo: {
					contactId: recipient.contactId,
					email: recipient.email,
					firstName: recipient.firstName,
					lastName: recipient.lastName,
				},
				audienceType: args.audienceType,
				emailSendId: recipient.emailSendId,
				campaignId: args.campaignId,
				organizationId: args.organizationId,
				siteUrl: args.siteUrl,
				convexSiteUrl: args.convexSiteUrl,
				trackingBaseUrl: args.trackingBaseUrl,
				viewInBrowserUrl: args.viewInBrowserUrl,
				listId: args.listId,
				...(engagementScore !== undefined ? { engagementScore } : {}),
			};
			probeBaseEnvelope ??= envelopeInput;
			await campaignEmailPool.enqueueAction(
				ctx,
				internal.delivery.worker.sendSingleEmail,
				{ envelopeInput },
				{
					onComplete: internal.delivery.sendCompletion.completeSend,
					context: {
						sendRef: {
							kind: 'campaign' as const,
							id: recipient.emailSendId,
						},
					},
				}
			);
		}

		// Deliverability seed probe (gate 5): CLONE the real envelope this page
		// just enqueued into every operator-owned seed mailbox, in this same
		// transaction — the probe has to be written where the send is decided, not
		// from a scheduled call that could observe a different world. Idempotent
		// per (org, campaign, variant), so the walker's page fan-out produces
		// exactly one probe set per arm. With no seed mailboxes connected — the
		// default — it is a no-op (D2).
		//
		// The measurement may never take the send down with it. Running inline is
		// the right shape, but it puts up to one workpool enqueue per seed into
		// this page's transaction, and a throw from any of them (workpool
		// capacity, an OCC conflict on the pool component) would otherwise roll
		// back every recipient on the page. A probe-side failure degrades the
		// measurement — this page simply goes unprobed, and the next campaign
		// probes again — and nothing else.
		if (probeBaseEnvelope && args.organizationId) {
			try {
				await enqueueSeedShadowCopies(ctx, {
					organizationId: args.organizationId,
					campaignId: args.campaignId,
					...(args.abVariant !== undefined ? { abVariant: args.abVariant } : {}),
					base: probeBaseEnvelope,
					now: Date.now(),
				});
			} catch (error) {
				logError('seed shadow copy enqueue failed', error, {
					campaignId: args.campaignId,
					organizationId: args.organizationId,
				});
			}
		}

		return { enqueued: args.emails.length };
	},
});
