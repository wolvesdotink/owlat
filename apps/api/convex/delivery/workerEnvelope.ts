import { type Infer, v } from 'convex/values';
import { jsonPrimitiveValue } from '../lib/convexValidators';

const attachmentRefValidator = v.object({
	filename: v.string(),
	contentType: v.optional(v.string()),
	url: v.string(),
});

/** Strict durable work payload. This is also the re-entry snapshot boundary. */
export const envelopeInputValidator = v.union(
	v.object({
		kind: v.literal('campaign'),
		deliveryDomain: v.optional(v.literal('production')),
		to: v.string(),
		from: v.string(),
		replyTo: v.optional(v.string()),
		providerType: v.optional(v.string()),
		ipPool: v.optional(v.string()),
		template: v.object({ subject: v.string(), htmlContent: v.string() }),
		contactInfo: v.object({
			contactId: v.optional(v.id('contacts')),
			email: v.string(),
			firstName: v.optional(v.string()),
			lastName: v.optional(v.string()),
		}),
		audienceType: v.optional(v.union(v.literal('topic'), v.literal('segment'))),
		emailSendId: v.optional(v.id('emailSends')),
		campaignId: v.optional(v.id('campaigns')),
		organizationId: v.optional(v.string()),
		siteUrl: v.optional(v.string()),
		convexSiteUrl: v.optional(v.string()),
		trackingBaseUrl: v.optional(v.string()),
		viewInBrowserUrl: v.optional(v.string()),
		listId: v.optional(v.string()),
		engagementScore: v.optional(v.number()),
		// Deliverability SEED PROBE marker. Set ONLY on a shadow copy addressed
		// to an operator-owned seed mailbox (see `delivery/seedShadowCopy.ts`);
		// the campaign composer stamps it as `X-Owlat-Seed-Probe` so the IMAP
		// poller can find the message again. An opaque id — never a recipient
		// address, contact id, or campaign name — and never present on an
		// envelope bound for a real recipient.
		seedProbeId: v.optional(v.string()),
		// The probe's durable ledger row. Present exactly when `seedProbeId` is:
		// it is the shadow copy's dispatch reference (the governed boundary needs
		// a durable, org-scoped id for its idempotency key and re-entry token),
		// and it is deliberately NOT an `emailSends` row — no Send lifecycle, no
		// completion handler, no stat shard, no reputation event.
		seedProbeRef: v.optional(v.id('seedPlacementProbes')),
	}),
	v.object({
		kind: v.literal('transactional'),
		deliveryDomain: v.optional(v.union(v.literal('production'), v.literal('member_test'))),
		messageType: v.optional(v.union(v.literal('transactional'), v.literal('automation'))),
		emailPurpose: v.union(v.literal('marketing'), v.literal('transactional')),
		to: v.string(),
		from: v.string(),
		replyTo: v.optional(v.string()),
		providerType: v.optional(v.string()),
		ipPool: v.optional(v.string()),
		sendId: v.optional(v.id('transactionalSends')),
		template: v.object({ subject: v.string(), htmlContent: v.string() }),
		dataVariables: v.optional(v.record(v.string(), jsonPrimitiveValue)),
		attachmentRefs: v.optional(v.array(attachmentRefValidator)),
		headers: v.optional(v.record(v.string(), v.string())),
		autoSubmittedType: v.optional(v.union(v.literal('auto-generated'), v.literal('auto-replied'))),
		showUnsubscribe: v.optional(v.boolean()),
		contactId: v.optional(v.id('contacts')),
		siteUrl: v.optional(v.string()),
		organizationId: v.optional(v.string()),
		listUnsubscribe: v.optional(v.boolean()),
		convexSiteUrl: v.optional(v.string()),
		engagementScore: v.optional(v.number()),
	})
);

export type WorkerEnvelopeInput = Infer<typeof envelopeInputValidator>;

/**
 * The recipient's contact engagement score (`contacts.engagementScore`, 0-100,
 * written by `analytics/engagementScore.ts`) rides the envelope so the dispatch
 * boundary can stamp it onto `MtaExtras` without a per-recipient database read
 * on the hot path. The MTA maps it through `mapToPriority` at enqueue time.
 *
 * ABSENCE IS NOT AN ERROR and must never be coerced to a number: `0` means
 * "cold" (deprioritised behind every scored recipient), while an ABSENT score
 * means "unknown" and the MTA applies `PRIORITY_BANDS.DEFAULT`. A transactional
 * send with no contact record, an unscored contact, and a legacy envelope
 * queued before this field existed all resolve to `undefined`.
 *
 * Non-finite and out-of-band values are treated as unknown rather than clamped:
 * a `NaN` or `-1` score is a defect upstream, and inventing a band for it would
 * silently mis-order real mail.
 */
export function normalizeEngagementScore(score: number | undefined): number | undefined {
	if (score === undefined) return undefined;
	if (!Number.isFinite(score)) return undefined;
	if (score < 0 || score > 100) return undefined;
	return score;
}

/**
 * True when this envelope is a seed shadow copy — the SINGLE predicate for
 * "this is a placement probe, not a subscriber's mail". A shadow copy must
 * never be countable, and a countable Send must never carry the probe header;
 * that invariant is asserted on the composition path by
 * `delivery/worker.ts#assertSeedShadowExclusion`, which narrows THROUGH this
 * predicate rather than restating the shape.
 *
 * Lives beside the envelope type (not in `delivery/seedShadowCopy.ts`) so the
 * `'use node'` worker can import it without pulling the probe ledger's Convex
 * function module into the node bundle.
 */
export function isSeedShadowEnvelope(
	envelope: WorkerEnvelopeInput
): envelope is Extract<WorkerEnvelopeInput, { kind: 'campaign' }> & { seedProbeId: string } {
	return envelope.kind === 'campaign' && envelope.seedProbeId !== undefined;
}

export const retryStateValidator = v.object({
	attempt: v.number(),
	startedAt: v.number(),
	idempotencyKey: v.string(),
	workAttemptId: v.optional(v.string()),
	acceptanceReconciliation: v.optional(v.boolean()),
});

export type WorkerRetryState = Infer<typeof retryStateValidator>;
