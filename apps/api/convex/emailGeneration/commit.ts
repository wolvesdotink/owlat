/**
 * The one write of an AI email draft (CONVENTIONS.md "Actions commit once").
 *
 * Re-checks the gate the context read applied (the flags or the member's role
 * may have changed while the model ran), lays the brand kit over the blocks,
 * and creates the draft through each table's own insert helper, so the
 * sanitiser, the audit log, the listing counters and the slug rules apply as
 * for any other new email. A campaign's template, the campaign and the link
 * between them land in this same transaction or not at all.
 *
 * Everything it creates is a draft: no status change, no audience, no
 * schedule, no send. Publishing and sending stay the author's, through the
 * paths that scan content.
 */

import { v } from 'convex/values';
import { generateId, type EditorBlock } from '@owlat/shared';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { getStoredFlags, resolveStoredFeatureFlags } from '../lib/featureFlags';
import { requireOrgMember } from '../lib/sessionOrganization';
import { throwAlreadyExists, throwInvalidInput } from '../_utils/errors';
import { dataVariablesSchemaValidator } from '../lib/convexValidators';
import { loadBrandKit } from '../workspaces/brandKit';
import { insertEmailTemplate } from '../emailTemplates/lifecycle';
import { insertTransactionalEmail, isSlugFree } from '../transactional/lifecycle';
import { insertDraftCampaign } from '../campaigns/campaigns';
import { parseContentBlocks } from '../emailBlocks/consumers';
import { generationKindValidator, generationRefusal, throwGenerationRefusal } from './_helpers';
import { brandDraftBlocks } from './blocksDecision';

export type GenerationResult =
	| { kind: 'template'; templateId: Id<'emailTemplates'> }
	| { kind: 'transactional'; transactionalEmailId: Id<'transactionalEmails'>; slug: string }
	| { kind: 'campaign'; campaignId: Id<'campaigns'>; templateId: Id<'emailTemplates'> };

/** How many numbered suffixes a suggested slug may try before giving up. */
const SLUG_ATTEMPTS = 20;

/**
 * The slug to store. One the author typed is used as it is (a taken slug is
 * their error to fix); one the model suggested gets `-2`, `-3`, … when taken.
 */
async function freeSlug(ctx: MutationCtx, slug: string, isSuggested: boolean): Promise<string> {
	if (!isSuggested) return slug;
	for (let n = 1; n <= SLUG_ATTEMPTS; n++) {
		const candidate = n === 1 ? slug : `${slug}-${n}`;
		if (await isSlugFree(ctx, candidate)) return candidate;
	}
	throwAlreadyExists(`A transactional email with slug "${slug}" already exists`);
}

export const commit = internalMutation({
	args: {
		kind: generationKindValidator,
		name: v.string(),
		subject: v.string(),
		previewText: v.string(),
		language: v.string(),
		/** The mapped `EditorBlock[]` as JSON, before the brand kit. */
		content: v.string(),
		slug: v.optional(v.string()),
		isSlugSuggested: v.optional(v.boolean()),
		dataVariablesSchema: v.optional(dataVariablesSchemaValidator),
		optionalDataVariables: v.optional(v.array(v.string())),
	},
	handler: async (ctx, args): Promise<GenerationResult> => {
		const session = await requireOrgMember(ctx);
		const flags = resolveStoredFeatureFlags(await getStoredFlags(ctx));
		const refusal = generationRefusal(args.kind, flags, session.role);
		if (refusal) throwGenerationRefusal(refusal);

		const kit = await loadBrandKit(ctx);
		const newId = () => generateId('block');
		const blocks = brandDraftBlocks(
			parseContentBlocks(args.content) as EditorBlock[],
			kit,
			args.kind,
			newId
		);
		const content = JSON.stringify(blocks);

		if (args.kind === 'transactional') {
			if (!args.slug) throwInvalidInput('A transactional email needs a slug');
			const slug = await freeSlug(ctx, args.slug, args.isSlugSuggested ?? false);
			const outcome = await insertTransactionalEmail(ctx, {
				name: args.name,
				slug,
				subject: args.subject,
				content,
				dataVariablesSchema: args.dataVariablesSchema,
				optionalDataVariables: args.optionalDataVariables,
				defaultLanguage: args.language,
				userId: session.userId,
				render: true,
				generatedBy: 'ai',
			});
			if (!outcome.ok) {
				if (outcome.reason === 'invalid_slug_format') {
					throwInvalidInput(
						"Slug must be lowercase alphanumeric with hyphens (e.g., 'welcome-email', 'order-confirmation')"
					);
				}
				throwAlreadyExists(`A transactional email with slug "${slug}" already exists`);
			}
			return { kind: 'transactional', transactionalEmailId: outcome.emailId, slug };
		}

		const templateId = await insertEmailTemplate(ctx, {
			name: args.name,
			type: 'marketing',
			subject: args.subject,
			previewText: args.previewText,
			content,
			defaultLanguage: args.language,
			userId: session.userId,
			render: true,
			generatedBy: 'ai',
		});
		if (args.kind === 'template') return { kind: 'template', templateId };

		const campaignId = await insertDraftCampaign(ctx, session, {
			name: args.name,
			subject: args.subject,
			emailTemplateId: templateId,
			generatedBy: 'ai',
		});
		return { kind: 'campaign', campaignId, templateId };
	},
});
