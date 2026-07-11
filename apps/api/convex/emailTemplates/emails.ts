import { v } from 'convex/values';
import { emailTemplateTypeValidator } from '../lib/convexValidators';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { paginationOptsValidator } from 'convex/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { buildSearchableText } from '../lib/queryHelpers';
import { listResources } from '../lib/listing';
import { emailTemplateListing } from './listing';
import { getOrThrow, throwNotFound, throwInvalidState } from '../_utils/errors';
import { recordAuditLog } from '../lib/auditLog';
import { assertEditableForPublishableChange } from './lifecycle';
import { applyUsageCountDelta } from '../emailBlocks/module';

// Query to get a single email template by ID
export const get = authedQuery({
	args: { templateId: v.id('emailTemplates') },
	handler: async (ctx, args) => {
		const template = await ctx.db.get(args.templateId);
		return template;
	},
});

// Mutation to update an email template
export const update = authedMutation({
	args: {
		templateId: v.id('emailTemplates'),
		name: v.optional(v.string()),
		subject: v.optional(v.string()),
		previewText: v.optional(v.string()),
		content: v.optional(v.string()),
		htmlContent: v.optional(v.string()),
		// Multi-language support fields
		defaultLanguage: v.optional(v.string()),
		supportedLanguages: v.optional(v.array(v.string())),
		translations: v.optional(v.string()),
		// Pre-rendered HTML for translations
		htmlTranslations: v.optional(v.string()),
		// IDs of saved blocks linked in this template
		linkedBlockIds: v.optional(v.array(v.string())),
		// Allow editing publishable content on a `published` row; default `false`.
		forceWhilePublished: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can update email templates'
		);

		const template = await getOrThrow(ctx, args.templateId, 'Email template');

		assertEditableForPublishableChange(template, args.forceWhilePublished);

		const updates: {
			name?: string;
			subject?: string;
			previewText?: string;
			content?: string;
			htmlContent?: string;
			defaultLanguage?: string;
			supportedLanguages?: string[];
			translations?: string;
			htmlTranslations?: string;
			linkedBlockIds?: string[];
			searchableText?: string;
			updatedAt: number;
		} = { updatedAt: Date.now() };

		if (args.name !== undefined) {
			updates.name = args.name.trim();
		}

		if (args.subject !== undefined) {
			updates.subject = args.subject.trim();
		}

		if (args.previewText !== undefined) {
			updates.previewText = args.previewText.trim();
		}

		if (args.content !== undefined) {
			updates.content = args.content;
		}

		if (args.htmlContent !== undefined) {
			updates.htmlContent = args.htmlContent;
		}

		if (args.defaultLanguage !== undefined) {
			updates.defaultLanguage = args.defaultLanguage;
		}

		if (args.supportedLanguages !== undefined) {
			updates.supportedLanguages = args.supportedLanguages;
		}

		if (args.translations !== undefined) {
			updates.translations = args.translations;
		}

		if (args.htmlTranslations !== undefined) {
			updates.htmlTranslations = args.htmlTranslations;
		}

		if (args.linkedBlockIds !== undefined) {
			updates.linkedBlockIds = args.linkedBlockIds;
			// A normal editor save patches the row directly (it does NOT route
			// through the lifecycle's create/duplicate effect), so keep saved-block
			// usageCount in sync here by diffing the previous vs. new linked set.
			await applyUsageCountDelta(ctx, template.linkedBlockIds ?? [], args.linkedBlockIds);
		}

		// Update searchableText if name or subject changed
		if (args.name !== undefined || args.subject !== undefined) {
			const newName = updates.name ?? template.name;
			const newSubject = updates.subject ?? template.subject;
			updates.searchableText = buildSearchableText(newName, newSubject);
		}

		await ctx.db.patch(args.templateId, updates);

		// Audit the content/metadata edit — the documented email_template.updated
		// action was never emitted from this handler.
		const changedFields = Object.keys(updates).filter((k) => k !== 'updatedAt');
		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'email_template.updated',
			resource: 'email_template',
			resourceId: args.templateId,
			details: { changedFields: changedFields.join(', ') },
		});

		return args.templateId;
	},
});

// Mutation to publish an email template
export const publish = authedMutation({
	args: {
		templateId: v.id('emailTemplates'),
		htmlContent: v.string(),
		// Pre-rendered HTML for each translation language
		// Structure: { "de": { "htmlContent": "...", "subject": "..." }, ... }
		htmlTranslations: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can publish email templates'
		);

		const outcome = await ctx.runMutation(internal.emailTemplates.lifecycle.transition, {
			templateId: args.templateId,
			input: {
				to: 'published',
				at: Date.now(),
				htmlContent: args.htmlContent,
				htmlTranslations: args.htmlTranslations,
			},
			userId: session.userId,
		});

		if (!outcome.ok) {
			if (outcome.reason === 'template_not_found') {
				throwNotFound('Email template');
			}
			throwInvalidState(`Cannot publish template: ${outcome.reason}`);
		}

		return args.templateId;
	},
});

// Mutation to unpublish an email template (revert to draft)
export const unpublish = authedMutation({
	args: { templateId: v.id('emailTemplates') },
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can unpublish email templates'
		);

		const outcome = await ctx.runMutation(internal.emailTemplates.lifecycle.transition, {
			templateId: args.templateId,
			input: { to: 'draft', at: Date.now() },
			userId: session.userId,
		});

		if (!outcome.ok) {
			if (outcome.reason === 'template_not_found') {
				throwNotFound('Email template');
			}
			throwInvalidState(`Cannot unpublish template: ${outcome.reason}`);
		}

		return args.templateId;
	},
});

// Mutation to duplicate an email template
export const duplicate = authedMutation({
	args: { templateId: v.id('emailTemplates') },
	handler: async (ctx, args): Promise<Id<'emailTemplates'>> => {
		const session = await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can duplicate email templates'
		);

		const outcome = await ctx.runMutation(internal.emailTemplates.lifecycle.duplicate, {
			templateId: args.templateId,
			userId: session.userId,
		});

		if (!outcome.ok) {
			throwNotFound('Email template');
		}

		return outcome.templateId;
	},
});

// Mutation to delete an email template
export const remove = authedMutation({
	args: { templateId: v.id('emailTemplates') },
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can delete email templates'
		);

		const outcome = await ctx.runMutation(internal.emailTemplates.lifecycle.remove, {
			templateId: args.templateId,
			userId: session.userId,
		});

		if (!outcome.ok) {
			throwNotFound('Email template');
		}
	},
});

// Mutation to change template type
export const changeType = authedMutation({
	args: {
		templateId: v.id('emailTemplates'),
		type: emailTemplateTypeValidator,
		forceWhilePublished: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can change template type'
		);

		const template = await getOrThrow(ctx, args.templateId, 'Email template');

		assertEditableForPublishableChange(template, args.forceWhilePublished);

		await ctx.db.patch(args.templateId, {
			type: args.type,
			updatedAt: Date.now(),
		});

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'email_template.updated',
			resource: 'email_template',
			resourceId: args.templateId,
			details: { changedFields: 'type', type: args.type },
		});

		return args.templateId;
	},
});

// ==========================================
// SESSION-BASED QUERIES AND MUTATIONS (US-405)
// These derive auth from the BetterAuth session.
// ==========================================

/**
 * List email templates.
 */
// List email templates (paginated, uniform { page, … } contract). Search is
// relevance-ordered; otherwise updatedAt-descending with index-native type
// filtering. The old shell `.collect()`-ed the whole table per call. ADR-0037.
export const list = authedQuery({
	args: {
		type: v.optional(emailTemplateTypeValidator),
		status: v.optional(v.union(v.literal('draft'), v.literal('published'))),
		search: v.optional(v.string()),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) =>
		listResources(ctx.db, emailTemplateListing, {
			search: args.search,
			filters: { type: args.type, status: args.status },
			paginationOpts: args.paginationOpts,
		}),
});

/**
 * Create a new email template.
 */
export const create = authedMutation({
	args: {
		name: v.string(),
		type: emailTemplateTypeValidator,
		subject: v.optional(v.string()),
		previewText: v.optional(v.string()),
		content: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Id<'emailTemplates'>> => {
		const session = await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can create email templates'
		);

		const outcome = await ctx.runMutation(internal.emailTemplates.lifecycle.create, {
			name: args.name,
			type: args.type,
			subject: args.subject,
			previewText: args.previewText,
			content: args.content,
			userId: session.userId,
		});

		return outcome.templateId;
	},
});
