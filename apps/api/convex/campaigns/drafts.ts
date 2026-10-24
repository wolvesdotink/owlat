import { v } from 'convex/values';
import { campaignsMutation } from './_helpers';
import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import type { AbTestTransitionInput } from './abTestLifecycle';
import { buildSearchableText } from '../lib/queryHelpers';
import { throwInvalidState } from '../_utils/errors';
import { audienceValidator } from './audience';
import { requireDraftCampaign } from './guards';
import {
	assertAudienceTarget,
	buildAbTestConfig,
	campaignBasicsPatch,
	campaignContentFields,
	sameAbTestConfig,
} from './draftFields';

/**
 * Campaign drafts: the campaign editor's autosave.
 *
 * One mutation writes everything the editor holds, so a background save lands
 * whole or not at all (the per-section mutations it replaces ran one after
 * another, and a failure halfway left a mix). It takes a draft as it is while
 * being written: a section that is not chosen yet (no audience, no email) is
 * left as stored instead of refusing the save. Every value it does write is
 * held to the same rules as the per-section mutations (`draftFields.ts`).
 * Sending readiness is not checked here; Schedule and Send check it.
 */

const abTestDraftValidator = v.union(
	v.object({ enabled: v.literal(false) }),
	v.object({
		enabled: v.literal(true),
		testType: v.union(v.literal('subject'), v.literal('content')),
		variantBSubject: v.optional(v.string()),
		variantBTemplateId: v.optional(v.id('emailTemplates')),
		splitPercentage: v.number(),
		winnerCriteria: v.union(v.literal('open_rate'), v.literal('click_rate'), v.literal('manual')),
		testDuration: v.optional(v.number()),
	})
);

export const saveDraft = campaignsMutation({
	args: {
		campaignId: v.id('campaigns'),
		name: v.optional(v.string()),
		fromName: v.optional(v.string()),
		fromEmail: v.optional(v.string()),
		replyTo: v.optional(v.string()),
		archiveEnabled: v.optional(v.boolean()),
		// Left as stored when absent: the editor has no audience chosen yet.
		audience: v.optional(audienceValidator),
		// Left as stored when absent: no email linked yet.
		content: v.optional(
			v.object({ emailTemplateId: v.id('emailTemplates'), subject: v.optional(v.string()) })
		),
		// Left as stored when absent: an A/B test switched on but not filled in.
		abTest: v.optional(abTestDraftValidator),
	},
	handler: async (ctx, args) => {
		// authz: requireDraftCampaign enforces campaigns:manage
		const { session, campaign } = await requireDraftCampaign(
			ctx,
			args.campaignId,
			'edit campaigns'
		);

		const basics = await campaignBasicsPatch(ctx, args);
		if (args.audience) await assertAudienceTarget(ctx, args.audience);
		const content = args.content ? await campaignContentFields(ctx, args.content) : null;

		const name = basics.name ?? campaign.name;
		const subject = content ? content.subject : campaign.subject;
		await ctx.db.patch(args.campaignId, {
			...basics,
			...(args.audience && { audience: args.audience }),
			...(content && { emailTemplateId: content.emailTemplateId, subject: content.subject }),
			searchableText: buildSearchableText(name, subject ?? ''),
			updatedAt: Date.now(),
		});

		if (args.abTest) await saveAbTestDraft(ctx, campaign, args.abTest, session.userId);
		// The editor's device copy names the `updatedAt` its draft is built on.
		// It may move that on to this save's only when nobody else wrote since
		// (`previousUpdatedAt`): their write is not in the draft.
		const saved = await ctx.db.get(args.campaignId);
		return {
			campaignId: args.campaignId,
			updatedAt: saved?.updatedAt ?? campaign.updatedAt,
			previousUpdatedAt: campaign.updatedAt,
		};
	},
});

type AbTestDraft = typeof abTestDraftValidator.type;

/**
 * Bring the A/B test in line with the draft through the A/B lifecycle, its
 * single writer. Nothing happens when it already matches, so an autosave
 * leaves no audit entry for a test it did not change. A changed setup is a
 * reset followed by a fresh enable: the lifecycle has no edge that rewrites
 * the config of an enabled test.
 */
async function saveAbTestDraft(
	ctx: MutationCtx,
	campaign: Doc<'campaigns'>,
	draft: AbTestDraft,
	userId: string
): Promise<void> {
	const enabled = campaign.abTestStatus !== undefined;
	const transition = async (input: AbTestTransitionInput) => {
		const outcome = await ctx.runMutation(internal.campaigns.abTestLifecycle.transition, {
			campaignId: campaign._id,
			input,
			userId,
		});
		if (!outcome.ok) throwInvalidState(`Cannot update the A/B test: ${outcome.reason}`);
	};

	if (!draft.enabled) {
		if (enabled) await transition({ to: 'none', at: Date.now() });
		return;
	}
	const { enabled: _enabled, ...setup } = draft;
	const config = await buildAbTestConfig(ctx, setup);
	if (enabled && sameAbTestConfig(campaign.abTestConfig, config)) return;
	if (enabled) await transition({ to: 'none', at: Date.now() });
	await transition({ to: 'pending', at: Date.now(), config });
}
