import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { paginationOptsValidator } from 'convex/server';
import { internal } from '../_generated/api';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { listResources } from '../lib/listing';
import { campaignListing } from './listing';
import { buildSearchableText } from '../lib/queryHelpers';
import { validateStringLength, STRING_LIMITS, sanitizeEmailHeaderValue } from '../lib/inputGuards';
import { trackEvent } from '../lib/posthogHelpers';
import { recordAuditLog } from '../lib/auditLog';
import { getOrThrow, throwInvalidState, throwForbidden } from '../_utils/errors';
import { campaignStatusValidator } from '../lib/convexValidators';
import { audienceValidator } from './audience';
import { validateReadyToSend } from './preflight';
import {
	seedDefaultSenderIfNeeded,
	isCampaignSenderAllowed,
	senderNotAllowedMessage,
} from './senders';
import { assertTransitioned } from './lifecycle';
import { requireDraftCampaign } from './guards';

// Query to get a single campaign by ID
export const get = authedQuery({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args) => {
		const campaign = await ctx.db.get(args.campaignId);
		if (!campaign) {
			return null;
		}
		return campaign;
	},
});

// Query to get campaign with related data (template, topic, segment)
export const getWithRelations = authedQuery({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args) => {
		const campaign = await ctx.db.get(args.campaignId);
		if (!campaign) return null;

		// Derive the targeted topic/segment id from the discriminated audience.
		const topicId = campaign.audience?.kind === 'topic' ? campaign.audience.topicId : undefined;
		const segmentId =
			campaign.audience?.kind === 'segment' ? campaign.audience.segmentId : undefined;

		// Get related entities in parallel
		const [emailTemplate, topic, segment] = await Promise.all([
			campaign.emailTemplateId ? ctx.db.get(campaign.emailTemplateId) : null,
			topicId ? ctx.db.get(topicId) : null,
			segmentId ? ctx.db.get(segmentId) : null,
		]);

		return {
			...campaign,
			emailTemplate,
			topic,
			segment,
		};
	},
});

// Mutation to update campaign basics (step 1 of wizard)
export const updateBasics = authedMutation({
	args: {
		campaignId: v.id('campaigns'),
		name: v.optional(v.string()),
		fromName: v.optional(v.string()),
		fromEmail: v.optional(v.string()),
		replyTo: v.optional(v.string()),
		archiveEnabled: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		// Validate input lengths
		if (args.name) validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');

		// authz: requireDraftCampaign enforces campaigns:manage
		const { campaign } = await requireDraftCampaign(ctx, args.campaignId, 'edit campaigns');

		const updates: {
			name?: string;
			fromName?: string;
			fromEmail?: string;
			replyTo?: string;
			archiveEnabled?: boolean;
			searchableText?: string;
			updatedAt: number;
		} = { updatedAt: Date.now() };

		if (args.name !== undefined) {
			updates.name = args.name.trim();
		}

		if (args.fromName !== undefined) {
			updates.fromName = sanitizeEmailHeaderValue(args.fromName);
		}

		if (args.fromEmail !== undefined) {
			const fromEmail = args.fromEmail.trim();
			updates.fromEmail = fromEmail;
			if (fromEmail) {
				// Self-heal an upgraded deployment (empty curated list) so the org's own
				// default address stays usable, then enforce the curated-sender gate so
				// there is no way to persist an off-list address from the API — the
				// wizard offers only on-list senders (or a custom one when the toggle is
				// on). The verified-domain floor is enforced separately at send time
				// (preflight / testSend), keeping its dedicated "domain not verified" copy.
				await seedDefaultSenderIfNeeded(ctx);
				if (!(await isCampaignSenderAllowed(ctx, fromEmail))) {
					throwForbidden(senderNotAllowedMessage(fromEmail));
				}
			}
		}

		if (args.replyTo !== undefined) {
			updates.replyTo = sanitizeEmailHeaderValue(args.replyTo);
		}

		if (args.archiveEnabled !== undefined) {
			updates.archiveEnabled = args.archiveEnabled;
		}

		// Update searchableText if name changed
		if (args.name !== undefined) {
			const newName = updates.name ?? campaign.name;
			const newSubject = campaign.subject ?? '';
			updates.searchableText = buildSearchableText(newName, newSubject);
		}

		await ctx.db.patch(args.campaignId, updates);
		return args.campaignId;
	},
});

// Mutation to update campaign audience (step 2 of wizard). Speaks the
// snapshot-free `Audience` (ADR-0033); the `frozenFilters` send-time snapshot
// is written by the orchestrator/preflight, not here.
export const updateAudience = authedMutation({
	args: {
		campaignId: v.id('campaigns'),
		audience: audienceValidator,
	},
	handler: async (ctx, args) => {
		// authz: requireDraftCampaign enforces campaigns:manage
		await requireDraftCampaign(ctx, args.campaignId, 'edit campaign audience');

		// Validate the referenced segment exists (parity with the pre-ADR-0033
		// behaviour, which loaded the segment to snapshot its filters).
		if (args.audience.kind === 'segment') {
			await getOrThrow(ctx, args.audience.segmentId, 'Segment');
		}

		await ctx.db.patch(args.campaignId, {
			audience: args.audience,
			updatedAt: Date.now(),
		});

		return args.campaignId;
	},
});

// Mutation to update campaign content (step 3 of wizard)
export const updateContent = authedMutation({
	args: {
		campaignId: v.id('campaigns'),
		emailTemplateId: v.id('emailTemplates'),
		subject: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		// Validate input lengths
		if (args.subject) validateStringLength(args.subject, STRING_LIMITS.SUBJECT, 'Subject');

		// authz: requireDraftCampaign enforces campaigns:manage
		const { campaign } = await requireDraftCampaign(ctx, args.campaignId, 'edit campaign content');

		// Verify template exists
		await getOrThrow(ctx, args.emailTemplateId, 'Email template');

		// Update searchableText if subject changed
		const newSubject = args.subject?.trim() ?? campaign.subject ?? '';
		const searchableText = buildSearchableText(campaign.name, newSubject);

		await ctx.db.patch(args.campaignId, {
			emailTemplateId: args.emailTemplateId,
			subject: args.subject?.trim(),
			searchableText,
			updatedAt: Date.now(),
		});

		return args.campaignId;
	},
});

// Mutation to duplicate a campaign
export const duplicate = authedMutation({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'campaigns:manage',
			'You do not have permission to duplicate campaigns'
		);

		const campaign = await getOrThrow(ctx, args.campaignId, 'Campaign');

		const now = Date.now();
		const newName = `Copy of ${campaign.name}`;

		// Build searchable text for full-text search
		const searchableText = buildSearchableText(newName, campaign.subject);

		return await ctx.db.insert('campaigns', {
			name: newName,
			emailTemplateId: campaign.emailTemplateId,
			status: 'draft', // Duplicates always start as drafts
			fromName: campaign.fromName,
			fromEmail: campaign.fromEmail,
			replyTo: campaign.replyTo,
			subject: campaign.subject,
			audience: campaign.audience,
			searchableText,
			createdAt: now,
			updatedAt: now,
		});
	},
});

// Mutation to delete a campaign
export const remove = authedMutation({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'campaigns:manage',
			'You do not have permission to delete campaigns'
		);

		const campaign = await getOrThrow(ctx, args.campaignId, 'Campaign');

		// Cannot delete campaigns that are sending
		if (campaign.status === 'sending') {
			throwInvalidState('Cannot delete a campaign that is currently sending');
		}

		await ctx.db.delete(args.campaignId);

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'campaign.deleted',
			resource: 'campaign',
			resourceId: args.campaignId,
			details: { name: campaign.name },
		});
	},
});

// ==========================================
// SESSION-BASED QUERIES AND MUTATIONS (US-405)
// These derive auth from the BetterAuth session.
// ==========================================

/**
 * List campaigns with cursor-based pagination.
 */
export const list = authedQuery({
	args: {
		status: v.optional(campaignStatusValidator),
		search: v.optional(v.string()),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'campaigns');
		return listResources(ctx.db, campaignListing, {
			search: args.search,
			filters: { status: args.status },
			paginationOpts: args.paginationOpts,
		});
	},
});

/**
 * Create a new campaign.
 */
export const create = authedMutation({
	args: {
		name: v.string(),
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'campaigns');
		// Validate input lengths
		validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');

		// Get full mutation context (userId, role)
		const session = await requireOrgPermission(
			ctx,
			'campaigns:manage',
			'You do not have permission to create campaigns'
		);

		const now = Date.now();
		const name = args.name.trim();

		// Build searchable text for full-text search
		const searchableText = buildSearchableText(name);

		const campaignId = await ctx.db.insert('campaigns', {
			name,
			status: 'draft',
			searchableText,
			createdAt: now,
			updatedAt: now,
		});

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'campaign.created',
			resource: 'campaign',
			resourceId: campaignId,
			details: { name },
		});

		await trackEvent(ctx, session, 'campaign_created', { campaignId });

		return campaignId;
	},
});

/**
 * Send a campaign immediately. Auth + pre-flight shell; the **Campaign
 * lifecycle (module)** owns the status patch, scheduler hop, PostHog
 * event, and AB-test kickoff effects.
 */
export const sendNow = authedMutation({
	args: {
		campaignId: v.id('campaigns'),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'campaigns:send',
			'You do not have permission to send campaigns'
		);

		const campaign = await getOrThrow(ctx, args.campaignId, 'Campaign');

		if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
			throwInvalidState('Only draft or scheduled campaigns can be sent');
		}

		// Bootstrap the curated list from the org default before pre-flight so an
		// upgraded deployment (empty list, toggle off) can still send from its own
		// default address instead of failing `sender_not_allowed`.
		await seedDefaultSenderIfNeeded(ctx);

		const preflight = await validateReadyToSend(ctx, campaign);
		if (!preflight.ok) {
			throwInvalidState(preflight.message);
		}

		const outcome = await ctx.runMutation(internal.campaigns.lifecycle.transition, {
			campaignId: args.campaignId,
			input: { to: 'sending', at: Date.now() },
			userId: session.userId,
		});

		assertTransitioned(outcome, 'send');

		return args.campaignId;
	},
});
