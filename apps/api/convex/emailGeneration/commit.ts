/**
 * The one write of an AI email draft (CONVENTIONS.md "Actions commit once").
 *
 * Answers a submission that already committed from its receipt
 * (`receipts.ts`) and creates nothing. Otherwise re-checks what the context
 * read checked, because the world moved while the model ran: the gate (the
 * flags and the member's role) and every picked reference (`resolveReference`;
 * one that is gone or switched off fails the whole commit with
 * `EMAIL_GENERATION_REFERENCE_MISSING`). Then it lays the brand kit over the blocks,
 * and creates the draft through each table's own insert helper, so the
 * sanitiser, the audit log, the listing counters and the slug rules apply as
 * for any other new email. A campaign's template, the campaign and the link
 * between them land in this same transaction or not at all, and so does the
 * receipt that answers a repeat of the submission.
 *
 * Everything it creates is a draft: no status change, no audience, no
 * schedule, no send. Publishing and sending stay the author's, through the
 * paths that scan content.
 */

import { v, type Infer, type ObjectType } from 'convex/values';
import { generateId, type EditorBlock } from '@owlat/shared';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { getStoredFlags, resolveStoredFeatureFlags } from '../lib/featureFlags';
import { requireOrgMember, type MutationSessionContext } from '../lib/sessionOrganization';
import { throwAlreadyExists, throwInvalidInput } from '../_utils/errors';
import { dataVariablesSchemaValidator } from '../lib/convexValidators';
import { loadBrandKit } from '../workspaces/brandKit';
import { insertEmailTemplate } from '../emailTemplates/lifecycle';
import { insertTransactionalEmail, isSlugFree } from '../transactional/lifecycle';
import { insertDraftCampaign } from '../campaigns/campaigns';
import { parseContentBlocks } from '../emailBlocks/consumers';
import type { generationResultValidator } from '../lib/validators/emailGeneration';
import {
	generationKindValidator,
	generationRefusal,
	referenceValidator,
	throwGenerationRefusal,
} from './_helpers';
import { brandDraftBlocks } from './blocksDecision';
import { resolveReference } from './context';
import { GENERATION_LIMITS } from './outputSchema';
import { recordedOutcome, recordOutcome, type ReceiptScope } from './receipts';

export type GenerationResult = Infer<typeof generationResultValidator>;

/** `generate`'s answer: what was created, and what the mapper left out. */
export type GenerationOutcome = GenerationResult & { droppedVariables: string[] };

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

const commitArgs = {
	kind: generationKindValidator,
	/** The submission's id; a second commit under it returns the first one's outcome. */
	requestId: v.string(),
	/** The references the context read resolved, checked again here. */
	references: v.array(referenceValidator),
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
	droppedVariables: v.array(v.string()),
};

export const commit = internalMutation({
	args: commitArgs,
	handler: async (ctx, args): Promise<GenerationOutcome> => {
		const session = await requireOrgMember(ctx);
		const scope: ReceiptScope = {
			organizationId: session.activeOrganizationId,
			userId: session.userId,
		};
		const recorded = await recordedOutcome(ctx, scope, args.requestId);
		if (recorded) return recorded;

		const flags = resolveStoredFeatureFlags(await getStoredFlags(ctx));
		const refusal = generationRefusal(args.kind, flags, session.role);
		if (refusal) throwGenerationRefusal(refusal);
		for (const reference of args.references.slice(0, GENERATION_LIMITS.references)) {
			await resolveReference(ctx, reference, flags);
		}

		const result = await createDraft(ctx, session, args);
		const outcome: GenerationOutcome = { ...result, droppedVariables: args.droppedVariables };
		await recordOutcome(ctx, scope, args.requestId, outcome);
		return outcome;
	},
});

type CommitArgs = ObjectType<typeof commitArgs>;

/** The draft itself, through each table's own insert helper. */
async function createDraft(
	ctx: MutationCtx,
	session: MutationSessionContext,
	args: CommitArgs
): Promise<GenerationResult> {
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
}
