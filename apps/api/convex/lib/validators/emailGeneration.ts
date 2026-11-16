import { v } from 'convex/values';

/** What one AI draft run created: the ids the dialog opens, per kind. */
export const generationResultValidator = v.union(
	v.object({ kind: v.literal('template'), templateId: v.id('emailTemplates') }),
	v.object({
		kind: v.literal('transactional'),
		transactionalEmailId: v.id('transactionalEmails'),
		slug: v.string(),
	}),
	v.object({
		kind: v.literal('campaign'),
		campaignId: v.id('campaigns'),
		templateId: v.id('emailTemplates'),
	})
);
