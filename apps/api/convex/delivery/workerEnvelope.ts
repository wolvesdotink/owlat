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
	})
);

export type WorkerEnvelopeInput = Infer<typeof envelopeInputValidator>;

export const retryStateValidator = v.object({
	attempt: v.number(),
	startedAt: v.number(),
	idempotencyKey: v.string(),
});

export type WorkerRetryState = Infer<typeof retryStateValidator>;
